//! AI working-canvas geometry: capability buckets, padding/cropping, mask math.

use std::fs;
use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::png::{decode_png_rgba, encode_rgba_png, png_dimensions_from_bytes};

pub(crate) const AI_RETOUCH_OUTPUT_MASK_GROW_RADIUS: u32 = 0;

pub(crate) const AI_RETOUCH_OUTPUT_MASK_FEATHER_RADIUS: u32 = 0;

// Must match PAINTNODE_CHROMA_KEY_HEX in src/lib/engine/decouple/chroma.ts.
pub(crate) const AI_CHROMA_KEY_HEX: &str = "#00ff00";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PixelRect {
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SupportedAspectRatio {
    pub(crate) label: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ImageModelCapabilities {
    fallback_aspect_ratios: Vec<SupportedAspectRatio>,
    providers: ImageProviderCapabilities,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct ImageProviderCapabilities {
    codex: CodexImageCapability,
    antigravity: AntigravityImageCapability,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexImageCapability {
    pub(crate) dimension_multiple: u32,
    max_long_side: u32,
    max_short_side: u32,
    pub(crate) max_aspect_ratio: u32,
    /// Largest tile side for AI detail restoration: tiles at or below this
    /// size regenerate at the model's native output density.
    pub(crate) restore_tile_side: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AntigravityImageCapability {
    aspect_ratios: Vec<String>,
    pub(crate) restore_tile_side: u32,
}

/// Submission geometry for one AI image request. PaintNode crops (never pads)
/// its submissions, so the working canvas equals the submitted image; providers
/// may still answer with any same-ratio resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AiWorkingCanvas {
    pub(crate) original_dimensions: (u32, u32),
    pub(crate) working_dimensions: (u32, u32),
    pub(crate) aspect_label: String,
}

static AI_IMAGE_MODEL_CAPABILITIES: OnceLock<ImageModelCapabilities> = OnceLock::new();

const AI_IMAGE_MODEL_CAPABILITIES_JSON: &str =
    include_str!("../../../src/lib/ai/imageModelCapabilities.json");

fn ai_image_model_capabilities() -> &'static ImageModelCapabilities {
    AI_IMAGE_MODEL_CAPABILITIES.get_or_init(|| {
        serde_json::from_str(AI_IMAGE_MODEL_CAPABILITIES_JSON)
            .expect("PaintNode AI image model capabilities JSON must be valid")
    })
}

pub(crate) fn ai_fallback_aspect_ratios() -> &'static [SupportedAspectRatio] {
    &ai_image_model_capabilities().fallback_aspect_ratios
}

pub(crate) fn ai_codex_image_capability() -> &'static CodexImageCapability {
    &ai_image_model_capabilities().providers.codex
}

pub(crate) fn ai_antigravity_image_capability() -> &'static AntigravityImageCapability {
    &ai_image_model_capabilities().providers.antigravity
}

pub(crate) fn ai_exact_working_canvas(
    dimensions: (u32, u32),
    aspect_label: &str,
) -> AiWorkingCanvas {
    AiWorkingCanvas {
        original_dimensions: dimensions,
        working_dimensions: dimensions,
        aspect_label: aspect_label.into(),
    }
}

pub(crate) fn validate_optional_target_dimensions(
    width: Option<u32>,
    height: Option<u32>,
) -> Result<Option<(u32, u32)>, String> {
    match (width, height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => Ok(Some((width, height))),
        (None, None) => Ok(None),
        _ => Err("AI target dimensions must include both width and height.".into()),
    }
}

/// Normalize a provider result to the submitted crop size: exact-size results
/// pass through; same-ratio results at another resolution get resized.
fn crop_png_bytes_to_ai_content(
    bytes: &[u8],
    working: &AiWorkingCanvas,
    label: &str,
) -> Result<(Vec<u8>, (u32, u32), bool), String> {
    let result_dimensions = png_dimensions_from_bytes(bytes)
        .ok_or_else(|| format!("{label} PNG dimensions are invalid."))?;
    if result_dimensions == working.original_dimensions {
        return Ok((bytes.to_vec(), result_dimensions, false));
    }

    let image = decode_png_rgba(bytes, label)?;
    let normalized = image::imageops::resize(
        &image,
        working.original_dimensions.0,
        working.original_dimensions.1,
        image::imageops::FilterType::Lanczos3,
    );
    let normalized_bytes = encode_rgba_png(normalized, label)?;
    Ok((normalized_bytes, result_dimensions, true))
}

pub(crate) fn read_png_bytes_cropped_to_ai_working_canvas(
    path: &Path,
    working: &AiWorkingCanvas,
    label: &str,
) -> Result<(Vec<u8>, (u32, u32), bool), String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {label}: {e}"))?;
    let (normalized_bytes, result_dimensions, normalized) =
        crop_png_bytes_to_ai_content(&bytes, working, label)?;
    if normalized {
        fs::write(path, &normalized_bytes)
            .map_err(|e| format!("Failed to write cropped {label} at {}: {e}", path.display()))?;
    }
    Ok((normalized_bytes, result_dimensions, normalized))
}

pub(crate) fn ai_working_canvas_accepts_result_dimensions(
    working: &AiWorkingCanvas,
    dimensions: (u32, u32),
) -> bool {
    if dimensions == working.original_dimensions || dimensions == working.working_dimensions {
        return true;
    }
    let lhs = u128::from(dimensions.0) * u128::from(working.working_dimensions.1);
    let rhs = u128::from(dimensions.1) * u128::from(working.working_dimensions.0);
    let diff = lhs.abs_diff(rhs);
    diff * 1000 <= lhs.max(rhs) * 2
}

pub(crate) fn mask_pixel_coverage(mask_pixel: &image::Rgba<u8>) -> u8 {
    let [r, g, b, a] = mask_pixel.0;
    let luminance = (u32::from(r) * 54 + u32::from(g) * 183 + u32::from(b) * 19 + 128) / 256;
    ((luminance * u32::from(a) + 127) / 255) as u8
}

fn box_blur_coverage(coverage: &[u8], width: u32, height: u32, radius: u32) -> Vec<u8> {
    if radius == 0 {
        return coverage.to_vec();
    }
    let w = width as usize;
    let h = height as usize;
    let r = radius as usize;
    let mut horizontal = vec![0_u8; coverage.len()];
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let x0 = x.saturating_sub(r);
            let x1 = (x + r).min(w - 1);
            let mut sum = 0_u32;
            for sx in x0..=x1 {
                sum += u32::from(coverage[row + sx]);
            }
            horizontal[row + x] = (sum / (x1 - x0 + 1) as u32) as u8;
        }
    }

    let mut out = vec![0_u8; coverage.len()];
    for y in 0..h {
        let y0 = y.saturating_sub(r);
        let y1 = (y + r).min(h - 1);
        for x in 0..w {
            let mut sum = 0_u32;
            for sy in y0..=y1 {
                sum += u32::from(horizontal[sy * w + x]);
            }
            out[y * w + x] = (sum / (y1 - y0 + 1) as u32) as u8;
        }
    }
    out
}

pub(crate) fn ai_retouch_editable_mask_png(
    source_png: &[u8],
    mask_png: &[u8],
    grow_radius: u32,
    feather_radius: u32,
) -> Result<Vec<u8>, String> {
    let source_dimensions = png_dimensions_from_bytes(source_png)
        .ok_or_else(|| "AI retouch source PNG dimensions are invalid.".to_string())?;
    let mask = decode_png_rgba(mask_png, "AI retouch mask")?;
    if mask.dimensions() != source_dimensions {
        return Err(format!(
            "AI retouch mask must match source dimensions. Source is {}x{}, mask is {}x{}.",
            source_dimensions.0,
            source_dimensions.1,
            mask.width(),
            mask.height()
        ));
    }

    let width = source_dimensions.0;
    let height = source_dimensions.1;
    let mut original = vec![0_u8; (width * height) as usize];
    let mut covered = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize;
            let coverage = mask_pixel_coverage(mask.get_pixel(x, y));
            original[i] = coverage;
            if coverage > 0 {
                covered.push((x, y, coverage));
            }
        }
    }

    let mut grown = original.clone();
    let radius_sq = grow_radius.saturating_mul(grow_radius);
    for (x, y, coverage) in covered {
        let x0 = x.saturating_sub(grow_radius);
        let y0 = y.saturating_sub(grow_radius);
        let x1 = (x + grow_radius).min(width - 1);
        let y1 = (y + grow_radius).min(height - 1);
        for yy in y0..=y1 {
            let dy = yy.abs_diff(y);
            for xx in x0..=x1 {
                let dx = xx.abs_diff(x);
                if dx.saturating_mul(dx) + dy.saturating_mul(dy) > radius_sq {
                    continue;
                }
                let i = (yy * width + xx) as usize;
                grown[i] = grown[i].max(coverage);
            }
        }
    }

    let blurred = box_blur_coverage(&grown, width, height, feather_radius);
    let mut out = image::RgbaImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize;
            let coverage = blurred[i].max(original[i]);
            out.put_pixel(x, y, image::Rgba([255, 255, 255, coverage]));
        }
    }

    encode_rgba_png(out, "AI retouch editable mask")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::test_rgba_png;

    #[test]
    fn ai_retouch_editable_mask_png_grows_and_feathers_mask() {
        let source = test_rgba_png(7, 1, &[[0, 0, 0, 255]; 7]);
        let mask = test_rgba_png(
            7,
            1,
            &[
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [255, 255, 255, 255],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
            ],
        );

        let result = ai_retouch_editable_mask_png(&source, &mask, 1, 1).expect("editable mask");
        let layer = decode_png_rgba(&result, "result").expect("decoded mask");

        assert_eq!(layer.get_pixel(3, 0).0[3], 255);
        assert!(layer.get_pixel(2, 0).0[3] > 0);
        assert!(layer.get_pixel(4, 0).0[3] > 0);
        assert_eq!(layer.get_pixel(0, 0).0[3], 0);
        assert_eq!(layer.get_pixel(6, 0).0[3], 0);
    }

    #[test]
    fn ai_retouch_editable_mask_png_rejects_size_mismatch() {
        let source = test_rgba_png(2, 1, &[[1, 2, 3, 255], [4, 5, 6, 255]]);
        let mask = test_rgba_png(1, 1, &[[255, 255, 255, 255]]);

        let err = ai_retouch_editable_mask_png(&source, &mask, 1, 1)
            .expect_err("size mismatch should fail");

        assert!(err.contains("Source is 2x1, mask is 1x1"));
    }

    #[test]
    fn crop_png_bytes_to_ai_content_passes_exact_results_and_resizes_same_ratio() {
        let working = ai_exact_working_canvas((32, 20), "codex");

        let exact =
            image::RgbaImage::from_fn(32, 20, |x, y| image::Rgba([x as u8, y as u8, 77, 255]));
        let exact_bytes = encode_rgba_png(exact, "provider output").expect("encode output");
        let (bytes, provider_dimensions, normalized) =
            crop_png_bytes_to_ai_content(&exact_bytes, &working, "provider output")
                .expect("normalize output");
        assert_eq!(provider_dimensions, (32, 20));
        assert!(!normalized);
        assert_eq!(bytes, exact_bytes);

        let scaled = image::RgbaImage::from_pixel(64, 40, image::Rgba([20, 40, 220, 255]));
        let scaled_bytes = encode_rgba_png(scaled, "provider output").expect("encode output");
        let (bytes, provider_dimensions, normalized) =
            crop_png_bytes_to_ai_content(&scaled_bytes, &working, "provider output")
                .expect("normalize output");
        let normalized_image = decode_png_rgba(&bytes, "normalized output").expect("decode");
        assert_eq!(provider_dimensions, (64, 40));
        assert!(normalized);
        assert_eq!(normalized_image.dimensions(), (32, 20));
        assert_eq!(normalized_image.get_pixel(0, 0).0, [20, 40, 220, 255]);
    }

    #[test]
    fn ai_working_canvas_accepts_scaled_same_ratio_outputs() {
        let working = ai_exact_working_canvas((1280, 800), "codex");

        assert!(ai_working_canvas_accepts_result_dimensions(
            &working,
            working.original_dimensions
        ));
        assert!(ai_working_canvas_accepts_result_dimensions(
            &working,
            (1536, 960)
        ));
        assert!(!ai_working_canvas_accepts_result_dimensions(
            &working,
            (1024, 1024)
        ));
    }
}
