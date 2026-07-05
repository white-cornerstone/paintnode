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

const AI_CHROMA_KEY_RGBA: [u8; 4] = [0, 255, 0, 255];

const AI_WORKING_CANVAS_UNIT: u32 = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PixelRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SupportedAspectRatio {
    label: String,
    width: u32,
    height: u32,
    min_width: u32,
    min_height: u32,
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
struct CodexImageCapability {
    dimension_multiple: u32,
    max_long_side: u32,
    max_short_side: u32,
    max_aspect_ratio: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AntigravityImageCapability {
    aspect_ratios: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AiWorkingCanvas {
    pub(crate) original_dimensions: (u32, u32),
    pub(crate) working_dimensions: (u32, u32),
    pub(crate) content_rect: PixelRect,
    pub(crate) aspect_label: String,
}

static AI_IMAGE_MODEL_CAPABILITIES: OnceLock<ImageModelCapabilities> = OnceLock::new();

const AI_IMAGE_MODEL_CAPABILITIES_JSON: &str =
    include_str!("../../../src/lib/ai/imageModelCapabilities.json");

pub(crate) fn ai_chroma_key_pixel() -> image::Rgba<u8> {
    image::Rgba(AI_CHROMA_KEY_RGBA)
}

pub(crate) fn ai_mask_padding_pixel() -> image::Rgba<u8> {
    image::Rgba([0, 0, 0, 0])
}

impl AiWorkingCanvas {
    pub(crate) fn has_padding(&self) -> bool {
        self.original_dimensions != self.working_dimensions
            || self.content_rect.x != 0
            || self.content_rect.y != 0
    }
}

fn ai_image_model_capabilities() -> &'static ImageModelCapabilities {
    AI_IMAGE_MODEL_CAPABILITIES.get_or_init(|| {
        serde_json::from_str(AI_IMAGE_MODEL_CAPABILITIES_JSON)
            .expect("PaintNode AI image model capabilities JSON must be valid")
    })
}

fn round_up_to_unit(value: u32, unit: u32) -> u32 {
    value.div_ceil(unit).max(1) * unit
}

pub(crate) fn ai_working_canvas_for_dimensions(dimensions: (u32, u32)) -> AiWorkingCanvas {
    let (original_width, original_height) = dimensions;
    let mut best: Option<(AiWorkingCanvas, u64, u64)> = None;

    for ratio in &ai_image_model_capabilities().fallback_aspect_ratios {
        let minimum_units = original_width
            .div_ceil(ratio.width)
            .max(original_height.div_ceil(ratio.height))
            .max(1);
        let units = round_up_to_unit(minimum_units, AI_WORKING_CANVAS_UNIT);
        let Some(working_width) = ratio.width.checked_mul(units) else {
            continue;
        };
        let Some(working_height) = ratio.height.checked_mul(units) else {
            continue;
        };
        let working_width = working_width.max(ratio.min_width);
        let working_height = working_height.max(ratio.min_height);
        if working_width < original_width || working_height < original_height {
            continue;
        }
        let area = u64::from(working_width) * u64::from(working_height);
        let aspect_error = ((i128::from(working_width) * i128::from(original_height))
            - (i128::from(working_height) * i128::from(original_width)))
        .unsigned_abs() as u64;
        let content_rect = PixelRect {
            x: (working_width - original_width) / 2,
            y: (working_height - original_height) / 2,
            width: original_width,
            height: original_height,
        };
        let canvas = AiWorkingCanvas {
            original_dimensions: dimensions,
            working_dimensions: (working_width, working_height),
            content_rect,
            aspect_label: ratio.label.clone(),
        };
        let is_better = best
            .as_ref()
            .map(|(_, best_area, best_aspect_error)| {
                (aspect_error, area) < (*best_aspect_error, *best_area)
            })
            .unwrap_or(true);
        if is_better {
            best = Some((canvas, area, aspect_error));
        }
    }

    best.map(|(canvas, _, _)| canvas)
        .unwrap_or(AiWorkingCanvas {
            original_dimensions: dimensions,
            working_dimensions: dimensions,
            content_rect: PixelRect {
                x: 0,
                y: 0,
                width: original_width,
                height: original_height,
            },
            aspect_label: "custom".into(),
        })
}

fn ai_exact_supported_aspect_ratio(
    dimensions: (u32, u32),
) -> Option<&'static SupportedAspectRatio> {
    let (width, height) = dimensions;
    if width == 0 || height == 0 {
        return None;
    }
    ai_image_model_capabilities()
        .fallback_aspect_ratios
        .iter()
        .find(|ratio| {
            u128::from(width) * u128::from(ratio.height)
                == u128::from(height) * u128::from(ratio.width)
        })
}

fn ai_working_canvas_for_exact_supported_ratio(dimensions: (u32, u32)) -> Option<AiWorkingCanvas> {
    let (width, height) = dimensions;
    ai_exact_supported_aspect_ratio(dimensions).map(|ratio| AiWorkingCanvas {
        original_dimensions: dimensions,
        working_dimensions: dimensions,
        content_rect: PixelRect {
            x: 0,
            y: 0,
            width,
            height,
        },
        aspect_label: ratio.label.clone(),
    })
}

fn ai_exact_working_canvas(dimensions: (u32, u32), aspect_label: &str) -> AiWorkingCanvas {
    let (width, height) = dimensions;
    AiWorkingCanvas {
        original_dimensions: dimensions,
        working_dimensions: dimensions,
        content_rect: PixelRect {
            x: 0,
            y: 0,
            width,
            height,
        },
        aspect_label: aspect_label.into(),
    }
}

fn ai_codex_gpt_image_2_supports_dimensions(dimensions: (u32, u32)) -> bool {
    let (width, height) = dimensions;
    let long_side = width.max(height);
    let short_side = width.min(height);
    let codex = &ai_image_model_capabilities().providers.codex;
    width > 0
        && height > 0
        && codex.dimension_multiple > 0
        && long_side <= codex.max_long_side
        && short_side <= codex.max_short_side
        && width % codex.dimension_multiple == 0
        && height % codex.dimension_multiple == 0
        && u128::from(width) <= u128::from(height) * u128::from(codex.max_aspect_ratio)
        && u128::from(height) <= u128::from(width) * u128::from(codex.max_aspect_ratio)
}

pub(crate) fn ai_codex_working_canvas_for_dimensions(dimensions: (u32, u32)) -> AiWorkingCanvas {
    if ai_codex_gpt_image_2_supports_dimensions(dimensions) {
        return ai_exact_working_canvas(dimensions, "codex");
    }
    ai_working_canvas_for_exact_supported_ratio(dimensions)
        .unwrap_or_else(|| ai_working_canvas_for_dimensions(dimensions))
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

pub(crate) fn pad_png_to_ai_working_canvas(
    bytes: &[u8],
    working: &AiWorkingCanvas,
    label: &str,
    background: image::Rgba<u8>,
) -> Result<Vec<u8>, String> {
    let image = decode_png_rgba(bytes, label)?;
    if image.dimensions() != working.original_dimensions {
        return Err(format!(
            "{label} must be {}x{} before PaintNode prepares the AI working canvas, but it is {}x{}.",
            working.original_dimensions.0,
            working.original_dimensions.1,
            image.width(),
            image.height()
        ));
    }
    if !working.has_padding() {
        return Ok(bytes.to_vec());
    }

    let mut out = image::RgbaImage::from_pixel(
        working.working_dimensions.0,
        working.working_dimensions.1,
        background,
    );
    for y in 0..working.content_rect.height {
        for x in 0..working.content_rect.width {
            out.put_pixel(
                working.content_rect.x + x,
                working.content_rect.y + y,
                *image.get_pixel(x, y),
            );
        }
    }
    encode_rgba_png(out, label)
}

fn scaled_content_rect(result_dimensions: (u32, u32), working: &AiWorkingCanvas) -> PixelRect {
    let scale_x = result_dimensions.0 as f64 / working.working_dimensions.0 as f64;
    let scale_y = result_dimensions.1 as f64 / working.working_dimensions.1 as f64;
    let x = (working.content_rect.x as f64 * scale_x).round() as u32;
    let y = (working.content_rect.y as f64 * scale_y).round() as u32;
    let mut width = (working.content_rect.width as f64 * scale_x).round() as u32;
    let mut height = (working.content_rect.height as f64 * scale_y).round() as u32;
    let x = x.min(result_dimensions.0.saturating_sub(1));
    let y = y.min(result_dimensions.1.saturating_sub(1));
    width = width.max(1).min(result_dimensions.0 - x);
    height = height.max(1).min(result_dimensions.1 - y);
    PixelRect {
        x,
        y,
        width,
        height,
    }
}

fn pixel_is_ai_chroma_key(pixel: &image::Rgba<u8>) -> bool {
    let [r, g, b, a] = pixel.0;
    a >= 245
        && r.abs_diff(AI_CHROMA_KEY_RGBA[0]) <= 8
        && g.abs_diff(AI_CHROMA_KEY_RGBA[1]) <= 8
        && b.abs_diff(AI_CHROMA_KEY_RGBA[2]) <= 8
}

fn ai_chroma_key_padding_coverage(
    image: &image::RgbaImage,
    content_rect: PixelRect,
) -> Option<f64> {
    let mut padding_pixels = 0_u64;
    let mut keyed_pixels = 0_u64;
    for y in 0..image.height() {
        for x in 0..image.width() {
            let inside = x >= content_rect.x
                && x < content_rect.x + content_rect.width
                && y >= content_rect.y
                && y < content_rect.y + content_rect.height;
            if inside {
                continue;
            }
            padding_pixels += 1;
            if pixel_is_ai_chroma_key(image.get_pixel(x, y)) {
                keyed_pixels += 1;
            }
        }
    }
    (padding_pixels > 0).then(|| keyed_pixels as f64 / padding_pixels as f64)
}

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
    let rect = scaled_content_rect(result_dimensions, working);
    let normalized = if working.has_padding()
        && ai_chroma_key_padding_coverage(&image, rect)
            .map(|coverage| coverage < 0.6)
            .unwrap_or(false)
    {
        image::imageops::resize(
            &image,
            working.original_dimensions.0,
            working.original_dimensions.1,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        let cropped =
            image::imageops::crop_imm(&image, rect.x, rect.y, rect.width, rect.height).to_image();
        if cropped.dimensions() == working.original_dimensions {
            cropped
        } else {
            image::imageops::resize(
                &cropped,
                working.original_dimensions.0,
                working.original_dimensions.1,
                image::imageops::FilterType::Lanczos3,
            )
        }
    };
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

fn mask_pixel_coverage(mask_pixel: &image::Rgba<u8>) -> u8 {
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

pub(crate) fn ai_working_canvas_instruction(working: &AiWorkingCanvas) -> String {
    let rect = working.content_rect;
    let padding_note = if working.has_padding() {
        let left_padding = rect.x;
        let top_padding = rect.y;
        let right_padding = working
            .working_dimensions
            .0
            .saturating_sub(rect.x + rect.width);
        let bottom_padding = working
            .working_dimensions
            .1
            .saturating_sub(rect.y + rect.height);
        format!(
            r#"Chroma-key padding:
- Keep the final PNG exactly {working_width}x{working_height}.
- The document rectangle is x={x}, y={y}, width={content_width}, height={content_height}.
- Keep the padding dimensions unchanged: left={left_padding}px, top={top_padding}px, right={right_padding}px, bottom={bottom_padding}px.
- Pixels outside the document rectangle are a flat PaintNode chroma-key matte: {chroma_key}.
- This matte is not a green-screen/key-removal request. Do not remove it or make it transparent.
- Keep every matte pixel exactly {chroma_key}; do not crop, resize, alpha-out, recolor, blur, shade, texture, extend, or paint scene content into the matte.
- Only generate or edit pixels inside the document rectangle."#,
            working_width = working.working_dimensions.0,
            working_height = working.working_dimensions.1,
            x = rect.x,
            y = rect.y,
            content_width = rect.width,
            content_height = rect.height,
            left_padding = left_padding,
            top_padding = top_padding,
            right_padding = right_padding,
            bottom_padding = bottom_padding,
            chroma_key = AI_CHROMA_KEY_HEX
        )
    } else {
        "The document rectangle fills the working PNG.".into()
    };
    format!(
        r#"PaintNode image geometry:
- Working PNG: {working_width}x{working_height}.
- Document rectangle: x={x}, y={y}, width={content_width}, height={content_height}.
{padding_note}
- Keep the document rectangle in the same position and size."#,
        working_width = working.working_dimensions.0,
        working_height = working.working_dimensions.1,
        x = rect.x,
        y = rect.y,
        content_width = rect.width,
        content_height = rect.height,
        padding_note = padding_note
    )
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
    fn ai_working_canvas_chooses_small_supported_canvas_for_unsupported_ratio() {
        let working = ai_working_canvas_for_dimensions((1280, 800));

        assert_eq!(working.aspect_label, "3:2");
        assert_eq!(working.working_dimensions, (1296, 864));
        assert_eq!(
            working.content_rect,
            PixelRect {
                x: 8,
                y: 32,
                width: 1280,
                height: 800,
            }
        );
    }

    #[test]
    fn ai_working_canvas_uses_provider_bucket_for_small_exact_ratio() {
        let working = ai_working_canvas_for_dimensions((1024, 768));

        assert_eq!(working.aspect_label, "4:3");
        assert_eq!(working.working_dimensions, (1448, 1086));
        assert_eq!(
            working.content_rect,
            PixelRect {
                x: 212,
                y: 159,
                width: 1024,
                height: 768,
            }
        );
        assert!(working.has_padding());

        let working = ai_working_canvas_for_dimensions((1280, 960));
        assert_eq!(working.aspect_label, "4:3");
        assert_eq!(working.working_dimensions, (1448, 1086));
        assert_eq!(
            working.content_rect,
            PixelRect {
                x: 84,
                y: 63,
                width: 1280,
                height: 960,
            }
        );
        assert!(working.has_padding());
    }

    #[test]
    fn codex_retouch_working_canvas_uses_unpadded_exact_supported_ratio() {
        let working = ai_codex_working_canvas_for_dimensions((1280, 960));

        assert_eq!(working.aspect_label, "codex");
        assert_eq!(working.working_dimensions, (1280, 960));
        assert_eq!(
            working.content_rect,
            PixelRect {
                x: 0,
                y: 0,
                width: 1280,
                height: 960,
            }
        );
        assert!(!working.has_padding());

        let default_canvas = ai_codex_working_canvas_for_dimensions((1280, 800));
        assert_eq!(default_canvas.aspect_label, "codex");
        assert_eq!(default_canvas.working_dimensions, (1280, 800));
        assert_eq!(
            default_canvas.content_rect,
            PixelRect {
                x: 0,
                y: 0,
                width: 1280,
                height: 800,
            }
        );
        assert!(!default_canvas.has_padding());

        let unsupported = ai_codex_working_canvas_for_dimensions((1281, 800));
        assert_eq!(unsupported.aspect_label, "3:2");
        assert!(unsupported.has_padding());
    }

    #[test]
    fn pad_png_to_ai_working_canvas_centers_original_pixels() {
        let working = ai_working_canvas_for_dimensions((32, 20));
        let source =
            image::RgbaImage::from_fn(32, 20, |x, y| image::Rgba([x as u8, y as u8, 200, 255]));
        let source_bytes = encode_rgba_png(source, "source").expect("encode source");

        let padded =
            pad_png_to_ai_working_canvas(&source_bytes, &working, "source", ai_chroma_key_pixel())
                .expect("pad source");
        let padded_image = decode_png_rgba(&padded, "padded source").expect("decode padded");

        assert_eq!(padded_image.dimensions(), working.working_dimensions);
        assert_eq!(padded_image.get_pixel(0, 0).0, AI_CHROMA_KEY_RGBA);
        assert_eq!(
            padded_image
                .get_pixel(working.content_rect.x + 7, working.content_rect.y + 3)
                .0,
            [7, 3, 200, 255]
        );

        let padded_mask =
            pad_png_to_ai_working_canvas(&source_bytes, &working, "mask", ai_mask_padding_pixel())
                .expect("pad mask");
        let padded_mask_image =
            decode_png_rgba(&padded_mask, "padded mask").expect("decode padded mask");

        assert_eq!(padded_mask_image.dimensions(), working.working_dimensions);
        assert_eq!(padded_mask_image.get_pixel(0, 0).0, [0, 0, 0, 0]);
        assert_eq!(
            padded_mask_image
                .get_pixel(working.content_rect.x + 7, working.content_rect.y + 3)
                .0,
            [7, 3, 200, 255]
        );
    }

    #[test]
    fn crop_png_bytes_to_ai_content_extracts_centered_document_rect() {
        let working = ai_working_canvas_for_dimensions((32, 20));
        let output = image::RgbaImage::from_fn(
            working.working_dimensions.0,
            working.working_dimensions.1,
            |x, y| {
                let inside = x >= working.content_rect.x
                    && x < working.content_rect.x + working.content_rect.width
                    && y >= working.content_rect.y
                    && y < working.content_rect.y + working.content_rect.height;
                if inside {
                    image::Rgba([
                        (x - working.content_rect.x) as u8,
                        (y - working.content_rect.y) as u8,
                        77,
                        255,
                    ])
                } else {
                    ai_chroma_key_pixel()
                }
            },
        );
        let output_bytes = encode_rgba_png(output, "provider output").expect("encode output");

        let (cropped_bytes, provider_dimensions, cropped) =
            crop_png_bytes_to_ai_content(&output_bytes, &working, "provider output")
                .expect("crop output");
        let cropped_image = decode_png_rgba(&cropped_bytes, "cropped output").expect("decode crop");

        assert_eq!(provider_dimensions, working.working_dimensions);
        assert!(cropped);
        assert_eq!(cropped_image.dimensions(), working.original_dimensions);
        assert_eq!(cropped_image.get_pixel(0, 0).0, [0, 0, 77, 255]);
        assert_eq!(cropped_image.get_pixel(31, 19).0, [31, 19, 77, 255]);
    }

    #[test]
    fn crop_png_bytes_to_ai_content_resizes_full_frame_when_chroma_padding_is_removed() {
        let working = ai_working_canvas_for_dimensions((32, 20));
        let output = image::RgbaImage::from_fn(
            working.working_dimensions.0,
            working.working_dimensions.1,
            |x, y| {
                let inside = x >= working.content_rect.x
                    && x < working.content_rect.x + working.content_rect.width
                    && y >= working.content_rect.y
                    && y < working.content_rect.y + working.content_rect.height;
                if inside {
                    image::Rgba([20, 40, 220, 255])
                } else {
                    image::Rgba([220, 20, 40, 255])
                }
            },
        );
        let output_bytes = encode_rgba_png(output, "provider output").expect("encode output");

        let (cropped_bytes, provider_dimensions, cropped) =
            crop_png_bytes_to_ai_content(&output_bytes, &working, "provider output")
                .expect("normalize output");
        let cropped_image =
            decode_png_rgba(&cropped_bytes, "normalized output").expect("decode normalized");

        assert_eq!(provider_dimensions, working.working_dimensions);
        assert!(cropped);
        assert_eq!(cropped_image.dimensions(), working.original_dimensions);
        assert_eq!(cropped_image.get_pixel(0, 0).0, [220, 20, 40, 255]);
    }

    #[test]
    fn ai_working_canvas_accepts_scaled_same_ratio_outputs() {
        let working = ai_working_canvas_for_dimensions((1280, 800));

        assert!(ai_working_canvas_accepts_result_dimensions(
            &working,
            working.original_dimensions
        ));
        assert!(ai_working_canvas_accepts_result_dimensions(
            &working,
            working.working_dimensions
        ));
        assert!(ai_working_canvas_accepts_result_dimensions(
            &working,
            (1536, 1024)
        ));
        assert!(!ai_working_canvas_accepts_result_dimensions(
            &working,
            (1024, 1024)
        ));
    }
}
