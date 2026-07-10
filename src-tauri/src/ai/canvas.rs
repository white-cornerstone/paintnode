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
    pub(crate) max_long_side: u32,
    pub(crate) max_short_side: u32,
    /// Widest aspect ratio the model reliably renders for one tile. Wider
    /// fill frames expand the short side up to this ratio, then split only
    /// when the resulting source frame exceeds the model size caps.
    pub(crate) max_aspect_ratio: u32,
    /// Largest tile side for AI detail restoration: tiles at or below this
    /// size regenerate at the model's native output density.
    pub(crate) restore_tile_side: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AntigravityImageCapability {
    /// Actual 1K-tier output grids per supported aspect-ratio label. The
    /// model's real output ratios deviate from the nominal labels (e.g.
    /// "21:9" outputs 1584x672 = 33:14, not 7:3); crops must match the real
    /// grid or the model cannot reproduce the frame and reframes instead.
    pub(crate) aspect_ratios: Vec<SupportedAspectRatio>,
    pub(crate) restore_tile_side: u32,
}

/// Nano Banana resolution tiers as multiples of the 1K grids above.
const ANTIGRAVITY_OUTPUT_TIERS: [(&str, u32); 3] = [("1K", 1), ("2K", 2), ("4K", 4)];

/// Image-tool parameters for a submitted crop: the smallest resolution tier
/// whose output grid covers the crop, so results only ever downscale back
/// onto the document. Returns `(tier name, output dimensions)`; `None` when
/// the label is not an Antigravity aspect ratio.
pub(crate) fn antigravity_output_target(
    aspect_label: &str,
    dimensions: (u32, u32),
) -> Option<(&'static str, (u32, u32))> {
    let ratio = ai_antigravity_image_capability()
        .aspect_ratios
        .iter()
        .find(|ratio| ratio.label == aspect_label)?;
    let (tier, scale) = ANTIGRAVITY_OUTPUT_TIERS
        .iter()
        .copied()
        .find(|(_, scale)| {
            ratio.width * scale >= dimensions.0 && ratio.height * scale >= dimensions.1
        })
        .unwrap_or(("4K", 4));
    Some((tier, (ratio.width * scale, ratio.height * scale)))
}

/// Submission geometry for one AI image request. The working canvas is the
/// provider source frame; placement owns how that frame maps back to the
/// document paste rect. Providers may answer with any same-ratio resolution.
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

pub(crate) type NormalizedPngResult = (Vec<u8>, (u32, u32), bool);

/// Normalize a provider result to the submitted crop size: exact-size results
/// pass through; same-ratio results at another resolution get resized.
fn crop_png_bytes_to_ai_content(
    bytes: &[u8],
    working: &AiWorkingCanvas,
    label: &str,
) -> Result<NormalizedPngResult, String> {
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
) -> Result<NormalizedPngResult, String> {
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

/// Mean absolute luminance drift (0-255 scale) allowed over fully-protected
/// mask pixels before a candidate is rejected as a from-scratch regeneration.
/// This is a backstop against a model that ignores the frame and paints a
/// wholly different scene (drift climbs into the tens-to-hundreds), NOT a
/// pixel-fidelity check: providers like Antigravity re-render the whole frame
/// every part rather than editing in place, so a faithful result still drifts
/// noticeably where its regenerated protected region meets an earlier part's.
/// Kept generous so legitimate tiled re-renders pass; earlier ultrawide
/// regressions were an aspect-ratio mismatch (now fixed in placement), not a
/// fidelity problem this gate should catch.
pub(crate) const AI_PROTECTED_DRIFT_LIMIT: f64 = 32.0;

/// How many candidates to accept-or-reject per part before failing the run:
/// the first attempt plus one retry with the stricter in-place note.
pub(crate) const AI_PROTECTED_DRIFT_MAX_ATTEMPTS: u32 = 2;

/// Below this many comparable protected pixels the drift measurement is too
/// noisy to gate on (e.g. full-coverage restore masks protect nothing, or a
/// transparent-background document leaves almost no opaque protected pixels).
const AI_DRIFT_MIN_PROTECTED_PIXELS: u64 = 4096;

fn pixel_luminance(pixel: &image::Rgba<u8>) -> u8 {
    let [r, g, b, _] = pixel.0;
    ((u32::from(r) * 54 + u32::from(g) * 183 + u32::from(b) * 19 + 128) / 256) as u8
}

/// Drop a drift-rejected candidate from the job dir. It must actually be
/// gone: provider runners treat an existing result.png as a satisfied or
/// reusable output (killing the retry agent immediately, or resurrecting the
/// rejected candidate on a resumed run via reuse_part_result).
pub(crate) fn remove_rejected_ai_candidate(result_path: &Path) -> Result<(), String> {
    if let Err(error) = fs::remove_file(result_path) {
        if result_path.exists() {
            return Err(format!(
                "Failed to remove the rejected AI candidate at {}: {error}",
                result_path.display()
            ));
        }
    }
    Ok(())
}

/// Mean absolute luminance drift between the image the model was told to
/// edit (`edit_target_png`) and `candidate_png`, measured over
/// fully-protected mask pixels (coverage 0) where the edit target is fully
/// opaque. Transparent edit-target pixels are skipped — generated output is
/// opaque, so comparing against them would reject every faithful edit on a
/// transparent-background document. The candidate's luminance is
/// alpha-weighted, so a candidate that goes transparent over an opaque
/// baseline still registers as drift. Detects candidates where the image
/// model regenerated the whole scene instead of editing in place — pasting
/// those back produces visibly broken seams at the mask boundary. Returns
/// `None` when too few pixels are comparable to judge.
pub(crate) fn ai_protected_region_drift(
    edit_target_png: &[u8],
    mask_png: &[u8],
    candidate_png: &[u8],
    label: &str,
) -> Result<Option<f64>, String> {
    let baseline = decode_png_rgba(edit_target_png, label)?;
    let mask = decode_png_rgba(mask_png, label)?;
    let candidate = decode_png_rgba(candidate_png, label)?;
    if mask.dimensions() != baseline.dimensions() || candidate.dimensions() != baseline.dimensions()
    {
        return Err(format!(
            "{label} protected-drift inputs must have identical dimensions."
        ));
    }
    let mut sum = 0_u64;
    let mut count = 0_u64;
    for (baseline_pixel, (mask_pixel, candidate_pixel)) in
        baseline.pixels().zip(mask.pixels().zip(candidate.pixels()))
    {
        if mask_pixel_coverage(mask_pixel) > 0 || baseline_pixel.0[3] != 255 {
            continue;
        }
        // Alpha-weighted luminance: a transparent candidate pixel over an
        // opaque baseline reads as 0 and counts as drift.
        let candidate_luma = mask_pixel_coverage(candidate_pixel);
        sum += u64::from(pixel_luminance(baseline_pixel).abs_diff(candidate_luma));
        count += 1;
    }
    if count < AI_DRIFT_MIN_PROTECTED_PIXELS {
        return Ok(None);
    }
    Ok(Some(sum as f64 / count as f64))
}

/// Optional per-run seam-continuity gate limit for a user check level.
/// Level 0 disables all checks, level 1 is the drift gate only, levels 2 and
/// 3 add this seam gate at balanced/strict thresholds.
pub(crate) fn ai_seam_mismatch_limit(check_level: u8) -> Option<f64> {
    match check_level {
        2 => Some(18.0),
        3.. => Some(9.0),
        _ => None,
    }
}

/// User-selected result-check level, defaulted and clamped. Level 1 (drift
/// gate only) matches the behavior before the level existed; level 0 turns
/// every check off for intentionally discontinuous edits (e.g. a grid of
/// unrelated index-sheet cells).
pub(crate) fn ai_edit_checks_level(level: Option<u8>) -> u8 {
    level.unwrap_or(1).min(3)
}

/// Why a candidate was rejected by the result checks, and which retry note
/// should steer the next attempt.
pub(crate) struct AiCandidateRejection {
    pub(crate) reason: String,
    pub(crate) continuation_retry: bool,
}

/// Run the enabled result checks against a candidate. Returns the first
/// failed check (drift before seam continuity), or `None` when the candidate
/// passes every check enabled at `check_level`.
pub(crate) fn ai_candidate_rejection(
    check_level: u8,
    edit_target_png: &[u8],
    source_png: &[u8],
    mask_png: &[u8],
    candidate_png: &[u8],
    label: &str,
) -> Result<Option<AiCandidateRejection>, String> {
    if check_level == 0 {
        return Ok(None);
    }
    if let Some(drift) = ai_protected_region_drift(edit_target_png, mask_png, candidate_png, label)?
        .filter(|drift| *drift > AI_PROTECTED_DRIFT_LIMIT)
    {
        return Ok(Some(AiCandidateRejection {
            reason: format!(
                "pixels outside the mask changed too much (drift {drift:.1}, limit {AI_PROTECTED_DRIFT_LIMIT})"
            ),
            continuation_retry: false,
        }));
    }
    if let Some(limit) = ai_seam_mismatch_limit(check_level) {
        if let Some(mismatch) =
            ai_seam_continuity_mismatch(source_png, mask_png, candidate_png, label)?
                .filter(|mismatch| *mismatch > limit)
        {
            return Ok(Some(AiCandidateRejection {
                reason: format!(
                    "the content inside the mask does not continue the surrounding scene (seam mismatch {mismatch:.1}, limit {limit})"
                ),
                continuation_retry: true,
            }));
        }
    }
    Ok(None)
}

/// Appended to the prompt when a candidate fails the seam-continuity check:
/// the masked area read as a separate picture instead of a continuation.
pub(crate) const AI_SEAM_RETRY_NOTE: &str = r#"IMPORTANT — previous candidate rejected:
- The previous candidate's content inside the editable mask did not continue the surrounding scene; it read as a separate, unrelated picture. PaintNode discarded it.
- Generate the masked area as a direct continuation of the adjacent visible content: extend the same surfaces, structures, lighting, palette, scale, and perspective across the mask boundary.
- Do not compose a standalone scene, add new focal subjects, or change the zoom level. If the requested content does not fit this area naturally, favor seamless continuation over completeness."#;

/// Band sampled on each side of the mask boundary, past the blend zone.
const AI_SEAM_BAND_SKIP: u32 = 4;
const AI_SEAM_BAND_DEPTH: u32 = 28;
/// Minimum sampled band pixels to judge continuity.
const AI_SEAM_MIN_SAMPLES: u64 = 512;

/// Seam-continuity mismatch (0-100) between the candidate's newly generated
/// content just inside the editable mask area and the original content just
/// outside it. Each fully-editable pixel near the boundary is paired with its
/// nearest protected pixel (chamfer distance transform), and their
/// neighborhood color and local texture are compared using blurs that never
/// mix content across the boundary. A candidate that continues the scene
/// scores low; a candidate that composed an unrelated picture inside the
/// mask scores high. Returns `None` when there is too little boundary to
/// judge (e.g. a mask covering the whole canvas).
pub(crate) fn ai_seam_continuity_mismatch(
    source_png: &[u8],
    mask_png: &[u8],
    candidate_png: &[u8],
    label: &str,
) -> Result<Option<f64>, String> {
    let source = decode_png_rgba(source_png, label)?;
    let mask = decode_png_rgba(mask_png, label)?;
    let candidate = decode_png_rgba(candidate_png, label)?;
    if mask.dimensions() != source.dimensions() || candidate.dimensions() != source.dimensions() {
        return Err(format!(
            "{label} seam-continuity inputs must have identical dimensions."
        ));
    }
    let (width, height) = source.dimensions();
    let w = width as usize;
    let h = height as usize;
    let len = w * h;
    if len == 0 {
        return Ok(None);
    }

    // Fully-protected vs fully-editable pixels; the gray feather in between
    // belongs to neither side (it is a blend of both).
    let mut protected = vec![0_u8; len];
    let mut editable = vec![0_u8; len];
    for (i, pixel) in mask.pixels().enumerate() {
        match mask_pixel_coverage(pixel) {
            0 => protected[i] = 1,
            255 => editable[i] = 1,
            _ => {}
        }
    }

    // Nearest protected pixel for every position (approximate chebyshev
    // chamfer transform, forward + backward pass).
    const FAR: u32 = u32::MAX / 2;
    let mut dist = vec![FAR; len];
    let mut nearest = vec![0_u32; len];
    for i in 0..len {
        if protected[i] == 1 {
            dist[i] = 0;
            nearest[i] = i as u32;
        }
    }
    fn relax(i: usize, n: usize, dist: &mut [u32], nearest: &mut [u32]) {
        if dist[n] != FAR && dist[n] + 1 < dist[i] {
            dist[i] = dist[n] + 1;
            nearest[i] = nearest[n];
        }
    }
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if x > 0 {
                relax(i, i - 1, &mut dist, &mut nearest);
            }
            if y > 0 {
                relax(i, i - w, &mut dist, &mut nearest);
                if x > 0 {
                    relax(i, i - w - 1, &mut dist, &mut nearest);
                }
                if x + 1 < w {
                    relax(i, i - w + 1, &mut dist, &mut nearest);
                }
            }
        }
    }
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let i = y * w + x;
            if x + 1 < w {
                relax(i, i + 1, &mut dist, &mut nearest);
            }
            if y + 1 < h {
                relax(i, i + w, &mut dist, &mut nearest);
                if x + 1 < w {
                    relax(i, i + w + 1, &mut dist, &mut nearest);
                }
                if x > 0 {
                    relax(i, i + w - 1, &mut dist, &mut nearest);
                }
            }
        }
    }

    // The editable side starts past the feather gap; sample a band beyond the
    // model's blend zone so copied edge pixels cannot mask a discontinuity.
    let gap = editable
        .iter()
        .zip(&dist)
        .filter(|(flag, _)| **flag == 1)
        .map(|(_, d)| *d)
        .min()
        .unwrap_or(FAR);
    if gap == FAR {
        return Ok(None);
    }
    let band_start = gap + AI_SEAM_BAND_SKIP;
    let band_end = gap + AI_SEAM_BAND_DEPTH;

    // Side-local planes: blurs weighted by each side's validity mask, so
    // boundary values never mix editable and protected content.
    let plane = |image: &image::RgbaImage, channel: usize| -> Vec<u8> {
        image.pixels().map(|pixel| pixel.0[channel]).collect()
    };
    let luma_plane =
        |image: &image::RgbaImage| -> Vec<u8> { image.pixels().map(pixel_luminance).collect() };
    let side_planes = |image: &image::RgbaImage, valid: &[u8]| -> [Vec<u8>; 4] {
        let luma = masked_box_blur(&luma_plane(image), valid, w, h, 2);
        let deviation: Vec<u8> = luma_plane(image)
            .iter()
            .zip(&luma)
            .map(|(raw, blurred)| raw.abs_diff(*blurred))
            .collect();
        [
            masked_box_blur(&plane(image, 0), valid, w, h, 2),
            masked_box_blur(&plane(image, 1), valid, w, h, 2),
            masked_box_blur(&plane(image, 2), valid, w, h, 2),
            masked_box_blur(&deviation, valid, w, h, 4),
        ]
    };
    let outer = side_planes(&source, &protected);
    let inner = side_planes(&candidate, &editable);
    let source_alpha = plane(&source, 3);

    let mut sum = 0_f64;
    let mut count = 0_u64;
    for i in 0..len {
        if editable[i] != 1 || dist[i] < band_start || dist[i] > band_end {
            continue;
        }
        let paired = nearest[i] as usize;
        // Protected pixels the document never painted carry no context.
        if source_alpha[paired] != 255 {
            continue;
        }
        let color_diff = (f64::from(inner[0][i].abs_diff(outer[0][paired]))
            + f64::from(inner[1][i].abs_diff(outer[1][paired]))
            + f64::from(inner[2][i].abs_diff(outer[2][paired])))
            / 3.0;
        let texture_diff = f64::from(inner[3][i].abs_diff(outer[3][paired]));
        sum += 0.7 * color_diff + 0.3 * texture_diff;
        count += 1;
    }
    if count < AI_SEAM_MIN_SAMPLES {
        return Ok(None);
    }
    Ok(Some((sum / count as f64) / 2.55))
}

/// Box blur that averages only `valid` (nonzero-flag) pixels; positions with
/// no valid pixel in the window stay 0. Keeps side-local statistics from
/// bleeding across the mask boundary.
fn masked_box_blur(values: &[u8], valid: &[u8], w: usize, h: usize, radius: usize) -> Vec<u8> {
    let mut out = vec![0_u8; values.len()];
    let mut row_sum = vec![0_u32; values.len()];
    let mut row_count = vec![0_u32; values.len()];
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius).min(w - 1);
            let mut sum = 0_u32;
            let mut count = 0_u32;
            for sx in x0..=x1 {
                if valid[row + sx] != 0 {
                    sum += u32::from(values[row + sx]);
                    count += 1;
                }
            }
            row_sum[row + x] = sum;
            row_count[row + x] = count;
        }
    }
    for y in 0..h {
        let y0 = y.saturating_sub(radius);
        let y1 = (y + radius).min(h - 1);
        for x in 0..w {
            let mut sum = 0_u32;
            let mut count = 0_u32;
            for sy in y0..=y1 {
                sum += row_sum[sy * w + x];
                count += row_count[sy * w + x];
            }
            if let Some(mean) = (sum + count / 2).checked_div(count) {
                out[y * w + x] = mean as u8;
            }
        }
    }
    out
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

    /// 96x96 canvas with a 32x32 editable rect: 8192 protected pixels, enough
    /// to clear the drift gate's minimum-sample floor.
    fn drift_mask_png() -> Vec<u8> {
        let mask = image::RgbaImage::from_fn(96, 96, |x, y| {
            if (32..64).contains(&x) && (32..64).contains(&y) {
                image::Rgba([255, 255, 255, 255])
            } else {
                image::Rgba([0, 0, 0, 255])
            }
        });
        encode_rgba_png(mask, "test mask").expect("mask png")
    }

    fn drift_image_png(protected: [u8; 4], editable: [u8; 4]) -> Vec<u8> {
        let image = image::RgbaImage::from_fn(96, 96, |x, y| {
            if (32..64).contains(&x) && (32..64).contains(&y) {
                image::Rgba(editable)
            } else {
                image::Rgba(protected)
            }
        });
        encode_rgba_png(image, "test image").expect("image png")
    }

    #[test]
    fn antigravity_output_target_picks_smallest_covering_tier() {
        // 1386x588 (33:14 grid) fits inside the 1K "21:9" output of 1584x672.
        assert_eq!(
            antigravity_output_target("21:9", (1386, 588)),
            Some(("1K", (1584, 672)))
        );
        // A crop wider than the 1K grid needs the 2K tier.
        assert_eq!(
            antigravity_output_target("21:9", (2000, 849)),
            Some(("2K", (3168, 1344)))
        );
        // The extreme 4:1 grid (1K = 2064x512) needs 2K for a full-height
        // 2400x600 crop of a 2600x600 document.
        assert_eq!(
            antigravity_output_target("4:1", (2400, 600)),
            Some(("2K", (4128, 1024)))
        );
        // Oversized crops cap at 4K rather than failing.
        assert_eq!(
            antigravity_output_target("1:1", (9000, 9000)),
            Some(("4K", (4096, 4096)))
        );
        // Codex labels are not Antigravity ratios.
        assert_eq!(antigravity_output_target("codex-crop", (1280, 800)), None);
    }

    /// 128x128 seam mask: protected left (x < 56), gray feather strip, fully
    /// editable right (x >= 72) — a vertical seam with a wide sample band.
    fn seam_mask_png() -> Vec<u8> {
        let mask = image::RgbaImage::from_fn(128, 128, |x, _| {
            if x < 56 {
                image::Rgba([0, 0, 0, 255])
            } else if x < 72 {
                image::Rgba([128, 128, 128, 255])
            } else {
                image::Rgba([255, 255, 255, 255])
            }
        });
        encode_rgba_png(mask, "seam mask").expect("seam mask png")
    }

    fn seam_image_png(left: [u8; 4], right: [u8; 4]) -> Vec<u8> {
        let image = image::RgbaImage::from_fn(128, 128, |x, _| {
            if x < 64 {
                image::Rgba(left)
            } else {
                image::Rgba(right)
            }
        });
        encode_rgba_png(image, "seam image").expect("seam image png")
    }

    #[test]
    fn ai_seam_continuity_accepts_continued_content() {
        let mask = seam_mask_png();
        let source = seam_image_png([128, 120, 110, 255], [128, 120, 110, 255]);
        // The candidate carries the same content across the seam.
        let mismatch = ai_seam_continuity_mismatch(&source, &mask, &source, "test")
            .expect("mismatch")
            .expect("measured");
        assert!(mismatch < 2.0, "expected continuity, got {mismatch}");
    }

    #[test]
    fn ai_seam_continuity_flags_unrelated_content() {
        let mask = seam_mask_png();
        let source = seam_image_png([150, 110, 70, 255], [150, 110, 70, 255]);
        // The candidate composed unrelated content inside the editable area.
        let candidate = seam_image_png([150, 110, 70, 255], [40, 90, 220, 255]);
        let mismatch = ai_seam_continuity_mismatch(&source, &mask, &candidate, "test")
            .expect("mismatch")
            .expect("measured");
        let lenient = ai_seam_mismatch_limit(2).expect("lenient limit");
        let strict = ai_seam_mismatch_limit(3).expect("strict limit");
        assert!(
            mismatch > lenient && mismatch > strict,
            "expected mismatch above both limits, got {mismatch}"
        );
    }

    #[test]
    fn ai_seam_continuity_skips_without_boundary_context() {
        // A mask with no protected pixels (whole-canvas fill) has no seam.
        let all_editable = {
            let mask = image::RgbaImage::from_pixel(128, 128, image::Rgba([255, 255, 255, 255]));
            encode_rgba_png(mask, "all editable").expect("mask png")
        };
        let source = seam_image_png([128, 120, 110, 255], [128, 120, 110, 255]);
        let mismatch =
            ai_seam_continuity_mismatch(&source, &all_editable, &source, "test").expect("mismatch");
        assert!(mismatch.is_none());

        // Transparent protected pixels (never-painted canvas) carry no context.
        let transparent_source = seam_image_png([0, 0, 0, 0], [0, 0, 0, 0]);
        let mismatch =
            ai_seam_continuity_mismatch(&transparent_source, &seam_mask_png(), &source, "test")
                .expect("mismatch");
        assert!(mismatch.is_none());
    }

    #[test]
    fn ai_seam_continuity_levels_gate_only_two_and_above() {
        assert_eq!(ai_seam_mismatch_limit(0), None);
        assert_eq!(ai_seam_mismatch_limit(1), None);
        assert_eq!(ai_seam_mismatch_limit(2), Some(18.0));
        assert_eq!(ai_seam_mismatch_limit(3), Some(9.0));
    }

    #[test]
    fn ai_protected_region_drift_ignores_masked_changes() {
        let mask = drift_mask_png();
        let source = drift_image_png([80, 80, 80, 255], [200, 30, 30, 255]);

        // Identical candidate drifts by zero.
        let drift = ai_protected_region_drift(&source, &mask, &source, "test")
            .expect("drift")
            .expect("measured");
        assert_eq!(drift, 0.0);

        // A candidate that only repaints the editable rect still drifts by zero.
        let edited = drift_image_png([80, 80, 80, 255], [30, 200, 30, 255]);
        let drift = ai_protected_region_drift(&source, &mask, &edited, "test")
            .expect("drift")
            .expect("measured");
        assert_eq!(drift, 0.0);
    }

    #[test]
    fn ai_protected_region_drift_detects_regenerated_protected_pixels() {
        let mask = drift_mask_png();
        let source = drift_image_png([80, 80, 80, 255], [200, 30, 30, 255]);
        let regenerated = drift_image_png([140, 140, 140, 255], [200, 30, 30, 255]);

        let drift = ai_protected_region_drift(&source, &mask, &regenerated, "test")
            .expect("drift")
            .expect("measured");
        assert!(
            drift > AI_PROTECTED_DRIFT_LIMIT,
            "expected drift above limit, got {drift}"
        );
    }

    #[test]
    fn ai_protected_region_drift_skips_transparent_baseline_pixels() {
        let mask = drift_mask_png();
        // Every protected pixel of the edit target is fully transparent (a
        // transparent-background document); the opaque candidate must not be
        // rejected for it — too few comparable pixels, so the gate skips.
        let baseline = drift_image_png([0, 0, 0, 0], [200, 30, 30, 255]);
        let candidate = drift_image_png([255, 255, 255, 255], [30, 200, 30, 255]);

        let drift = ai_protected_region_drift(&baseline, &mask, &candidate, "test").expect("drift");
        assert!(drift.is_none());
    }

    #[test]
    fn ai_protected_region_drift_counts_candidate_transparency_as_drift() {
        let mask = drift_mask_png();
        let baseline = drift_image_png([200, 200, 200, 255], [80, 80, 80, 255]);
        // The candidate wipes opaque protected pixels to transparency.
        let candidate = drift_image_png([200, 200, 200, 0], [80, 80, 80, 255]);

        let drift = ai_protected_region_drift(&baseline, &mask, &candidate, "test")
            .expect("drift")
            .expect("measured");
        assert!(
            drift > AI_PROTECTED_DRIFT_LIMIT,
            "expected drift above limit, got {drift}"
        );
    }

    #[test]
    fn ai_protected_region_drift_skips_masks_without_protected_pixels() {
        let mask = {
            let all_editable =
                image::RgbaImage::from_pixel(96, 96, image::Rgba([255, 255, 255, 255]));
            encode_rgba_png(all_editable, "test mask").expect("mask png")
        };
        let source = drift_image_png([80, 80, 80, 255], [200, 30, 30, 255]);
        let regenerated = drift_image_png([140, 140, 140, 255], [30, 200, 30, 255]);

        let drift = ai_protected_region_drift(&source, &mask, &regenerated, "test").expect("drift");
        assert!(drift.is_none());
    }

    #[test]
    fn ai_protected_region_drift_rejects_size_mismatch() {
        let mask = drift_mask_png();
        let source = drift_image_png([80, 80, 80, 255], [200, 30, 30, 255]);
        let wrong_size = test_rgba_png(1, 1, &[[0, 0, 0, 255]]);

        let err = ai_protected_region_drift(&source, &mask, &wrong_size, "test")
            .expect_err("size mismatch should fail");
        assert!(err.contains("identical dimensions"));
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
