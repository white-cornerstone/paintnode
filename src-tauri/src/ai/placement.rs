//! Crop-based AI edit placement.
//!
//! Instead of padding the document onto a larger chroma-key working canvas
//! (which shifted composition and camera framing in generated results),
//! PaintNode crops the submission to the largest provider-supported rectangle
//! that stays inside the document and covers the edit mask. When no single
//! supported crop can cover the mask (extreme documents such as 6000x480),
//! the edit splits into sequential parts: every completed part becomes
//! protected context for the next one, and all parts compose back into a
//! full-document result. The chosen geometry is recorded as `placement.json`
//! in the job folder so the crop-back/paste-back coordinates are auditable.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::ai::canvas::{
    ai_antigravity_image_capability, ai_codex_image_capability, ai_exact_working_canvas,
    ai_working_canvas_accepts_result_dimensions, antigravity_output_target, mask_pixel_coverage,
    AiWorkingCanvas, PixelRect, SupportedAspectRatio,
};
use crate::png::{decode_png_rgba, encode_rgba_png, is_png, png_dimensions_from_bytes};

/// Enlargements beyond this factor lose enough detail to justify an AI
/// restoration pass after a generate cover-crop.
pub(crate) const AI_RESTORE_UPSCALE_THRESHOLD: f64 = 1.25;

/// Every part is one full provider CLI run, so keep automatic splitting bounded.
const MAX_AI_EDIT_PARTS: usize = 16;

/// Neighboring part crops overlap at least this much so seams keep shared context.
const MIN_PART_OVERLAP: u32 = 16;
const MAX_PART_OVERLAP: u32 = 128;

/// Smallest cap on how far adjacent split tiles may overlap; the cap is 20% of
/// the document extent but never drops below this (except on a document already
/// narrower than it). A tile shape that would overlap its neighbour by more is
/// re-submitting — and re-billing the model for — a large redundant region: a
/// 2400-wide 4:1 tile on a 2600-wide document overlapped by 2200px, so the
/// second part fed the model an almost entirely already-generated frame just to
/// fill the last 200px. Shapes within the cap are preferred during tiling.
const MAX_SPLIT_OVERLAP_FLOOR: u32 = 200;

/// The overlap cap for one axis: at least [`MAX_SPLIT_OVERLAP_FLOOR`] (or the
/// whole extent on a tiny document), otherwise 20% of the document extent.
fn max_split_overlap(doc_extent: u32) -> u32 {
    (doc_extent / 5).max(MAX_SPLIT_OVERLAP_FLOOR.min(doc_extent))
}

/// Largest overlap between consecutive tiles laid at `origins` (evenly spaced,
/// non-decreasing) of length `tile_len` along one axis. Zero for a single tile.
fn axis_max_overlap(origins: &[u32], tile_len: u32) -> u32 {
    origins
        .windows(2)
        .map(|pair| tile_len.saturating_sub(pair[1] - pair[0]))
        .max()
        .unwrap_or(0)
}

/// Preferred protected context ring kept around the mask inside a crop.
const MASK_CONTEXT_MARGIN: u32 = 16;

const OVERVIEW_MAX_SIDE: u32 = 768;
const OVERVIEW_OUTLINE_THICKNESS: u32 = 3;
const OVERVIEW_OUTLINE_COLOR: image::Rgba<u8> = image::Rgba([255, 48, 48, 255]);
const UNKNOWN_EDIT_FILL: image::Rgba<u8> = image::Rgba([139, 143, 152, 255]);
const AI_PART_DRIFT_MAX_SHIFT: i32 = 16;
const AI_PART_DRIFT_TARGET_SAMPLES: usize = 80_000;
const AI_PART_DRIFT_MIN_SAMPLES: u64 = 2_048;
const AI_PART_DRIFT_MIN_SCORE_GAIN: f64 = 0.012;
const AI_PART_DRIFT_MIN_CORRELATION: f64 = 0.03;
const AI_PART_DRIFT_MIN_EDGE_SAMPLES: u64 = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiEditProvider {
    Codex,
    Antigravity,
}

impl AiEditProvider {
    fn label(self) -> &'static str {
        match self {
            AiEditProvider::Codex => "codex",
            AiEditProvider::Antigravity => "antigravity",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiFillMethod {
    Auto,
    ExactInPlace,
    WideCover,
    WideStarterContinue,
    BalancedStrips,
}

impl AiFillMethod {
    fn label(self) -> &'static str {
        match self {
            AiFillMethod::Auto => "auto",
            AiFillMethod::ExactInPlace => "exactInPlace",
            AiFillMethod::WideCover => "wideCover",
            AiFillMethod::WideStarterContinue => "wideStarterContinue",
            AiFillMethod::BalancedStrips => "balancedStrips",
        }
    }
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiFillRedundancy {
    Low,
    Medium,
    High,
}

impl AiFillRedundancy {
    fn label(self) -> &'static str {
        match self {
            AiFillRedundancy::Low => "low",
            AiFillRedundancy::Medium => "medium",
            AiFillRedundancy::High => "high",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AiEditPart {
    /// Where this part's generated pixels paste into the PaintNode document.
    pub(crate) crop: PixelRect,
    /// Where the document paste rect sits inside the provider input frame.
    /// Exact in-place parts use (0, 0, crop.width, crop.height); wide-cover
    /// parts can ask the provider to see a taller/wider frame and paste only
    /// this window back into the document.
    pub(crate) input_paste_rect: PixelRect,
    /// Submission geometry for this provider request.
    pub(crate) working: AiWorkingCanvas,
}

#[derive(Clone, Debug)]
pub(crate) struct AiEditPlacement {
    pub(crate) provider: AiEditProvider,
    pub(crate) method: AiFillMethod,
    pub(crate) redundancy: AiFillRedundancy,
    pub(crate) document_dimensions: (u32, u32),
    pub(crate) mask_bounds: PixelRect,
    pub(crate) parts: Vec<AiEditPart>,
}

impl AiEditPlacement {
    pub(crate) fn is_split(&self) -> bool {
        self.parts.len() > 1
    }

    /// Subdirectory for a part's job files, or `None` when the single part
    /// lives directly in the job folder (the layout providers used before).
    pub(crate) fn part_dir_name(&self, part_index: usize) -> Option<String> {
        self.is_split().then(|| format!("part-{}", part_index + 1))
    }
}

fn ai_edit_part(crop: PixelRect, aspect_label: &str) -> AiEditPart {
    let input_paste_rect = PixelRect {
        x: 0,
        y: 0,
        width: crop.width,
        height: crop.height,
    };
    ai_edit_part_with_input(
        crop,
        (crop.width, crop.height),
        input_paste_rect,
        aspect_label,
    )
}

fn ai_edit_part_with_input(
    crop: PixelRect,
    input_dimensions: (u32, u32),
    input_paste_rect: PixelRect,
    aspect_label: &str,
) -> AiEditPart {
    AiEditPart {
        crop,
        input_paste_rect,
        working: ai_exact_working_canvas(input_dimensions, aspect_label),
    }
}

struct CoverageGrid {
    width: u32,
    height: u32,
    coverage: Vec<u8>,
}

impl CoverageGrid {
    fn from_mask(mask: &image::RgbaImage) -> Self {
        let (width, height) = mask.dimensions();
        let mut coverage = vec![0_u8; width as usize * height as usize];
        for (x, y, pixel) in mask.enumerate_pixels() {
            coverage[y as usize * width as usize + x as usize] = mask_pixel_coverage(pixel);
        }
        Self {
            width,
            height,
            coverage,
        }
    }

    fn full(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            coverage: vec![255_u8; width as usize * height as usize],
        }
    }

    fn empty(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            coverage: vec![0_u8; width as usize * height as usize],
        }
    }

    /// Mark every pixel of `rect` as covered.
    fn mark_rect(&mut self, rect: PixelRect) {
        let rect = self.clamped(rect);
        for y in rect.y..rect.y + rect.height {
            let row = y as usize * self.width as usize;
            for x in rect.x..rect.x + rect.width {
                self.coverage[row + x as usize] = 255;
            }
        }
    }

    fn is_covered(&self, x: u32, y: u32) -> bool {
        x < self.width
            && y < self.height
            && self.coverage[y as usize * self.width as usize + x as usize] > 0
    }

    fn bounds(&self) -> Option<PixelRect> {
        let mut min_x = u32::MAX;
        let mut min_y = u32::MAX;
        let mut max_x = 0_u32;
        let mut max_y = 0_u32;
        let mut any = false;
        for y in 0..self.height {
            let row = y as usize * self.width as usize;
            for x in 0..self.width {
                if self.coverage[row + x as usize] == 0 {
                    continue;
                }
                any = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
        any.then(|| PixelRect {
            x: min_x,
            y: min_y,
            width: max_x - min_x + 1,
            height: max_y - min_y + 1,
        })
    }

    fn clamped(&self, rect: PixelRect) -> PixelRect {
        let x = rect.x.min(self.width);
        let y = rect.y.min(self.height);
        PixelRect {
            x,
            y,
            width: rect.width.min(self.width - x),
            height: rect.height.min(self.height - y),
        }
    }

    fn any_in(&self, rect: PixelRect) -> bool {
        let rect = self.clamped(rect);
        for y in rect.y..rect.y + rect.height {
            let row = y as usize * self.width as usize;
            for x in rect.x..rect.x + rect.width {
                if self.coverage[row + x as usize] > 0 {
                    return true;
                }
            }
        }
        false
    }

    fn clear_rect(&mut self, rect: PixelRect) {
        let rect = self.clamped(rect);
        for y in rect.y..rect.y + rect.height {
            let row = y as usize * self.width as usize;
            for x in rect.x..rect.x + rect.width {
                self.coverage[row + x as usize] = 0;
            }
        }
    }
}

fn expand_rect(rect: PixelRect, margin: u32, dimensions: (u32, u32)) -> PixelRect {
    let x0 = rect.x.saturating_sub(margin);
    let y0 = rect.y.saturating_sub(margin);
    let x1 = (rect.x + rect.width)
        .saturating_add(margin)
        .min(dimensions.0);
    let y1 = (rect.y + rect.height)
        .saturating_add(margin)
        .min(dimensions.1);
    PixelRect {
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
    }
}

fn covers(min_dimensions: Option<(u32, u32)>, dimensions: (u32, u32)) -> bool {
    min_dimensions
        .map(|(min_width, min_height)| dimensions.0 >= min_width && dimensions.1 >= min_height)
        .unwrap_or(true)
}

fn floor_to_multiple(value: u32, multiple: u32) -> u32 {
    value / multiple * multiple
}

fn aspect_clamped(mut width: u32, mut height: u32, max_aspect: u32) -> (u32, u32) {
    if width > height.saturating_mul(max_aspect) {
        width = height * max_aspect;
    }
    if height > width.saturating_mul(max_aspect) {
        height = width * max_aspect;
    }
    (width, height)
}

fn aspect_error(document: (u32, u32), dimensions: (u32, u32)) -> u64 {
    (u64::from(dimensions.0) * u64::from(document.1))
        .abs_diff(u64::from(dimensions.1) * u64::from(document.0))
}

fn codex_crop_dimensions(
    document: (u32, u32),
    min_dimensions: Option<(u32, u32)>,
) -> Option<(u32, u32, String)> {
    let codex = ai_codex_image_capability();
    let max_aspect = codex.max_aspect_ratio.max(1);
    let multiple = codex.dimension_multiple.max(1);
    let exact = aspect_clamped(
        floor_to_multiple(document.0, multiple),
        floor_to_multiple(document.1, multiple),
        max_aspect,
    );
    if exact.0 > 0 && exact.1 > 0 && covers(min_dimensions, exact) {
        return Some((exact.0, exact.1, "codex".into()));
    }
    // The model only outputs multiple-of-`multiple` dimensions, but it can
    // approximate any aspect ratio; PaintNode resizes same-ratio results back.
    let free = aspect_clamped(document.0, document.1, max_aspect);
    (free.0 > 0 && free.1 > 0 && covers(min_dimensions, free))
        .then(|| (free.0, free.1, "codex-crop".into()))
}

/// Split-tile shapes for Codex. Codex renders any dimensions (results resize
/// back), so unlike Antigravity's fixed grids it offers a continuous ladder of
/// full-short-extent tiles — from the portrait aspect limit up to the landscape
/// limit, on the dimension grid, capped to the document's long extent. A ladder
/// (rather than one shape) lets tiling pick a wide best-fit anchor and a smaller
/// finisher: a 2600x600 fill becomes an 1800x600 (3:1) tile plus a snug
/// finisher instead of three uniform strips. Every tile fills the short axis in
/// one strip, so a wide document stays a single row.
fn codex_split_tile_candidates(document: (u32, u32)) -> Vec<(u32, u32, String)> {
    let codex = ai_codex_image_capability();
    let max_aspect = codex.max_aspect_ratio.max(1);
    let step = codex.dimension_multiple.max(1);
    let split_horizontally = document.0 >= document.1;
    let short = if split_horizontally {
        document.1
    } else {
        document.0
    };
    let long = if split_horizontally {
        document.0
    } else {
        document.1
    };
    if short == 0 || long == 0 {
        return Vec::new();
    }
    let min_long = (short / max_aspect).max(1);
    let max_long = short.saturating_mul(max_aspect).min(long);
    let shape = |long_dim: u32| {
        if split_horizontally {
            (long_dim, short, "codex-crop".to_string())
        } else {
            (short, long_dim, "codex-crop".to_string())
        }
    };
    let mut candidates = Vec::new();
    let mut long_dim = min_long.div_ceil(step) * step;
    while long_dim <= max_long {
        candidates.push(shape(long_dim));
        long_dim += step;
    }
    // Always offer the widest anchor even when it is off the dimension grid.
    if max_long >= min_long
        && candidates
            .last()
            .map(|(width, height, _)| if split_horizontally { *width } else { *height })
            != Some(max_long)
    {
        candidates.push(shape(max_long));
    }
    candidates
}

fn gcd(a: u32, b: u32) -> u32 {
    let (mut x, mut y) = (a.max(1), b.max(1));
    while y != 0 {
        (x, y) = (y, x % y);
    }
    x
}

/// Reduce a capability output grid to its exact ratio unit and the unit
/// count of the 1K grid (e.g. 1584x672 -> unit 33x14, 1K step 48).
fn ratio_unit(ratio: &SupportedAspectRatio) -> ((u32, u32), u32) {
    let step = gcd(ratio.width, ratio.height);
    ((ratio.width / step, ratio.height / step), step)
}

/// Antigravity crops must match the model's REAL output grid ratio (e.g.
/// "21:9" outputs 1584x672 = 33:14, not 7:3): a crop the model cannot map
/// onto its output grid forces it to reframe the scene instead of editing
/// in place. Crops are also capped at the 4K output grid (4x the 1K step)
/// so results only ever downscale back onto the document — upscaling a
/// model result would smear protected pixels; larger documents split into
/// parts instead.
fn ratio_crop_candidates(document: (u32, u32)) -> Vec<(u32, u32, String)> {
    ai_antigravity_image_capability()
        .aspect_ratios
        .iter()
        .filter_map(|ratio| {
            let (unit, step) = ratio_unit(ratio);
            let units = (document.0 / unit.0).min(document.1 / unit.1).min(step * 4);
            (units > 0).then(|| (unit.0 * units, unit.1 * units, ratio.label.clone()))
        })
        .collect()
}

fn ratio_crop_dimensions(
    document: (u32, u32),
    min_dimensions: Option<(u32, u32)>,
) -> Option<(u32, u32, String)> {
    ratio_crop_candidates(document)
        .into_iter()
        .filter(|(width, height, _)| covers(min_dimensions, (*width, *height)))
        .max_by_key(|(width, height, _)| {
            (
                u64::from(*width) * u64::from(*height),
                std::cmp::Reverse(aspect_error(document, (*width, *height))),
            )
        })
}

fn single_crop_dimensions(
    provider: AiEditProvider,
    document: (u32, u32),
    min_dimensions: (u32, u32),
) -> Option<(u32, u32, String)> {
    match provider {
        AiEditProvider::Codex => codex_crop_dimensions(document, Some(min_dimensions)),
        AiEditProvider::Antigravity => ratio_crop_dimensions(document, Some(min_dimensions)),
    }
}

/// Place a crop of `crop_len` on one axis so it covers the target span, sits
/// inside the document, and stays as centered on the target as possible.
/// Requires `crop_len >= target_len` and `crop_len <= doc`.
fn axis_position(doc: u32, target_start: u32, target_len: u32, crop_len: u32) -> u32 {
    let doc_max = doc.saturating_sub(crop_len);
    let lo = (target_start + target_len)
        .saturating_sub(crop_len)
        .min(doc_max);
    let hi = target_start.min(doc_max);
    let ideal = (target_start + target_len / 2).saturating_sub(crop_len / 2);
    ideal.clamp(lo.min(hi), hi.max(lo))
}

fn position_crop(document: (u32, u32), target: PixelRect, dimensions: (u32, u32)) -> PixelRect {
    PixelRect {
        x: axis_position(document.0, target.x, target.width, dimensions.0),
        y: axis_position(document.1, target.y, target.height, dimensions.1),
        width: dimensions.0,
        height: dimensions.1,
    }
}

fn tile_axis_origins(doc: u32, target_start: u32, target_len: u32, tile: u32) -> Vec<u32> {
    let doc_max = doc.saturating_sub(tile);
    if tile >= target_len {
        return vec![axis_position(doc, target_start, target_len, tile)];
    }
    let overlap = (tile / 8)
        .clamp(MIN_PART_OVERLAP, MAX_PART_OVERLAP)
        .min(tile.saturating_sub(1));
    let stride = (tile - overlap).max(1);
    let span = target_len - tile;
    let count = u64::from(span).div_ceil(u64::from(stride)) + 1;
    (0..count)
        .map(|index| {
            let offset = (u64::from(span) * index / (count - 1)) as u32;
            (target_start + offset).min(doc_max)
        })
        .collect()
}

fn split_tile_candidates(
    provider: AiEditProvider,
    document: (u32, u32),
) -> Vec<(u32, u32, String)> {
    match provider {
        AiEditProvider::Codex => codex_split_tile_candidates(document),
        AiEditProvider::Antigravity => ratio_crop_candidates(document),
    }
}

/// Choose the tile shape that needs the fewest parts (largest area on ties)
/// and lay tiles over the target region in reading order.
fn best_tiling(
    candidates: Vec<(u32, u32, String)>,
    document: (u32, u32),
    target: PixelRect,
) -> Result<Vec<(PixelRect, String)>, String> {
    let overlap_cap = (max_split_overlap(document.0), max_split_overlap(document.1));
    let mut best: Option<(bool, usize, usize, u64, Vec<PixelRect>, String)> = None;
    for (tile_width, tile_height, label) in candidates {
        let xs = tile_axis_origins(document.0, target.x, target.width, tile_width);
        let ys = tile_axis_origins(document.1, target.y, target.height, tile_height);
        let count = xs.len() * ys.len();
        let area = u64::from(tile_width) * u64::from(tile_height);
        // A shape whose tiles overlap past the cap re-bills a large redundant
        // region; prefer shapes within the cap, and only fall back to an
        // over-cap shape when nothing else covers the document.
        let over_cap = axis_max_overlap(&xs, tile_width) > overlap_cap.0
            || axis_max_overlap(&ys, tile_height) > overlap_cap.1;
        // Split the document's long axis, keeping the short axis whole where a
        // shape allows it: a wide document tiles into full-height vertical
        // strips, not horizontal bands cut through the scene. This counts the
        // tiles laid along the short axis (fewer is better).
        let short_axis_tiles = if document.0 >= document.1 {
            ys.len()
        } else {
            xs.len()
        };
        let is_better = best
            .as_ref()
            .map(|(best_over_cap, best_short, best_count, best_area, _, _)| {
                (over_cap, short_axis_tiles, count, std::cmp::Reverse(area))
                    < (
                        *best_over_cap,
                        *best_short,
                        *best_count,
                        std::cmp::Reverse(*best_area),
                    )
            })
            .unwrap_or(true);
        if !is_better {
            continue;
        }
        let mut rects = Vec::with_capacity(count);
        for y in &ys {
            for x in &xs {
                rects.push(PixelRect {
                    x: *x,
                    y: *y,
                    width: tile_width,
                    height: tile_height,
                });
            }
        }
        best = Some((over_cap, short_axis_tiles, count, area, rects, label));
    }
    best.map(|(_, _, _, _, rects, label)| {
        rects
            .into_iter()
            .map(|rect| (rect, label.clone()))
            .collect()
    })
    .ok_or_else(|| "No supported AI crop shape fits this document.".into())
}

fn split_part_rects(
    provider: AiEditProvider,
    document: (u32, u32),
    target: PixelRect,
) -> Result<Vec<(PixelRect, String)>, String> {
    let candidates = split_tile_candidates(provider, document);
    let uniform = best_tiling(candidates.clone(), document, target)?;
    // A heterogeneous cover (a wide best-fit anchor plus smaller finishers) can
    // beat the uniform grid on a wide/tall document. Use it when it needs fewer
    // parts, or the same parts with less total submitted area (a leaner cover
    // the model is billed less for).
    match heterogeneous_tiling(&candidates, document, target) {
        Some(hetero)
            if hetero.len() < uniform.len()
                || (hetero.len() == uniform.len()
                    && submitted_area(&hetero) < submitted_area(&uniform)) =>
        {
            Ok(hetero)
        }
        _ => Ok(uniform),
    }
}

/// Total pixel area a tiling submits to the model (sum of tile areas). Overlaps
/// count twice, so this is the quantity the provider is billed for.
fn submitted_area(tiling: &[(PixelRect, String)]) -> u64 {
    tiling
        .iter()
        .map(|(rect, _)| u64::from(rect.width) * u64::from(rect.height))
        .sum()
}

/// Greedy heterogeneous cover of a wide (or tall) target's long axis using
/// different supported tile sizes — a large anchor tile for the bulk plus a
/// smaller tile to finish — so a 2600x600 fill becomes a 2400x600 (4:1) tile
/// plus a 600x600 (1:1) tile instead of three uniform 1075x600 strips. It tiles
/// the long axis only and keeps the short axis whole, so it applies when the
/// target spans the full short axis; it returns `None` (fall back to the
/// uniform grid) otherwise, or when the cover would exceed the overlap cap.
fn heterogeneous_tiling(
    candidates: &[(u32, u32, String)],
    document: (u32, u32),
    target: PixelRect,
) -> Option<Vec<(PixelRect, String)>> {
    let split_horizontally = document.0 >= document.1;
    let (doc_long, long_start, long_len, short_extent, spans_short) = if split_horizontally {
        (
            document.0,
            target.x,
            target.width,
            document.1,
            target.y == 0 && target.height == document.1,
        )
    } else {
        (
            document.1,
            target.y,
            target.height,
            document.0,
            target.x == 0 && target.width == document.0,
        )
    };
    if !spans_short || long_len == 0 {
        return None;
    }
    // Tiles whose short-axis dimension exactly fills the document's short extent
    // (each a single full strip), by their long-axis dimension.
    let mut tiles: Vec<(u32, &str)> = candidates
        .iter()
        .filter_map(|(tile_width, tile_height, label)| {
            let (long_dim, short_dim) = if split_horizontally {
                (*tile_width, *tile_height)
            } else {
                (*tile_height, *tile_width)
            };
            (short_dim == short_extent && long_dim > 0 && long_dim <= doc_long)
                .then_some((long_dim, label.as_str()))
        })
        .collect();
    if tiles.is_empty() {
        return None;
    }
    tiles.sort_unstable_by_key(|(long_dim, _)| *long_dim);
    let cap = max_split_overlap(doc_long);
    let end = long_start + long_len;
    // Blendable overlap a tile wants with its neighbour (mirrors the uniform
    // tiling's context band).
    let context_overlap = |long_dim: u32| {
        (long_dim / 8)
            .clamp(MIN_PART_OVERLAP, MAX_PART_OVERLAP)
            .min(long_dim.saturating_sub(1))
    };

    let mut placements: Vec<(u32, u32, &str)> = Vec::new();
    let mut frontier = long_start;
    while frontier < end {
        if placements.len() > MAX_AI_EDIT_PARTS {
            return None;
        }
        // Prefer to finish: a tile that bridges to the target end with a
        // blendable, capped overlap.
        let bridge = |index: usize| {
            let (long_dim, label) = tiles[index];
            if long_dim < end.saturating_sub(frontier) {
                return None; // too small to reach the end from the frontier
            }
            let start = end.saturating_sub(long_dim).min(frontier); // flush to the end, still contiguous
            if let Some(&(prev_start, prev_dim, _)) = placements.last() {
                let overlap = (prev_start + prev_dim).saturating_sub(start);
                if overlap < context_overlap(long_dim) || overlap > cap {
                    return None;
                }
            }
            Some((start, long_dim, label))
        };
        // A finisher joining already-placed content takes the LARGEST tile the
        // overlap cap allows, not the smallest: a snug tail tile carries almost
        // no finished context, and the image model then composes an unrelated
        // standalone picture instead of continuing the scene. With no previous
        // placement there is no context to gain, so keep the smallest cover.
        let finish = if placements.is_empty() {
            (0..tiles.len()).find_map(bridge)
        } else {
            (0..tiles.len()).rev().find_map(bridge)
        };
        if let Some(place) = finish {
            placements.push(place);
            break;
        }
        // Otherwise advance with the largest tile, keeping a context overlap.
        let &(long_dim, label) = tiles.last().unwrap();
        let start = placements
            .last()
            .map(|&(prev_start, prev_dim, _)| {
                (prev_start + prev_dim).saturating_sub(context_overlap(long_dim))
            })
            .unwrap_or(long_start)
            .min(doc_long.saturating_sub(long_dim));
        let new_frontier = start + long_dim;
        if new_frontier <= frontier {
            return None; // no forward progress; fall back to the uniform grid
        }
        placements.push((start, long_dim, label));
        frontier = new_frontier;
    }

    // A clamped last advance could still overshoot the cap; reject it so the
    // uniform grid wins instead.
    for pair in placements.windows(2) {
        let (prev_start, prev_dim, _) = pair[0];
        let (next_start, _, _) = pair[1];
        if (prev_start + prev_dim).saturating_sub(next_start) > cap {
            return None;
        }
    }

    Some(
        placements
            .into_iter()
            .map(|(start, long_dim, label)| {
                let rect = if split_horizontally {
                    PixelRect {
                        x: start,
                        y: 0,
                        width: long_dim,
                        height: short_extent,
                    }
                } else {
                    PixelRect {
                        x: 0,
                        y: start,
                        width: short_extent,
                        height: long_dim,
                    }
                };
                (rect, label.to_string())
            })
            .collect(),
    )
}

/// Restoration tile shapes: capped at the provider's native output size so
/// every regenerated tile carries model-native detail density.
fn restore_tile_candidates(
    provider: AiEditProvider,
    document: (u32, u32),
) -> Vec<(u32, u32, String)> {
    match provider {
        AiEditProvider::Codex => {
            let codex = ai_codex_image_capability();
            let cap = codex.restore_tile_side.max(1);
            let tile = aspect_clamped(
                document.0.min(cap),
                document.1.min(cap),
                codex.max_aspect_ratio.max(1),
            );
            (tile.0 > 0 && tile.1 > 0)
                .then(|| (tile.0, tile.1, "codex-crop".to_string()))
                .into_iter()
                .collect()
        }
        AiEditProvider::Antigravity => {
            let capability = ai_antigravity_image_capability();
            let cap = capability.restore_tile_side.max(1);
            // Restore tiles must also land on the model's real output grids,
            // or every regenerated tile drifts off its frame.
            capability
                .aspect_ratios
                .iter()
                .filter_map(|ratio| {
                    let (unit, _) = ratio_unit(ratio);
                    let units = (document.0 / unit.0)
                        .min(document.1 / unit.1)
                        .min(cap / unit.0.max(unit.1));
                    (units > 0).then(|| (unit.0 * units, unit.1 * units, ratio.label.clone()))
                })
                .collect()
        }
    }
}

/// Plan an AI detail-restoration pass: tiles capped at the provider's native
/// output size covering the whole image, run sequentially like any other
/// placement so earlier restored tiles become context for later ones.
pub(crate) fn plan_ai_restore_placement(
    provider: AiEditProvider,
    document_dimensions: (u32, u32),
    label: &str,
) -> Result<AiEditPlacement, String> {
    let (width, height) = document_dimensions;
    if width == 0 || height == 0 {
        return Err(format!("{label} image dimensions are invalid."));
    }
    let full = PixelRect {
        x: 0,
        y: 0,
        width,
        height,
    };
    let tiling = best_tiling(
        restore_tile_candidates(provider, document_dimensions),
        document_dimensions,
        full,
    )?;
    if tiling.len() > MAX_AI_EDIT_PARTS {
        return Err(format!(
            "{label} would need {} AI restoration parts for a {width}x{height} image. Use a smaller scale.",
            tiling.len()
        ));
    }
    Ok(AiEditPlacement {
        provider,
        method: AiFillMethod::ExactInPlace,
        redundancy: AiFillRedundancy::Medium,
        document_dimensions,
        mask_bounds: full,
        parts: tiling
            .into_iter()
            .map(|(rect, aspect_label)| ai_edit_part(rect, &aspect_label))
            .collect(),
    })
}

/// Output dimensions for an AI upscale request (100% = original size).
pub(crate) fn ai_upscale_target_dimensions(
    source: (u32, u32),
    scale_percent: u32,
) -> Result<(u32, u32), String> {
    if !(100..=1000).contains(&scale_percent) {
        return Err("AI upscale scale must be between 100% and 1000%.".into());
    }
    let width = (u64::from(source.0) * u64::from(scale_percent) / 100) as u32;
    let height = (u64::from(source.1) * u64::from(scale_percent) / 100) as u32;
    if width == 0 || height == 0 {
        return Err("AI upscale output dimensions are invalid.".into());
    }
    Ok((width, height))
}

/// Lanczos-resize a PNG to the target dimensions (same aspect ratio expected).
pub(crate) fn resize_png_to_dimensions(
    bytes: &[u8],
    target: (u32, u32),
    label: &str,
) -> Result<Vec<u8>, String> {
    let image = decode_png_rgba(bytes, label)?;
    if image.dimensions() == target {
        return Ok(bytes.to_vec());
    }
    let resized = image::imageops::resize(
        &image,
        target.0,
        target.1,
        image::imageops::FilterType::Lanczos3,
    );
    encode_rgba_png(resized, label)
}

/// Center-crop the PNG to the target aspect ratio and resize it to the target
/// dimensions (no distortion). Returns the normalized PNG, the source
/// dimensions, and the enlargement factor that was applied (1.0 = none/shrink).
pub(crate) fn cover_crop_png_to_dimensions(
    bytes: &[u8],
    target: (u32, u32),
    label: &str,
) -> Result<(Vec<u8>, (u32, u32), f64), String> {
    let image = decode_png_rgba(bytes, label)?;
    let source_dimensions = image.dimensions();
    if source_dimensions == target {
        return Ok((bytes.to_vec(), source_dimensions, 1.0));
    }
    let (source_width, source_height) = source_dimensions;
    if source_width == 0 || source_height == 0 || target.0 == 0 || target.1 == 0 {
        return Err(format!("{label} dimensions are invalid."));
    }
    // Widest crop of the source that matches the target ratio.
    let mut crop_width = source_width;
    let mut crop_height =
        ((u64::from(source_width) * u64::from(target.1)) / u64::from(target.0)) as u32;
    if crop_height > source_height {
        crop_height = source_height;
        crop_width =
            ((u64::from(source_height) * u64::from(target.0)) / u64::from(target.1)).max(1) as u32;
    }
    let crop_height = crop_height.max(1);
    let crop = PixelRect {
        x: (source_width - crop_width) / 2,
        y: (source_height - crop_height) / 2,
        width: crop_width,
        height: crop_height,
    };
    let cropped =
        image::imageops::crop_imm(&image, crop.x, crop.y, crop.width, crop.height).to_image();
    let resized = image::imageops::resize(
        &cropped,
        target.0,
        target.1,
        image::imageops::FilterType::Lanczos3,
    );
    let upscale_factor = f64::from(target.0) / f64::from(crop_width);
    Ok((
        encode_rgba_png(resized, label)?,
        source_dimensions,
        upscale_factor.max(1.0),
    ))
}

pub(crate) fn plan_ai_edit_placement(
    provider: AiEditProvider,
    document_dimensions: (u32, u32),
    mask_png: &[u8],
    label: &str,
) -> Result<AiEditPlacement, String> {
    let mask = decode_png_rgba(mask_png, label)?;
    if mask.dimensions() != document_dimensions {
        return Err(format!(
            "{label} mask must match the document dimensions. Document is {}x{}, mask is {}x{}.",
            document_dimensions.0,
            document_dimensions.1,
            mask.width(),
            mask.height()
        ));
    }
    let mut grid = CoverageGrid::from_mask(&mask);
    let mask_bounds = grid
        .bounds()
        .ok_or_else(|| format!("{label} mask has no editable pixels."))?;
    let target = expand_rect(mask_bounds, MASK_CONTEXT_MARGIN, document_dimensions);

    // Prefer a crop that keeps a protected context ring around the mask; fall
    // back to covering the bare mask bounds before splitting into parts.
    for candidate_target in [target, mask_bounds] {
        let Some((width, height, aspect_label)) = single_crop_dimensions(
            provider,
            document_dimensions,
            (candidate_target.width, candidate_target.height),
        ) else {
            continue;
        };
        let crop = position_crop(document_dimensions, candidate_target, (width, height));
        return Ok(AiEditPlacement {
            provider,
            method: AiFillMethod::ExactInPlace,
            redundancy: AiFillRedundancy::Medium,
            document_dimensions,
            mask_bounds,
            parts: vec![ai_edit_part(crop, &aspect_label)],
        });
    }

    let rects = split_part_rects(provider, document_dimensions, target)?;
    let mut parts = Vec::new();
    for (rect, aspect_label) in rects {
        // A part owns every masked pixel inside its crop, so later parts skip
        // those pixels and tiles whose mask region is already owned drop out.
        if !grid.any_in(rect) {
            continue;
        }
        grid.clear_rect(rect);
        parts.push(ai_edit_part(rect, &aspect_label));
    }
    if parts.len() > MAX_AI_EDIT_PARTS {
        return Err(format!(
            "{label} would need {} AI sub-tasks to cover this mask on a {}x{} document. Reduce the masked area or run it in smaller pieces.",
            parts.len(),
            document_dimensions.0,
            document_dimensions.1
        ));
    }
    Ok(AiEditPlacement {
        provider,
        method: AiFillMethod::ExactInPlace,
        redundancy: AiFillRedundancy::Medium,
        document_dimensions,
        mask_bounds,
        parts,
    })
}

fn mask_is_mostly_full(mask_bounds: PixelRect, document: (u32, u32)) -> bool {
    u64::from(mask_bounds.width) * 100 >= u64::from(document.0) * 80
        && u64::from(mask_bounds.height) * 100 >= u64::from(document.1) * 80
}

fn is_wide_or_tall(document: (u32, u32)) -> bool {
    let long = document.0.max(document.1);
    let short = document.0.min(document.1).max(1);
    u64::from(long) * 100 >= u64::from(short) * 160
}

fn first_part_long_axis_coverage(placement: &AiEditPlacement) -> f64 {
    let Some(first) = placement.parts.first() else {
        return 0.0;
    };
    if placement.document_dimensions.0 >= placement.document_dimensions.1 {
        f64::from(first.crop.width) / f64::from(placement.document_dimensions.0.max(1))
    } else {
        f64::from(first.crop.height) / f64::from(placement.document_dimensions.1.max(1))
    }
}

fn antigravity_wide_cover_ratio(
    document: (u32, u32),
    forced_label: Option<&str>,
) -> Option<SupportedAspectRatio> {
    if let Some(label) = forced_label
        .map(str::trim)
        .filter(|label| !label.is_empty())
    {
        if let Some(ratio) = ai_antigravity_image_capability()
            .aspect_ratios
            .iter()
            .find(|ratio| ratio.label == label)
        {
            return Some(ratio.clone());
        }
    }
    let target = f64::from(document.0) / f64::from(document.1.max(1));
    let landscape = document.0 >= document.1;
    let capability = ai_antigravity_image_capability();
    let mut directional: Vec<&SupportedAspectRatio> = capability
        .aspect_ratios
        .iter()
        .filter(|ratio| {
            let aspect = f64::from(ratio.width) / f64::from(ratio.height.max(1));
            if landscape {
                aspect <= target
            } else {
                aspect >= target
            }
        })
        .collect();
    directional.sort_by(|a, b| {
        let a_aspect = f64::from(a.width) / f64::from(a.height.max(1));
        let b_aspect = f64::from(b.width) / f64::from(b.height.max(1));
        if landscape {
            b_aspect.total_cmp(&a_aspect)
        } else {
            a_aspect.total_cmp(&b_aspect)
        }
    });
    directional
        .into_iter()
        .next()
        .or_else(|| {
            capability
                .aspect_ratios
                .iter()
                .min_by_key(|ratio| aspect_error(document, (ratio.width, ratio.height)))
        })
        .cloned()
}

fn cover_frame_for_ratio(target: (u32, u32), unit: (u32, u32)) -> (u32, u32) {
    let units = target
        .0
        .div_ceil(unit.0)
        .max(target.1.div_ceil(unit.1))
        .max(1);
    (unit.0 * units, unit.1 * units)
}

fn centered_paste_rect(input_dimensions: (u32, u32), crop: PixelRect) -> PixelRect {
    PixelRect {
        x: input_dimensions.0.saturating_sub(crop.width) / 2,
        y: input_dimensions.1.saturating_sub(crop.height) / 2,
        width: crop.width,
        height: crop.height,
    }
}

fn plan_ai_wide_cover_placement(
    provider: AiEditProvider,
    redundancy: AiFillRedundancy,
    document_dimensions: (u32, u32),
    mask_bounds: PixelRect,
    forced_aspect_label: Option<&str>,
) -> Result<AiEditPlacement, String> {
    let crop = PixelRect {
        x: 0,
        y: 0,
        width: document_dimensions.0,
        height: document_dimensions.1,
    };
    let (input_dimensions, aspect_label) = match provider {
        AiEditProvider::Antigravity => {
            let ratio = antigravity_wide_cover_ratio(document_dimensions, forced_aspect_label)
                .ok_or_else(|| {
                    "No Antigravity image ratio is available for wide-cover fill.".to_string()
                })?;
            let (unit, _) = ratio_unit(&ratio);
            let dimensions = cover_frame_for_ratio(document_dimensions, unit);
            let (_, output) =
                antigravity_output_target(&ratio.label, dimensions).ok_or_else(|| {
                    "No Antigravity output tier is available for wide-cover fill.".to_string()
                })?;
            if output.0 < dimensions.0 || output.1 < dimensions.1 {
                return Err(format!(
                    "Wide-cover fill would need a {}x{} provider frame, larger than Antigravity can return for {}.",
                    dimensions.0, dimensions.1, ratio.label
                ));
            }
            (dimensions, ratio.label)
        }
        AiEditProvider::Codex => {
            let codex = ai_codex_image_capability();
            let max_aspect = codex.max_aspect_ratio.max(1);
            let dimensions = if document_dimensions.0 >= document_dimensions.1 {
                (
                    document_dimensions.0,
                    document_dimensions
                        .0
                        .div_ceil(max_aspect)
                        .max(document_dimensions.1),
                )
            } else {
                (
                    document_dimensions
                        .1
                        .div_ceil(max_aspect)
                        .max(document_dimensions.0),
                    document_dimensions.1,
                )
            };
            (dimensions, "codex-crop".to_string())
        }
    };
    Ok(AiEditPlacement {
        provider,
        method: AiFillMethod::WideCover,
        redundancy,
        document_dimensions,
        mask_bounds,
        parts: vec![ai_edit_part_with_input(
            crop,
            input_dimensions,
            centered_paste_rect(input_dimensions, crop),
            &aspect_label,
        )],
    })
}

fn ratio_aspect(ratio: &SupportedAspectRatio) -> f64 {
    f64::from(ratio.width) / f64::from(ratio.height.max(1))
}

fn antigravity_directional_ratios(document: (u32, u32)) -> Vec<SupportedAspectRatio> {
    let target = f64::from(document.0) / f64::from(document.1.max(1));
    let landscape = document.0 >= document.1;
    let mut ratios: Vec<SupportedAspectRatio> = ai_antigravity_image_capability()
        .aspect_ratios
        .iter()
        .filter(|ratio| {
            let aspect = ratio_aspect(ratio);
            if landscape {
                aspect >= 1.0 && aspect <= target
            } else {
                aspect <= 1.0 && aspect >= target
            }
        })
        .cloned()
        .collect();
    ratios.sort_by(|a, b| {
        let a_aspect = ratio_aspect(a);
        let b_aspect = ratio_aspect(b);
        if landscape {
            b_aspect.total_cmp(&a_aspect)
        } else {
            a_aspect.total_cmp(&b_aspect)
        }
    });
    ratios
}

fn antigravity_frame_for_ratio(
    ratio: &SupportedAspectRatio,
    min_dimensions: (u32, u32),
) -> Option<(u32, u32, String)> {
    let (unit, _) = ratio_unit(ratio);
    let dimensions = cover_frame_for_ratio(min_dimensions, unit);
    let (_, output) = antigravity_output_target(&ratio.label, dimensions)?;
    (output.0 >= dimensions.0 && output.1 >= dimensions.1)
        .then(|| (dimensions.0, dimensions.1, ratio.label.clone()))
}

fn antigravity_directional_frame_candidates(
    document_dimensions: (u32, u32),
    min_oriented: (u32, u32),
    split_horizontally: bool,
) -> Vec<(u32, u32, String)> {
    let min_dimensions = if split_horizontally {
        min_oriented
    } else {
        (min_oriented.1, min_oriented.0)
    };
    antigravity_directional_ratios(document_dimensions)
        .iter()
        .filter_map(|ratio| antigravity_frame_for_ratio(ratio, min_dimensions))
        .collect()
}

fn oriented_part(
    document_dimensions: (u32, u32),
    split_horizontally: bool,
    start: u32,
    input_dimensions: (u32, u32),
    aspect_label: &str,
) -> AiEditPart {
    let (doc_long, doc_short) = if split_horizontally {
        (document_dimensions.0, document_dimensions.1)
    } else {
        (document_dimensions.1, document_dimensions.0)
    };
    let (input_long, _) = if split_horizontally {
        input_dimensions
    } else {
        (input_dimensions.1, input_dimensions.0)
    };
    let crop_long = input_long.min(doc_long.saturating_sub(start));
    let crop = if split_horizontally {
        PixelRect {
            x: start,
            y: 0,
            width: crop_long,
            height: doc_short,
        }
    } else {
        PixelRect {
            x: 0,
            y: start,
            width: doc_short,
            height: crop_long,
        }
    };
    let input_paste_rect = PixelRect {
        x: input_dimensions.0.saturating_sub(crop.width) / 2,
        y: input_dimensions.1.saturating_sub(crop.height) / 2,
        width: crop.width,
        height: crop.height,
    };
    ai_edit_part_with_input(crop, input_dimensions, input_paste_rect, aspect_label)
}

fn part_oriented_input_long(part: &AiEditPart, split_horizontally: bool) -> u32 {
    if split_horizontally {
        part.working.original_dimensions.0
    } else {
        part.working.original_dimensions.1
    }
}

fn part_oriented_crop_end(part: &AiEditPart, split_horizontally: bool) -> u32 {
    if split_horizontally {
        part.crop.x + part.crop.width
    } else {
        part.crop.y + part.crop.height
    }
}

fn starter_continuation_overlap(
    redundancy: AiFillRedundancy,
    doc_long: u32,
    previous_long: u32,
) -> u32 {
    let lean = (previous_long / 8)
        .clamp(MIN_PART_OVERLAP, MAX_PART_OVERLAP)
        .min(previous_long.saturating_sub(1));
    let target = match redundancy {
        AiFillRedundancy::Low => lean,
        AiFillRedundancy::Medium => lean.max(doc_long / 8),
        AiFillRedundancy::High => lean.max(doc_long / 4),
    };
    target.min(previous_long.saturating_sub(1))
}

fn plan_ai_wide_starter_continue_placement(
    provider: AiEditProvider,
    redundancy: AiFillRedundancy,
    document_dimensions: (u32, u32),
    mask_bounds: PixelRect,
) -> Result<AiEditPlacement, String> {
    if provider != AiEditProvider::Antigravity
        || !mask_is_mostly_full(mask_bounds, document_dimensions)
        || !is_wide_or_tall(document_dimensions)
    {
        return Err(
            "Wide-starter fill is only available for full wide/tall Antigravity masks.".to_string(),
        );
    }

    let split_horizontally = document_dimensions.0 >= document_dimensions.1;
    let (doc_long, doc_short) = if split_horizontally {
        (document_dimensions.0, document_dimensions.1)
    } else {
        (document_dimensions.1, document_dimensions.0)
    };
    let starter_ratio =
        antigravity_wide_cover_ratio(document_dimensions, None).ok_or_else(|| {
            "No Antigravity image ratio is available for wide-starter fill.".to_string()
        })?;
    let starter_min = if split_horizontally {
        (1, doc_short)
    } else {
        (doc_short, 1)
    };
    let starter_dimensions = antigravity_frame_for_ratio(&starter_ratio, starter_min)
        .map(|(width, height, _)| (width, height))
        .ok_or_else(|| {
            "No Antigravity output tier is available for wide-starter fill.".to_string()
        })?;

    let mut parts = vec![oriented_part(
        document_dimensions,
        split_horizontally,
        0,
        starter_dimensions,
        &starter_ratio.label,
    )];
    let mut covered_to = part_oriented_crop_end(parts.last().unwrap(), split_horizontally);
    while covered_to < doc_long {
        if parts.len() >= MAX_AI_EDIT_PARTS {
            return Err(format!(
                "Generative fill would need more than {MAX_AI_EDIT_PARTS} Antigravity starter parts."
            ));
        }
        let previous_long = part_oriented_input_long(parts.last().unwrap(), split_horizontally);
        let overlap = starter_continuation_overlap(redundancy, doc_long, previous_long);
        let needed_long = doc_long.saturating_sub(covered_to) + overlap;
        let candidates = antigravity_directional_frame_candidates(
            document_dimensions,
            (needed_long, doc_short),
            split_horizontally,
        );
        let chosen = candidates
            .iter()
            .filter(|(width, height, _)| {
                let long = if split_horizontally { *width } else { *height };
                long >= needed_long
            })
            .min_by_key(|(width, height, _)| u64::from(*width) * u64::from(*height))
            .or_else(|| {
                candidates.iter().max_by_key(
                    |(width, height, _)| {
                        if split_horizontally {
                            *width
                        } else {
                            *height
                        }
                    },
                )
            })
            .ok_or_else(|| {
                "No Antigravity image ratio is available for wide-starter continuation.".to_string()
            })?;
        let input_long = if split_horizontally {
            chosen.0
        } else {
            chosen.1
        };
        let start = if input_long >= doc_long.saturating_sub(covered_to) + overlap {
            doc_long.saturating_sub(input_long)
        } else {
            covered_to.saturating_sub(overlap)
        };
        if start > covered_to {
            return Err("Wide-starter continuation would leave a gap.".to_string());
        }
        parts.push(oriented_part(
            document_dimensions,
            split_horizontally,
            start,
            (chosen.0, chosen.1),
            &chosen.2,
        ));
        let next_covered_to = part_oriented_crop_end(parts.last().unwrap(), split_horizontally);
        if next_covered_to <= covered_to {
            return Err("Wide-starter continuation made no progress.".to_string());
        }
        covered_to = next_covered_to;
    }

    Ok(AiEditPlacement {
        provider,
        method: AiFillMethod::WideStarterContinue,
        redundancy,
        document_dimensions,
        mask_bounds,
        parts,
    })
}

fn plan_ai_codex_max_ratio_strips_placement(
    redundancy: AiFillRedundancy,
    document_dimensions: (u32, u32),
    mask_bounds: PixelRect,
) -> Result<AiEditPlacement, String> {
    if !mask_is_mostly_full(mask_bounds, document_dimensions)
        || !is_wide_or_tall(document_dimensions)
    {
        return Err("Codex max-ratio strips are only available for full wide/tall masks.".into());
    }

    let split_horizontally = document_dimensions.0 >= document_dimensions.1;
    let (doc_long, doc_short) = if split_horizontally {
        (document_dimensions.0, document_dimensions.1)
    } else {
        (document_dimensions.1, document_dimensions.0)
    };
    let codex = ai_codex_image_capability();
    let input_long = doc_short
        .saturating_mul(codex.max_aspect_ratio.max(1))
        .min(doc_long);
    if input_long == 0 || doc_short == 0 {
        return Err("Codex max-ratio strip dimensions are invalid.".into());
    }
    let input_dimensions = if split_horizontally {
        (input_long, doc_short)
    } else {
        (doc_short, input_long)
    };

    let mut parts = Vec::new();
    let mut covered_to = 0_u32;
    while covered_to < doc_long {
        if parts.len() >= MAX_AI_EDIT_PARTS {
            return Err(format!(
                "Generative fill would need more than {MAX_AI_EDIT_PARTS} Codex parts."
            ));
        }
        let start = if let Some(previous) = parts.last() {
            let previous_long = part_oriented_input_long(previous, split_horizontally);
            let overlap = starter_continuation_overlap(redundancy, doc_long, previous_long);
            let remaining = doc_long.saturating_sub(covered_to);
            if input_long >= remaining + overlap {
                doc_long.saturating_sub(input_long)
            } else {
                covered_to.saturating_sub(overlap)
            }
        } else {
            0
        };
        parts.push(oriented_part(
            document_dimensions,
            split_horizontally,
            start,
            input_dimensions,
            "codex-crop",
        ));
        let next_covered_to = part_oriented_crop_end(parts.last().unwrap(), split_horizontally);
        if next_covered_to <= covered_to {
            return Err("Codex max-ratio strips made no progress.".into());
        }
        covered_to = next_covered_to;
    }

    Ok(AiEditPlacement {
        provider: AiEditProvider::Codex,
        method: AiFillMethod::BalancedStrips,
        redundancy,
        document_dimensions,
        mask_bounds,
        parts,
    })
}

pub(crate) fn plan_ai_fill_placement(
    provider: AiEditProvider,
    requested_method: AiFillMethod,
    requested_redundancy: AiFillRedundancy,
    document_dimensions: (u32, u32),
    mask_png: &[u8],
    forced_aspect_label: Option<&str>,
    label: &str,
) -> Result<AiEditPlacement, String> {
    let mut exact = plan_ai_edit_placement(provider, document_dimensions, mask_png, label)?;
    exact.redundancy = requested_redundancy;
    match requested_method {
        AiFillMethod::ExactInPlace => return Ok(exact),
        AiFillMethod::WideCover => {
            return plan_ai_wide_cover_placement(
                provider,
                requested_redundancy,
                document_dimensions,
                exact.mask_bounds,
                forced_aspect_label,
            )
        }
        AiFillMethod::WideStarterContinue => {
            if provider == AiEditProvider::Antigravity
                && mask_is_mostly_full(exact.mask_bounds, document_dimensions)
                && is_wide_or_tall(document_dimensions)
            {
                return plan_ai_wide_starter_continue_placement(
                    provider,
                    requested_redundancy,
                    document_dimensions,
                    exact.mask_bounds,
                );
            }
            exact.method = AiFillMethod::WideStarterContinue;
            return Ok(exact);
        }
        AiFillMethod::BalancedStrips => {
            if provider == AiEditProvider::Codex
                && mask_is_mostly_full(exact.mask_bounds, document_dimensions)
                && is_wide_or_tall(document_dimensions)
            {
                return plan_ai_codex_max_ratio_strips_placement(
                    requested_redundancy,
                    document_dimensions,
                    exact.mask_bounds,
                );
            }
            if provider == AiEditProvider::Antigravity
                && mask_is_mostly_full(exact.mask_bounds, document_dimensions)
                && is_wide_or_tall(document_dimensions)
            {
                return plan_ai_wide_starter_continue_placement(
                    provider,
                    requested_redundancy,
                    document_dimensions,
                    exact.mask_bounds,
                );
            }
            exact.method = AiFillMethod::BalancedStrips;
            return Ok(exact);
        }
        AiFillMethod::Auto => {}
    }

    if provider == AiEditProvider::Antigravity
        && mask_is_mostly_full(exact.mask_bounds, document_dimensions)
        && is_wide_or_tall(document_dimensions)
        && first_part_long_axis_coverage(&exact) < 0.60
    {
        return plan_ai_wide_cover_placement(
            provider,
            requested_redundancy,
            document_dimensions,
            exact.mask_bounds,
            forced_aspect_label,
        );
    }

    if exact.parts.len() > 1 && mask_is_mostly_full(exact.mask_bounds, document_dimensions) {
        if provider == AiEditProvider::Codex && is_wide_or_tall(document_dimensions) {
            return plan_ai_codex_max_ratio_strips_placement(
                requested_redundancy,
                document_dimensions,
                exact.mask_bounds,
            );
        }
        exact.method = match provider {
            AiEditProvider::Codex => AiFillMethod::BalancedStrips,
            AiEditProvider::Antigravity => AiFillMethod::WideStarterContinue,
        };
    }
    Ok(exact)
}

/// Per-part input PNGs cropped from the evolving document composites.
pub(crate) struct AiEditPartInputs {
    pub(crate) source_png: Vec<u8>,
    pub(crate) edit_target_png: Vec<u8>,
    pub(crate) mask_png: Vec<u8>,
    pub(crate) annotated_source_png: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct AiPartDriftCorrection {
    pub(crate) dx: i32,
    pub(crate) dy: i32,
    pub(crate) zero_score: f64,
    pub(crate) corrected_score: f64,
    pub(crate) confidence: f64,
    pub(crate) correlation: f64,
}

#[derive(Clone, Copy, Debug)]
struct DriftCandidate {
    dx: i32,
    dy: i32,
    score: f64,
    correlation: f64,
}

fn image_luma(image: &image::RgbaImage) -> Vec<u8> {
    image
        .pixels()
        .map(|pixel| {
            let [r, g, b, _] = pixel.0;
            ((u16::from(r) * 54 + u16::from(g) * 183 + u16::from(b) * 19 + 128) / 256) as u8
        })
        .collect()
}

fn high_pass_luma(luma: &[u8], width: usize, height: usize) -> Vec<i16> {
    let mut out = vec![0_i16; luma.len()];
    for y in 0..height {
        let y0 = y.saturating_sub(1);
        let y1 = (y + 1).min(height - 1);
        for x in 0..width {
            let x0 = x.saturating_sub(1);
            let x1 = (x + 1).min(width - 1);
            let mut sum = 0_u32;
            let mut count = 0_u32;
            for sy in y0..=y1 {
                for sx in x0..=x1 {
                    sum += u32::from(luma[sy * width + sx]);
                    count += 1;
                }
            }
            let blurred = (sum / count.max(1)) as i16;
            out[y * width + x] = i16::from(luma[y * width + x]) - blurred;
        }
    }
    out
}

fn gradient_magnitude(luma: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = vec![0_u8; luma.len()];
    if width < 3 || height < 3 {
        return out;
    }
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let at = |dx: isize, dy: isize| -> i32 {
                i32::from(luma[(y.wrapping_add_signed(dy)) * width + x.wrapping_add_signed(dx)])
            };
            let gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1);
            let gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
            out[y * width + x] = ((gx.abs() + gy.abs()) / 8).min(255) as u8;
        }
    }
    out
}

fn gradient_edge_threshold(gradient: &[u8]) -> u8 {
    let mut histogram = [0_u32; 256];
    for value in gradient {
        histogram[*value as usize] += 1;
    }
    let target = (gradient.len() as u32 * 88 / 100).max(1);
    let mut seen = 0_u32;
    for (value, count) in histogram.iter().enumerate() {
        seen += *count;
        if seen >= target {
            return (value as u8).max(18);
        }
    }
    18
}

fn shifted_overlap(
    width: usize,
    height: usize,
    dx: i32,
    dy: i32,
) -> Option<(usize, usize, usize, usize)> {
    let x_start = dx.max(0) as usize;
    let y_start = dy.max(0) as usize;
    let x_end = (width as i32 + dx.min(0)).max(0) as usize;
    let y_end = (height as i32 + dy.min(0)).max(0) as usize;
    (x_start < x_end && y_start < y_end).then_some((x_start, y_start, x_end, y_end))
}

fn drift_sample_stride(width: usize, height: usize) -> usize {
    let area = width.saturating_mul(height).max(1);
    ((area as f64 / AI_PART_DRIFT_TARGET_SAMPLES as f64)
        .sqrt()
        .ceil() as usize)
        .clamp(2, 8)
}

fn high_pass_correlation(
    source: &[i16],
    result: &[i16],
    width: usize,
    height: usize,
    dx: i32,
    dy: i32,
) -> Option<f64> {
    let (x_start, y_start, x_end, y_end) = shifted_overlap(width, height, dx, dy)?;
    let mut count = 0_u64;
    let mut sum_source = 0_f64;
    let mut sum_result = 0_f64;
    let mut sum_source_sq = 0_f64;
    let mut sum_result_sq = 0_f64;
    let mut sum_cross = 0_f64;
    let stride = drift_sample_stride(width, height);
    for y in (y_start..y_end).step_by(stride) {
        let ry = (y as i32 - dy) as usize;
        for x in (x_start..x_end).step_by(stride) {
            let rx = (x as i32 - dx) as usize;
            let a = f64::from(source[y * width + x]);
            let b = f64::from(result[ry * width + rx]);
            sum_source += a;
            sum_result += b;
            sum_source_sq += a * a;
            sum_result_sq += b * b;
            sum_cross += a * b;
            count += 1;
        }
    }
    if count < AI_PART_DRIFT_MIN_SAMPLES {
        return None;
    }
    let n = count as f64;
    let numerator = n * sum_cross - sum_source * sum_result;
    let source_var = n * sum_source_sq - sum_source * sum_source;
    let result_var = n * sum_result_sq - sum_result * sum_result;
    if source_var <= 1.0 || result_var <= 1.0 {
        return None;
    }
    Some((numerator / (source_var.sqrt() * result_var.sqrt())).clamp(-1.0, 1.0))
}

fn edge_chamfer_distance(source_gradient: &[u8], width: usize, height: usize) -> Vec<u32> {
    let source_threshold = gradient_edge_threshold(source_gradient);
    let source_edges = source_gradient
        .iter()
        .map(|value| *value >= source_threshold)
        .collect::<Vec<_>>();
    city_block_distances(&source_edges, width, height)
}

fn edge_chamfer_score(
    source_edge_distance: &[u32],
    result_gradient: &[u8],
    result_threshold: u8,
    width: usize,
    height: usize,
    dx: i32,
    dy: i32,
) -> Option<f64> {
    let mut count = 0_u64;
    let mut sum = 0_u64;
    let max_distance = u32::try_from(AI_PART_DRIFT_MAX_SHIFT * 2 + 1)
        .unwrap_or(33)
        .max(1);
    let stride = drift_sample_stride(width, height);
    for y in (0..height).step_by(stride) {
        for x in (0..width).step_by(stride) {
            if result_gradient[y * width + x] < result_threshold {
                continue;
            }
            let sx = x as i32 + dx;
            let sy = y as i32 + dy;
            if sx < 0 || sy < 0 || sx >= width as i32 || sy >= height as i32 {
                continue;
            }
            sum += u64::from(
                source_edge_distance[sy as usize * width + sx as usize].min(max_distance),
            );
            count += 1;
        }
    }
    (count >= AI_PART_DRIFT_MIN_EDGE_SAMPLES).then(|| sum as f64 / count as f64)
}

fn detect_part_result_drift(
    source: &image::RgbaImage,
    result: &image::RgbaImage,
) -> Option<AiPartDriftCorrection> {
    if source.dimensions() != result.dimensions() {
        return None;
    }
    let (width, height) = source.dimensions();
    let width = width as usize;
    let height = height as usize;
    if width < 8 || height < 8 {
        return None;
    }
    let source_luma = image_luma(source);
    let result_luma = image_luma(result);
    let source_high = high_pass_luma(&source_luma, width, height);
    let result_high = high_pass_luma(&result_luma, width, height);
    let source_gradient = gradient_magnitude(&source_luma, width, height);
    let result_gradient = gradient_magnitude(&result_luma, width, height);
    let source_edge_distance = edge_chamfer_distance(&source_gradient, width, height);
    let result_edge_threshold = gradient_edge_threshold(&result_gradient);

    let mut zero: Option<DriftCandidate> = None;
    let mut best: Option<DriftCandidate> = None;
    for dy in -AI_PART_DRIFT_MAX_SHIFT..=AI_PART_DRIFT_MAX_SHIFT {
        for dx in -AI_PART_DRIFT_MAX_SHIFT..=AI_PART_DRIFT_MAX_SHIFT {
            let correlation =
                high_pass_correlation(&source_high, &result_high, width, height, dx, dy)?;
            let mut score = 1.0 - correlation;
            if let Some(chamfer) = edge_chamfer_score(
                &source_edge_distance,
                &result_gradient,
                result_edge_threshold,
                width,
                height,
                dx,
                dy,
            ) {
                score += 0.035 * chamfer;
            }
            let candidate = DriftCandidate {
                dx,
                dy,
                score,
                correlation,
            };
            if dx == 0 && dy == 0 {
                zero = Some(candidate);
            }
            if best
                .as_ref()
                .map(|current| candidate.score < current.score)
                .unwrap_or(true)
            {
                best = Some(candidate);
            }
        }
    }
    let zero = zero?;
    let best = best?;
    if best.dx == 0 && best.dy == 0 {
        return None;
    }
    let confidence = zero.score - best.score;
    if confidence < AI_PART_DRIFT_MIN_SCORE_GAIN || best.correlation < AI_PART_DRIFT_MIN_CORRELATION
    {
        return None;
    }
    Some(AiPartDriftCorrection {
        dx: best.dx,
        dy: best.dy,
        zero_score: zero.score,
        corrected_score: best.score,
        confidence,
        correlation: best.correlation,
    })
}

fn shift_image_with_source_fill(
    source: &image::RgbaImage,
    result: &image::RgbaImage,
    dx: i32,
    dy: i32,
) -> image::RgbaImage {
    let (width, height) = result.dimensions();
    image::RgbaImage::from_fn(width, height, |x, y| {
        let sx = x as i32 - dx;
        let sy = y as i32 - dy;
        if sx >= 0 && sy >= 0 && sx < width as i32 && sy < height as i32 {
            *result.get_pixel(sx as u32, sy as u32)
        } else {
            *source.get_pixel(x, y)
        }
    })
}

pub(crate) fn correct_part_result_drift(
    source_png: &[u8],
    result_png: &[u8],
    label: &str,
) -> Result<(Vec<u8>, Option<AiPartDriftCorrection>), String> {
    let source = decode_png_rgba(source_png, label)?;
    let result = decode_png_rgba(result_png, label)?;
    if source.dimensions() != result.dimensions() {
        return Err(format!(
            "{label} drift-correction inputs must have identical dimensions."
        ));
    }
    let Some(correction) = detect_part_result_drift(&source, &result) else {
        return Ok((result_png.to_vec(), None));
    };
    let shifted = shift_image_with_source_fill(&source, &result, correction.dx, correction.dy);
    Ok((encode_rgba_png(shifted, label)?, Some(correction)))
}

/// Width of the cross-fade band between a part and previously generated
/// content: matches the per-axis tiling overlap so it always sits inside the
/// region both parts actually rendered.
fn part_feather_width(crop: PixelRect) -> u16 {
    let side = crop.width.min(crop.height).max(1);
    (side / 8)
        .clamp(MIN_PART_OVERLAP, MAX_PART_OVERLAP)
        .min(side) as u16
}

/// Two-pass city-block distance to the nearest `true` seed pixel.
fn city_block_distances(seeds: &[bool], width: usize, height: usize) -> Vec<u32> {
    const FAR: u32 = u32::MAX / 2;
    let mut distances = vec![FAR; seeds.len()];
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if seeds[index] {
                distances[index] = 0;
                continue;
            }
            let mut best = FAR;
            if x > 0 {
                best = best.min(distances[index - 1] + 1);
            }
            if y > 0 {
                best = best.min(distances[index - width] + 1);
            }
            distances[index] = best;
        }
    }
    for y in (0..height).rev() {
        for x in (0..width).rev() {
            let index = y * width + x;
            let mut best = distances[index];
            if x + 1 < width {
                best = best.min(distances[index + 1] + 1);
            }
            if y + 1 < height {
                best = best.min(distances[index + width] + 1);
            }
            distances[index] = best;
        }
    }
    distances
}

fn mix_rgba(old: image::Rgba<u8>, new: image::Rgba<u8>, weight: u8) -> image::Rgba<u8> {
    let w = u16::from(weight);
    let mut out = [0_u8; 4];
    for channel in 0..4 {
        let old_value = u16::from(old.0[channel]);
        let new_value = u16::from(new.0[channel]);
        out[channel] = ((old_value * (255 - w) + new_value * w + 127) / 255) as u8;
    }
    image::Rgba(out)
}

/// Owns the evolving document state while parts run sequentially, and pastes
/// normalized part results back into a full-document candidate. Where a part
/// touches pixels an earlier part already generated, its result cross-fades
/// over them across a feathered band instead of cutting hard at the part
/// boundary — the hard cut is what made split runs look like stitched images.
///
/// The edit mask is deliberately NOT baked into the candidate: each part's
/// raw result covers its whole crop rect, and the app applies the mask
/// non-destructively via the linked mask layer, so the user keeps full power
/// to edit the mask after import. The mask still shapes the per-part agent
/// inputs (`part_inputs`).
pub(crate) struct AiEditComposer {
    source: image::RgbaImage,
    edit_target: image::RgbaImage,
    /// `None` means every pixel is editable (detail-restoration passes).
    mask: Option<image::RgbaImage>,
    annotated_source: Option<image::RgbaImage>,
    /// Immutable edit permission from the mask (255 = fully editable).
    editable: CoverageGrid,
    /// Pixels some earlier part has already generated.
    painted: CoverageGrid,
}

impl AiEditComposer {
    pub(crate) fn new(
        source_png: &[u8],
        edit_target_png: &[u8],
        mask_png: &[u8],
        annotated_source_png: Option<&[u8]>,
        label: &str,
    ) -> Result<Self, String> {
        let source = decode_png_rgba(source_png, label)?;
        let edit_target = decode_png_rgba(edit_target_png, label)?;
        let mask = decode_png_rgba(mask_png, label)?;
        let annotated_source = annotated_source_png
            .map(|bytes| decode_png_rgba(bytes, label))
            .transpose()?;
        if edit_target.dimensions() != source.dimensions()
            || mask.dimensions() != source.dimensions()
            || annotated_source
                .as_ref()
                .is_some_and(|annotated| annotated.dimensions() != source.dimensions())
        {
            return Err(format!(
                "{label} source, edit target, mask, and annotated source must have identical dimensions."
            ));
        }
        let editable = CoverageGrid::from_mask(&mask);
        let (width, height) = source.dimensions();
        Ok(Self {
            source,
            edit_target,
            mask: Some(mask),
            annotated_source,
            editable,
            painted: CoverageGrid::empty(width, height),
        })
    }

    /// Composer for detail restoration: the whole image is editable and the
    /// image itself is both source and edit target.
    pub(crate) fn new_full_coverage(source_png: &[u8], label: &str) -> Result<Self, String> {
        let source = decode_png_rgba(source_png, label)?;
        let (width, height) = source.dimensions();
        Ok(Self {
            edit_target: source.clone(),
            editable: CoverageGrid::full(width, height),
            painted: CoverageGrid::empty(width, height),
            source,
            mask: None,
            annotated_source: None,
        })
    }

    /// Per-pixel mask weights for a part's agent inputs (crop-local,
    /// 0..=255): fresh editable pixels stay fully editable; pixels an
    /// earlier part painted ramp down over the feather band into a gray
    /// hand-off buffer; protected pixels stay protected. Used only to build
    /// the per-part `mask.png` — pasting uses `part_paste_weights`.
    fn part_blend_weights(&self, crop: PixelRect) -> Vec<u8> {
        let width = crop.width as usize;
        let height = crop.height as usize;
        let mut fresh = vec![false; width * height];
        let mut any_fresh = false;
        for y in 0..crop.height {
            for x in 0..crop.width {
                let index = y as usize * width + x as usize;
                let document_x = crop.x + x;
                let document_y = crop.y + y;
                if self.editable.is_covered(document_x, document_y)
                    && !self.painted.is_covered(document_x, document_y)
                {
                    fresh[index] = true;
                    any_fresh = true;
                }
            }
        }
        let feather = part_feather_width(crop);
        let distances = if any_fresh {
            city_block_distances(&fresh, width, height)
        } else {
            vec![u32::MAX / 2; width * height]
        };
        let mut weights = vec![0_u8; width * height];
        for y in 0..crop.height {
            for x in 0..crop.width {
                let index = y as usize * width + x as usize;
                let document_x = crop.x + x;
                let document_y = crop.y + y;
                if !self.editable.is_covered(document_x, document_y) {
                    continue;
                }
                weights[index] = if fresh[index] {
                    255
                } else if self.painted.is_covered(document_x, document_y) {
                    let distance = distances[index].min(u32::from(feather));
                    (255 - distance * 255 / u32::from(feather)) as u8
                } else {
                    0
                };
            }
        }
        weights
    }

    fn crop_png(image: &image::RgbaImage, crop: PixelRect, label: &str) -> Result<Vec<u8>, String> {
        let cropped =
            image::imageops::crop_imm(image, crop.x, crop.y, crop.width, crop.height).to_image();
        encode_rgba_png(cropped, label)
    }

    fn image_hiding_unpainted_editable(
        &self,
        image: &image::RgbaImage,
        fill: image::Rgba<u8>,
    ) -> image::RgbaImage {
        let mut hidden = image.clone();
        let (width, height) = hidden.dimensions();
        for y in 0..height {
            for x in 0..width {
                if self.editable.is_covered(x, y) && !self.painted.is_covered(x, y) {
                    hidden.put_pixel(x, y, fill);
                }
            }
        }
        hidden
    }

    fn image_with_draft_unpainted_editable(
        &self,
        draft_png: &[u8],
        label: &str,
    ) -> Result<image::RgbaImage, String> {
        let draft = decode_png_rgba(draft_png, label)?;
        let dimensions = self.source.dimensions();
        let draft = if draft.dimensions() == dimensions {
            draft
        } else {
            image::imageops::resize(
                &draft,
                dimensions.0,
                dimensions.1,
                image::imageops::FilterType::Triangle,
            )
        };
        let mut image = self.source.clone();
        let (width, height) = image.dimensions();
        for y in 0..height {
            for x in 0..width {
                if self.editable.is_covered(x, y) {
                    image.put_pixel(x, y, *draft.get_pixel(x, y));
                }
            }
        }
        Ok(image)
    }

    fn frame_png(
        image: &image::RgbaImage,
        part: &AiEditPart,
        fill: image::Rgba<u8>,
        label: &str,
    ) -> Result<Vec<u8>, String> {
        let (input_width, input_height) = part.working.original_dimensions;
        if part.input_paste_rect.x + part.crop.width > input_width
            || part.input_paste_rect.y + part.crop.height > input_height
        {
            return Err(format!(
                "{label} AI input frame does not contain its paste window."
            ));
        }
        if part.input_paste_rect.x == 0
            && part.input_paste_rect.y == 0
            && (input_width, input_height) == (part.crop.width, part.crop.height)
        {
            return Self::crop_png(image, part.crop, label);
        }
        let mut frame = image::RgbaImage::from_pixel(input_width, input_height, fill);
        let cropped = image::imageops::crop_imm(
            image,
            part.crop.x,
            part.crop.y,
            part.crop.width,
            part.crop.height,
        )
        .to_image();
        for y in 0..part.crop.height {
            for x in 0..part.crop.width {
                frame.put_pixel(
                    part.input_paste_rect.x + x,
                    part.input_paste_rect.y + y,
                    *cropped.get_pixel(x, y),
                );
            }
        }
        encode_rgba_png(frame, label)
    }

    pub(crate) fn part_inputs(
        &self,
        part: &AiEditPart,
        label: &str,
    ) -> Result<AiEditPartInputs, String> {
        self.part_inputs_with_padding_rule(part, label, false, false, false)
    }

    pub(crate) fn part_inputs_with_editable_frame_padding(
        &self,
        part: &AiEditPart,
        label: &str,
    ) -> Result<AiEditPartInputs, String> {
        self.part_inputs_with_padding_rule(part, label, false, false, true)
    }

    pub(crate) fn part_inputs_hiding_unpainted_editable(
        &self,
        part: &AiEditPart,
        label: &str,
        protect_frame_padding: bool,
    ) -> Result<AiEditPartInputs, String> {
        self.part_inputs_with_padding_rule(part, label, protect_frame_padding, true, true)
    }

    fn part_inputs_with_padding_rule(
        &self,
        part: &AiEditPart,
        label: &str,
        protect_frame_padding: bool,
        hide_unpainted_editable: bool,
        fill_source_padding_as_editable: bool,
    ) -> Result<AiEditPartInputs, String> {
        let hidden_source = hide_unpainted_editable
            .then(|| self.image_hiding_unpainted_editable(&self.source, UNKNOWN_EDIT_FILL));
        let hidden_edit_target = hide_unpainted_editable
            .then(|| self.image_hiding_unpainted_editable(&self.edit_target, UNKNOWN_EDIT_FILL));
        let source = hidden_source.as_ref().unwrap_or(&self.source);
        let edit_target = hidden_edit_target.as_ref().unwrap_or(&self.edit_target);
        self.part_inputs_from_images(
            part,
            label,
            protect_frame_padding,
            fill_source_padding_as_editable,
            source,
            edit_target,
        )
    }

    pub(crate) fn part_inputs_with_storyboard_draft(
        &self,
        part: &AiEditPart,
        draft_png: &[u8],
        label: &str,
        protect_frame_padding: bool,
    ) -> Result<AiEditPartInputs, String> {
        let draft_backed = self.image_with_draft_unpainted_editable(draft_png, label)?;
        self.part_inputs_from_images(
            part,
            label,
            protect_frame_padding,
            true,
            &draft_backed,
            &draft_backed,
        )
    }

    fn part_inputs_from_images(
        &self,
        part: &AiEditPart,
        label: &str,
        protect_frame_padding: bool,
        fill_source_padding_as_editable: bool,
        source: &image::RgbaImage,
        edit_target: &image::RgbaImage,
    ) -> Result<AiEditPartInputs, String> {
        let crop = part.crop;
        let (input_width, input_height) = part.working.original_dimensions;
        let weights = self.part_blend_weights(crop);
        let input_is_larger = (input_width, input_height) != (crop.width, crop.height)
            || part.input_paste_rect.x != 0
            || part.input_paste_rect.y != 0;
        let outside_mask = if input_is_larger && !protect_frame_padding {
            image::Rgba([255, 255, 255, 255])
        } else {
            image::Rgba([0, 0, 0, 255])
        };
        let mut part_mask = image::RgbaImage::from_pixel(input_width, input_height, outside_mask);
        for y in 0..crop.height {
            for x in 0..crop.width {
                let document_x = crop.x + x;
                let document_y = crop.y + y;
                let weight = weights[y as usize * crop.width as usize + x as usize];
                // Fresh pixels stay editable; the feather band over earlier
                // parts' output becomes a gray blend buffer (PaintNode
                // cross-fades there); everything else is protected context.
                // Everything is written opaque: agents and image models often
                // flatten alpha away (usually onto white), which would turn a
                // white-on-transparent mask into an all-white "everything is
                // editable" mask. Opaque black/gray/white survives that.
                let pixel = if weight == 0 {
                    image::Rgba([0, 0, 0, 255])
                } else if self.painted.is_covered(document_x, document_y) {
                    image::Rgba([128, 128, 128, 255])
                } else {
                    let coverage = self
                        .mask
                        .as_ref()
                        .map(|mask| mask_pixel_coverage(mask.get_pixel(document_x, document_y)))
                        .unwrap_or(255);
                    image::Rgba([coverage, coverage, coverage, 255])
                };
                part_mask.put_pixel(
                    part.input_paste_rect.x + x,
                    part.input_paste_rect.y + y,
                    pixel,
                );
            }
        }
        let source_padding = if input_is_larger && fill_source_padding_as_editable {
            UNKNOWN_EDIT_FILL
        } else {
            image::Rgba([0, 0, 0, 0])
        };
        Ok(AiEditPartInputs {
            source_png: Self::frame_png(source, part, source_padding, label)?,
            edit_target_png: Self::frame_png(edit_target, part, UNKNOWN_EDIT_FILL, label)?,
            mask_png: encode_rgba_png(part_mask, label)?,
            annotated_source_png: self
                .annotated_source
                .as_ref()
                .map(|annotated| Self::frame_png(annotated, part, image::Rgba([0, 0, 0, 0]), label))
                .transpose()?,
        })
    }

    /// Downscaled full-document preview with the part's region outlined,
    /// so a part-run agent can see the whole composition it belongs to.
    pub(crate) fn overview_png(&self, part: &AiEditPart, label: &str) -> Result<Vec<u8>, String> {
        self.overview_png_from_image(&self.source, Some(part), label)
    }

    pub(crate) fn overview_png_hiding_unpainted_editable(
        &self,
        part: &AiEditPart,
        label: &str,
    ) -> Result<Vec<u8>, String> {
        let hidden = self.image_hiding_unpainted_editable(&self.source, UNKNOWN_EDIT_FILL);
        self.overview_png_from_image(&hidden, Some(part), label)
    }

    pub(crate) fn overview_png_with_storyboard_draft(
        &self,
        part: &AiEditPart,
        draft_png: &[u8],
        label: &str,
    ) -> Result<Vec<u8>, String> {
        let draft_backed = self.image_with_draft_unpainted_editable(draft_png, label)?;
        self.overview_png_from_image(&draft_backed, Some(part), label)
    }

    pub(crate) fn storyboard_overview_png(&self, label: &str) -> Result<Vec<u8>, String> {
        let hidden = self.image_hiding_unpainted_editable(&self.source, UNKNOWN_EDIT_FILL);
        self.overview_png_from_image(&hidden, None, label)
    }

    fn overview_png_from_image(
        &self,
        image: &image::RgbaImage,
        part: Option<&AiEditPart>,
        label: &str,
    ) -> Result<Vec<u8>, String> {
        let (width, height) = image.dimensions();
        let long_side = width.max(height).max(1);
        let scale = f64::from(OVERVIEW_MAX_SIDE.min(long_side)) / f64::from(long_side);
        let scaled = |value: u32| (f64::from(value) * scale).round() as u32;
        let out_width = scaled(width).max(1);
        let out_height = scaled(height).max(1);
        let mut thumb = image::imageops::resize(
            image,
            out_width,
            out_height,
            image::imageops::FilterType::Triangle,
        );
        if let Some(part) = part {
            let outline = PixelRect {
                x: scaled(part.crop.x),
                y: scaled(part.crop.y),
                width: scaled(part.crop.width).max(OVERVIEW_OUTLINE_THICKNESS * 2),
                height: scaled(part.crop.height).max(OVERVIEW_OUTLINE_THICKNESS * 2),
            };
            draw_rect_outline(
                &mut thumb,
                outline,
                OVERVIEW_OUTLINE_THICKNESS,
                OVERVIEW_OUTLINE_COLOR,
            );
        }
        encode_rgba_png(thumb, label)
    }

    /// Per-pixel paste weights for a part's result (crop-local, 0..=255):
    /// the edit mask is NOT applied here — masking stays non-destructive in
    /// the app via the linked mask layer. Fresh pixels take the result
    /// fully; pixels an earlier part painted cross-fade over the feather
    /// band so neighboring parts stitch without hard seams.
    fn part_paste_weights(&self, crop: PixelRect) -> Vec<u8> {
        let width = crop.width as usize;
        let height = crop.height as usize;
        let mut fresh = vec![false; width * height];
        let mut any_fresh = false;
        for y in 0..crop.height {
            for x in 0..crop.width {
                if !self.painted.is_covered(crop.x + x, crop.y + y) {
                    fresh[y as usize * width + x as usize] = true;
                    any_fresh = true;
                }
            }
        }
        let feather = part_feather_width(crop);
        let distances = if any_fresh {
            city_block_distances(&fresh, width, height)
        } else {
            vec![u32::MAX / 2; width * height]
        };
        let mut weights = vec![0_u8; width * height];
        for (index, weight) in weights.iter_mut().enumerate() {
            *weight = if fresh[index] {
                255
            } else {
                let distance = distances[index].min(u32::from(feather));
                (255 - distance * 255 / u32::from(feather)) as u8
            };
        }
        weights
    }

    /// Paste a normalized part result (already resized to the provider input
    /// frame) into the document composites across the part's paste rect. The
    /// edit mask is not applied — the app masks the imported layer
    /// non-destructively so the user can still edit the mask afterwards.
    pub(crate) fn apply_part_result(
        &mut self,
        part: &AiEditPart,
        result_png: &[u8],
        label: &str,
    ) -> Result<(), String> {
        let result = decode_png_rgba(result_png, label)?;
        let input_dimensions = part.working.original_dimensions;
        if result.dimensions() != input_dimensions {
            return Err(format!(
                "{label} part result must be {}x{}, but it is {}x{}.",
                input_dimensions.0,
                input_dimensions.1,
                result.width(),
                result.height()
            ));
        }
        let weights = self.part_paste_weights(part.crop);
        for y in 0..part.crop.height {
            for x in 0..part.crop.width {
                let weight = weights[y as usize * part.crop.width as usize + x as usize];
                if weight == 0 {
                    continue;
                }
                let document_x = part.crop.x + x;
                let document_y = part.crop.y + y;
                let pixel = if weight == 255 {
                    *result.get_pixel(part.input_paste_rect.x + x, part.input_paste_rect.y + y)
                } else {
                    mix_rgba(
                        *self.source.get_pixel(document_x, document_y),
                        *result.get_pixel(part.input_paste_rect.x + x, part.input_paste_rect.y + y),
                        weight,
                    )
                };
                self.source.put_pixel(document_x, document_y, pixel);
                self.edit_target.put_pixel(document_x, document_y, pixel);
            }
        }
        self.painted.mark_rect(part.crop);
        Ok(())
    }

    pub(crate) fn part_result_layer_png(
        &self,
        part: &AiEditPart,
        result_png: &[u8],
        label: &str,
    ) -> Result<Vec<u8>, String> {
        let result = decode_png_rgba(result_png, label)?;
        let input_dimensions = part.working.original_dimensions;
        if result.dimensions() != input_dimensions {
            return Err(format!(
                "{label} part result must be {}x{}, but it is {}x{}.",
                input_dimensions.0,
                input_dimensions.1,
                result.width(),
                result.height()
            ));
        }
        let (width, height) = self.source.dimensions();
        let mut layer = image::RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 0]));
        for y in 0..part.crop.height {
            for x in 0..part.crop.width {
                layer.put_pixel(
                    part.crop.x + x,
                    part.crop.y + y,
                    *result.get_pixel(part.input_paste_rect.x + x, part.input_paste_rect.y + y),
                );
            }
        }
        encode_rgba_png(layer, label)
    }

    pub(crate) fn part_result_mask_png(
        &self,
        part: &AiEditPart,
        label: &str,
    ) -> Result<Vec<u8>, String> {
        let (width, height) = self.source.dimensions();
        let mut mask = image::RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 0]));
        let weights = self.part_paste_weights(part.crop);
        for y in 0..part.crop.height {
            for x in 0..part.crop.width {
                let weight = weights[y as usize * part.crop.width as usize + x as usize];
                if weight == 0 {
                    continue;
                }
                let document_x = part.crop.x + x;
                let document_y = part.crop.y + y;
                let coverage = self
                    .mask
                    .as_ref()
                    .map(|edit_mask| {
                        mask_pixel_coverage(edit_mask.get_pixel(document_x, document_y))
                    })
                    .unwrap_or(255);
                let value = ((u16::from(weight) * u16::from(coverage) + 127) / 255) as u8;
                mask.put_pixel(document_x, document_y, image::Rgba([255, 255, 255, value]));
            }
        }
        encode_rgba_png(mask, label)
    }

    /// Full-document candidate: the parts' raw results pasted at their crop
    /// positions over the original pixels. The edit mask is not baked in.
    pub(crate) fn composed_png(&self, label: &str) -> Result<Vec<u8>, String> {
        encode_rgba_png(self.source.clone(), label)
    }
}

fn draw_rect_outline(
    image: &mut image::RgbaImage,
    rect: PixelRect,
    thickness: u32,
    color: image::Rgba<u8>,
) {
    let (width, height) = image.dimensions();
    let x0 = rect.x.min(width);
    let y0 = rect.y.min(height);
    let x1 = (rect.x + rect.width).min(width);
    let y1 = (rect.y + rect.height).min(height);
    for y in y0..y1 {
        for x in x0..x1 {
            let on_border = x < x0 + thickness
                || x >= x1.saturating_sub(thickness)
                || y < y0 + thickness
                || y >= y1.saturating_sub(thickness);
            if on_border {
                image.put_pixel(x, y, color);
            }
        }
    }
}

fn centered_aspect_crop(dimensions: (u32, u32), target_aspect: (u32, u32)) -> PixelRect {
    let (width, height) = dimensions;
    let (target_width, target_height) = target_aspect;
    let image_aspect = f64::from(width) / f64::from(height.max(1));
    let target_aspect = f64::from(target_width.max(1)) / f64::from(target_height.max(1));
    if image_aspect > target_aspect {
        let crop_width = (f64::from(height) * target_aspect)
            .round()
            .clamp(1.0, f64::from(width)) as u32;
        PixelRect {
            x: (width - crop_width) / 2,
            y: 0,
            width: crop_width,
            height,
        }
    } else {
        let crop_height = (f64::from(width) / target_aspect)
            .round()
            .clamp(1.0, f64::from(height)) as u32;
        PixelRect {
            x: 0,
            y: (height - crop_height) / 2,
            width,
            height: crop_height,
        }
    }
}

fn centered_aspect_fit(dimensions: (u32, u32), target_aspect: (u32, u32)) -> PixelRect {
    let (width, height) = dimensions;
    let (target_width, target_height) = target_aspect;
    let frame_aspect = f64::from(width) / f64::from(height.max(1));
    let target_aspect = f64::from(target_width.max(1)) / f64::from(target_height.max(1));
    if frame_aspect > target_aspect {
        let fit_width = (f64::from(height) * target_aspect)
            .round()
            .clamp(1.0, f64::from(width)) as u32;
        PixelRect {
            x: (width - fit_width) / 2,
            y: 0,
            width: fit_width,
            height,
        }
    } else {
        let fit_height = (f64::from(width) / target_aspect)
            .round()
            .clamp(1.0, f64::from(height)) as u32;
        PixelRect {
            x: 0,
            y: (height - fit_height) / 2,
            width,
            height: fit_height,
        }
    }
}

pub(crate) fn storyboard_draft_canvas_png(
    overview_png: &[u8],
    provider_dimensions: (u32, u32),
    document_dimensions: (u32, u32),
    label: &str,
) -> Result<Vec<u8>, String> {
    let overview = decode_png_rgba(overview_png, label)?;
    let composition_rect = centered_aspect_fit(provider_dimensions, document_dimensions);
    let resized = image::imageops::resize(
        &overview,
        composition_rect.width,
        composition_rect.height,
        image::imageops::FilterType::Triangle,
    );
    let mut canvas = image::RgbaImage::from_pixel(
        provider_dimensions.0,
        provider_dimensions.1,
        image::Rgba([0, 0, 0, 255]),
    );
    for y in 0..composition_rect.height {
        for x in 0..composition_rect.width {
            canvas.put_pixel(
                composition_rect.x + x,
                composition_rect.y + y,
                *resized.get_pixel(x, y),
            );
        }
    }
    encode_rgba_png(canvas, label)
}

pub(crate) fn storyboard_draft_mask_png(
    provider_dimensions: (u32, u32),
    document_dimensions: (u32, u32),
    label: &str,
) -> Result<Vec<u8>, String> {
    let composition_rect = centered_aspect_fit(provider_dimensions, document_dimensions);
    let mut mask = image::RgbaImage::from_pixel(
        provider_dimensions.0,
        provider_dimensions.1,
        image::Rgba([0, 0, 0, 255]),
    );
    for y in 0..composition_rect.height {
        for x in 0..composition_rect.width {
            mask.put_pixel(
                composition_rect.x + x,
                composition_rect.y + y,
                image::Rgba([255, 255, 255, 255]),
            );
        }
    }
    encode_rgba_png(mask, label)
}

pub(crate) fn normalize_storyboard_draft_png(
    draft_png: &[u8],
    document_dimensions: (u32, u32),
    label: &str,
) -> Result<(Vec<u8>, (u32, u32), bool), String> {
    let draft = decode_png_rgba(draft_png, label)?;
    let source_dimensions = draft.dimensions();
    let crop = centered_aspect_crop(source_dimensions, document_dimensions);
    if crop.x == 0
        && crop.y == 0
        && crop.width == source_dimensions.0
        && crop.height == source_dimensions.1
    {
        return Ok((draft_png.to_vec(), source_dimensions, false));
    }
    let cropped =
        image::imageops::crop_imm(&draft, crop.x, crop.y, crop.width, crop.height).to_image();
    let normalized = encode_rgba_png(cropped, label)?;
    Ok((normalized, source_dimensions, true))
}

/// Prompt block describing how the attached crop maps back into the document.
///
/// No variant of this note may carry pixel numbers, crop coordinates, or
/// split/tiling structure ("part N of N", part counts): the agent forwards
/// this text into its image-generation call, and any hint that the crop is
/// one tile of a larger layout pushes the image model toward rendering a
/// split or multi-panel design (and stray dimensions toward an unsupported
/// aspect ratio). Paste-back geometry lives in `placement.json`; the agent
/// never needs it. See "AI prompts must not leak canvas geometry" in
/// AGENTS.md.
pub(crate) fn ai_part_geometry_note(placement: &AiEditPlacement, part_index: usize) -> String {
    let crop = placement.parts[part_index].crop;
    let input_is_expanded = part_input_is_expanded(placement, part_index);
    if !placement.is_split() {
        if input_is_expanded {
            return r#"PaintNode image geometry:
- The attached images are an expanded working frame for a PaintNode document; PaintNode will paste the generated document region back automatically.
- Any neutral placeholder area around the document content is editable provider-frame space. Replace it with natural image content; do not preserve it as a border, mat, shadow, or background.
- Treat the attached frame as the fixed canvas: do not crop, zoom, pan, rotate, or reframe it, and do not pass any document or canvas pixel dimensions to the image-generation tool."#
                .into();
        }
        let is_full_document = crop.x == 0
            && crop.y == 0
            && (crop.width, crop.height) == placement.document_dimensions;
        if is_full_document {
            return r#"PaintNode image geometry:
- The attached images are the full PaintNode document.
- Treat the attached frame as the fixed canvas: do not crop, zoom, pan, rotate, or reframe it, and do not pass any document or canvas pixel dimensions to the image-generation tool."#
                .into();
        }
        return r#"PaintNode image geometry:
- The attached images are a crop of a larger PaintNode document; PaintNode will paste your result back into the correct document region automatically.
- Treat the attached frame as the fixed canvas: do not crop, zoom, pan, rotate, or reframe it, and do not pass any document or canvas pixel dimensions to the image-generation tool."#
            .into();
    }
    r#"PaintNode image geometry:
- The attached images are a crop of a larger PaintNode document; PaintNode will paste your result back into the correct document region automatically.
- `overview.png` is a downscaled preview of the surrounding document content with the editable region outlined in red. Use it only to understand the overall composition and content continuity; never copy its pixels, its resolution, or the red outline into your result.
- The attached images already include finished content adjacent to the editable region. Match its content, lighting, perspective, and style so your result joins it seamlessly.
- The user prompt describes an edit that extends beyond this crop; produce only what belongs inside this crop's mask and let content continue naturally past the crop edges instead of composing a complete standalone picture.
- Treat the attached frame as the fixed canvas: do not crop, zoom, pan, rotate, or reframe it, and do not pass any document or canvas pixel dimensions to the image-generation tool."#
        .into()
}

fn part_input_is_expanded(placement: &AiEditPlacement, part_index: usize) -> bool {
    let part = &placement.parts[part_index];
    let crop = part.crop;
    part.working.original_dimensions != (crop.width, crop.height)
        || part.input_paste_rect.x != 0
        || part.input_paste_rect.y != 0
}

/// Prompt block for split parts after the first: the agent must translate the
/// whole-edit user prompt into a continuation of the already-finished content
/// instead of forwarding the full scene description to the image model. A
/// tail crop given the whole scene prompt renders the entire described scene
/// into its editable strip as an unrelated standalone picture. Returns an
/// empty string for single-crop runs and for the first part (which has no
/// finished content to continue). Same forwarding rule as the geometry note:
/// no pixel numbers, coordinates, or part counts.
pub(crate) fn ai_part_continuation_note(placement: &AiEditPlacement, part_index: usize) -> String {
    if !placement.is_split() || part_index == 0 {
        return String::new();
    }
    r#"Continuation rules for this crop:
- Earlier passes already generated the finished content visible in the attached images; this crop only extends that content. Study `overview.png` and the finished content before calling the image-generation tool.
- The user prompt describes the whole edit, and its main subjects are usually already present in the finished neighboring content. Do not repeat them in this crop unless `overview.png` clearly shows they belong inside the outlined region; when in doubt, continue the existing scene's surfaces, structures, and background instead of introducing new subjects.
- Write the image-tool instruction yourself as a continuation instruction: name the visible surfaces and objects that touch the editable area and describe how they extend. Do not pass the user prompt's full scene description to the image-generation tool.
- Everything crossing the boundary between finished content and the editable area must keep its exact size, scale, perspective, lighting, and style. Do not restart the composition at a different zoom level or camera position."#
        .into()
}

/// Geometry note plus, for split parts after the first, the continuation
/// rules — the prompt context block for fill and retouch part prompts.
/// (Restore prompts use `ai_part_geometry_note` alone: they carry no user
/// prompt to mistranslate into a standalone scene.)
pub(crate) fn ai_part_prompt_context(placement: &AiEditPlacement, part_index: usize) -> String {
    let geometry = ai_part_geometry_note(placement, part_index);
    let continuation = ai_part_continuation_note(placement, part_index);
    if continuation.is_empty() {
        geometry
    } else {
        format!("{geometry}\n\n{continuation}")
    }
}

/// Compact context for orchestrated split fill parts. The orchestrator owns
/// the local image prompt; this wrapper only states how PaintNode will use the
/// attached files. Same forwarding rule as the geometry note: no pixel
/// numbers, coordinates, or part counts.
pub(crate) fn ai_orchestrated_part_prompt_context(
    placement: &AiEditPlacement,
    part_index: usize,
    has_storyboard_draft: bool,
) -> String {
    let placeholder_note = if part_input_is_expanded(placement, part_index) {
        "\n- Any neutral placeholder area around the document content is editable provider-frame space. Replace it with natural image content; do not preserve it as a border, mat, shadow, or background."
    } else {
        ""
    };
    if has_storyboard_draft {
        let neighbor_note = if placement.is_split() && part_index > 0 {
            "\n- Protected pixels in the base image include already-finished high-resolution neighboring content. Match it while enhancing the visible draft."
        } else {
            ""
        };
        return format!(
            r#"PaintNode draft enhancement frame:
- PaintNode will paste this result back into the document automatically.
- This is a same-size masked image enhancement/restoration pass, not a new generation, outpaint, or composition pass.
- The pixels already visible in `edit_target.png` are the source of truth for composition. Retouch/up-res what is already there.
- Preserve every visible subject, object, pose, placement, scale, camera angle, horizon, shoreline, lighting, color relationship, and activity. Do not add, remove, replace, move, duplicate, or reinterpret content.{placeholder_note}{neighbor_note}
- Treat the attached frame as fixed: do not crop, zoom, pan, rotate, reframe, or mention document geometry in the image-tool instruction."#
        );
    }
    let neighbor_note = if placement.is_split() && part_index > 0 {
        "\n- `overview.png` and the protected pixels in the base image show the already-finished neighboring content to continue; never copy the red outline."
    } else if placement.is_split() {
        "\n- `overview.png` shows the broader editable document for composition only; never copy the red outline."
    } else {
        ""
    };
    format!(
        r#"PaintNode edit frame:
- PaintNode will paste this result back into the document automatically.
- Use the orchestrator note below only to identify the intended local content for the editable white mask.
- Treat the attached frame as fixed: do not crop, zoom, pan, rotate, reframe, or mention document geometry in the image-tool instruction.{placeholder_note}{neighbor_note}"#
    )
}

/// Prefix progress messages with the part counter on split runs.
pub(crate) fn ai_part_progress_message(
    placement: &AiEditPlacement,
    part_index: usize,
    message: &str,
) -> String {
    if placement.is_split() {
        format!(
            "Part {}/{}: {message}",
            part_index + 1,
            placement.parts.len()
        )
    } else {
        message.into()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlacementSizeJson {
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlacementRectJson {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl From<PixelRect> for PlacementRectJson {
    fn from(rect: PixelRect) -> Self {
        Self {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlacementPartJson {
    index: usize,
    dir: String,
    /// Backward-compatible alias for the document paste-back rectangle.
    crop: PlacementRectJson,
    paste_rect: PlacementRectJson,
    input_frame: PlacementSizeJson,
    input_paste_rect: PlacementRectJson,
    aspect_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_tier: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlacementManifestJson {
    version: u32,
    provider: String,
    method: String,
    redundancy: String,
    document: PlacementSizeJson,
    mask_bounds: PlacementRectJson,
    parts: Vec<PlacementPartJson>,
}

fn part_output_tier(provider: AiEditProvider, part: &AiEditPart) -> Option<String> {
    match provider {
        AiEditProvider::Antigravity => {
            antigravity_output_target(&part.working.aspect_label, part.working.original_dimensions)
                .map(|(tier, _)| tier.to_string())
        }
        AiEditProvider::Codex => None,
    }
}

fn placement_manifest_json(placement: &AiEditPlacement, label: &str) -> Result<String, String> {
    let manifest = PlacementManifestJson {
        version: 1,
        provider: placement.provider.label().into(),
        method: placement.method.label().into(),
        redundancy: placement.redundancy.label().into(),
        document: PlacementSizeJson {
            width: placement.document_dimensions.0,
            height: placement.document_dimensions.1,
        },
        mask_bounds: placement.mask_bounds.into(),
        parts: placement
            .parts
            .iter()
            .enumerate()
            .map(|(index, part)| PlacementPartJson {
                index: index + 1,
                dir: placement.part_dir_name(index).unwrap_or_else(|| ".".into()),
                crop: part.crop.into(),
                paste_rect: part.crop.into(),
                input_frame: PlacementSizeJson {
                    width: part.working.original_dimensions.0,
                    height: part.working.original_dimensions.1,
                },
                input_paste_rect: part.input_paste_rect.into(),
                aspect_label: part.working.aspect_label.clone(),
                output_tier: part_output_tier(placement.provider, part),
            })
            .collect(),
    };
    serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize {label} placement manifest: {e}"))
}

/// Prepare a job folder for this placement and record it as `placement.json`.
///
/// When the folder already holds a previous attempt with the exact same
/// placement, its part outputs are kept so the run can resume from the part
/// that failed; any other leftover layout is wiped first. Returns whether a
/// matching previous attempt was found.
pub(crate) fn prepare_ai_job_dir_for_placement(
    job_path: &Path,
    placement: &AiEditPlacement,
    label: &str,
) -> Result<bool, String> {
    let manifest_json = placement_manifest_json(placement, label)?;
    let manifest_path = job_path.join("placement.json");
    let resumable = fs::read_to_string(&manifest_path)
        .map(|previous| previous == manifest_json)
        .unwrap_or(false);
    if !resumable && manifest_path.exists() {
        fs::remove_dir_all(job_path)
            .map_err(|e| format!("Failed to clear the previous {label} job folder: {e}"))?;
        fs::create_dir_all(job_path)
            .map_err(|e| format!("Failed to recreate the {label} job folder: {e}"))?;
    }
    fs::write(&manifest_path, &manifest_json)
        .map_err(|e| format!("Failed to write {label} placement manifest: {e}"))?;
    Ok(resumable)
}

/// A previous attempt's usable output for this part, normalized to the crop
/// size: the canonical `part_result.png`, a raw `result.png` the CLI wrote
/// before the failure, or the newest staged PNG under `generated/`.
pub(crate) fn reuse_part_result(part_path: &Path, part: &AiEditPart) -> Option<Vec<u8>> {
    let mut candidates = vec![
        part_path.join("part_result.png"),
        part_path.join("result.png"),
    ];
    if let Ok(entries) = fs::read_dir(part_path.join("generated")) {
        let mut staged: Vec<_> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
            })
            .collect();
        staged.sort_by_key(|path| {
            std::cmp::Reverse(
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok(),
            )
        });
        candidates.extend(staged);
    }
    let target = part.working.original_dimensions;
    for candidate in candidates {
        let Ok(bytes) = fs::read(&candidate) else {
            continue;
        };
        if !is_png(&bytes) {
            continue;
        }
        let Some(dimensions) = png_dimensions_from_bytes(&bytes) else {
            continue;
        };
        if dimensions == target {
            return Some(bytes);
        }
        if ai_working_canvas_accepts_result_dimensions(&part.working, dimensions) {
            if let Ok(resized) = resize_png_to_dimensions(&bytes, target, "reused part result") {
                return Some(resized);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask_png_with_rects(width: u32, height: u32, rects: &[(u32, u32, u32, u32)]) -> Vec<u8> {
        let mut mask = image::RgbaImage::new(width, height);
        for (x, y, w, h) in rects {
            for yy in *y..(y + h).min(height) {
                for xx in *x..(x + w).min(width) {
                    mask.put_pixel(xx, yy, image::Rgba([255, 255, 255, 255]));
                }
            }
        }
        encode_rgba_png(mask, "test mask").expect("mask png")
    }

    fn solid_png(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba(color));
        encode_rgba_png(image, "test image").expect("solid png")
    }

    fn structural_test_image(width: u32, height: u32) -> image::RgbaImage {
        image::RgbaImage::from_fn(width, height, |x, y| {
            let mut value = ((x * 3 + y * 5) % 80 + 80) as u8;
            if x % 31 < 3 || y % 29 < 3 {
                value = 225;
            }
            if (30..70).contains(&x) && (24..80).contains(&y) {
                value = 35;
            }
            if (95..130).contains(&x) && (20..42).contains(&y) {
                value = 190;
            }
            image::Rgba([value, value.saturating_add(8), value.saturating_sub(8), 255])
        })
    }

    fn soft_cloud_test_image(width: u32, height: u32) -> image::RgbaImage {
        image::RgbaImage::from_fn(width, height, |x, y| {
            let wave_a = ((x as f64 / 11.0).sin() + (y as f64 / 17.0).cos()) * 22.0;
            let wave_b = (((x + y) as f64 / 23.0).sin() * 18.0).round();
            let value = (142.0 + wave_a + wave_b).round().clamp(80.0, 220.0) as u8;
            image::Rgba([value, value.saturating_add(8), 235, 255])
        })
    }

    fn encode_test_image(image: image::RgbaImage) -> Vec<u8> {
        encode_rgba_png(image, "test image").expect("image png")
    }

    fn rect_contains(outer: PixelRect, inner: PixelRect) -> bool {
        inner.x >= outer.x
            && inner.y >= outer.y
            && inner.x + inner.width <= outer.x + outer.width
            && inner.y + inner.height <= outer.y + outer.height
    }

    #[test]
    fn drift_correction_realigns_small_structural_translation() {
        let source = structural_test_image(160, 112);
        let drifted = shift_image_with_source_fill(&source, &source, -5, 3);
        let source_png = encode_test_image(source.clone());
        let drifted_png = encode_test_image(drifted);

        let (corrected_png, correction) =
            correct_part_result_drift(&source_png, &drifted_png, "drift").expect("corrected");
        let correction = correction.expect("drift detected");
        assert_eq!((correction.dx, correction.dy), (5, -3));
        assert!(correction.confidence > 0.01);

        let corrected = decode_png_rgba(&corrected_png, "corrected").expect("decode corrected");
        assert_eq!(
            corrected.get_pixel(80, 56).0,
            source.get_pixel(80, 56).0,
            "center structure should be registered after correction"
        );
    }

    #[test]
    fn drift_correction_uses_soft_texture_when_edges_are_weak() {
        let source = soft_cloud_test_image(192, 128);
        let drifted = shift_image_with_source_fill(&source, &source, 4, -2);
        let source_png = encode_test_image(source.clone());
        let drifted_png = encode_test_image(drifted);

        let (_corrected_png, correction) =
            correct_part_result_drift(&source_png, &drifted_png, "soft drift").expect("corrected");
        let correction = correction.expect("soft drift detected");
        assert_eq!((correction.dx, correction.dy), (-4, 2));
    }

    #[test]
    fn drift_correction_skips_flat_images_without_signal() {
        let source_png = solid_png(160, 112, [120, 160, 220, 255]);
        let (corrected_png, correction) =
            correct_part_result_drift(&source_png, &source_png, "flat").expect("checked");
        assert!(correction.is_none());
        assert_eq!(corrected_png, source_png);
    }

    #[test]
    fn codex_single_crop_uses_full_document_when_supported() {
        let mask = mask_png_with_rects(1280, 800, &[(600, 380, 60, 40)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (1280, 800), &mask, "AI retouch")
                .expect("placement");

        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        assert_eq!(
            part.crop,
            PixelRect {
                x: 0,
                y: 0,
                width: 1280,
                height: 800
            }
        );
        assert_eq!(part.working.aspect_label, "codex");
        assert_eq!(part.working.working_dimensions, (1280, 800));
    }

    #[test]
    fn codex_single_crop_floors_to_dimension_multiple() {
        let mask = mask_png_with_rects(1281, 801, &[(600, 380, 60, 40)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (1281, 801), &mask, "AI retouch")
                .expect("placement");

        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        assert_eq!((part.crop.width, part.crop.height), (1280, 800));
        assert_eq!(part.working.aspect_label, "codex");
        assert!(rect_contains(
            PixelRect {
                x: 0,
                y: 0,
                width: 1281,
                height: 801
            },
            part.crop
        ));
        assert!(rect_contains(part.crop, placement.mask_bounds));
    }

    #[test]
    fn codex_single_crop_falls_back_to_raw_dimensions_for_full_document_masks() {
        let mask = mask_png_with_rects(1281, 801, &[(0, 0, 1281, 801)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (1281, 801), &mask, "AI retouch")
                .expect("placement");

        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        assert_eq!(
            part.crop,
            PixelRect {
                x: 0,
                y: 0,
                width: 1281,
                height: 801
            }
        );
        assert_eq!(part.working.aspect_label, "codex-crop");
    }

    #[test]
    fn codex_wide_document_crop_clamps_aspect_and_covers_mask() {
        let mask = mask_png_with_rects(4000, 1000, &[(3600, 100, 200, 200)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (4000, 1000), &mask, "AI retouch")
                .expect("placement");

        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        // Clamped to the 3:1 aspect cap (2976 = 992 * 3), floored to the 16px grid.
        assert_eq!((part.crop.width, part.crop.height), (2976, 992));
        assert!(rect_contains(
            PixelRect {
                x: 0,
                y: 0,
                width: 4000,
                height: 1000
            },
            part.crop
        ));
        assert!(rect_contains(part.crop, placement.mask_bounds));
    }

    #[test]
    fn antigravity_single_crop_picks_largest_supported_ratio() {
        let mask = mask_png_with_rects(1280, 800, &[(600, 380, 60, 40)]);
        let placement = plan_ai_edit_placement(
            AiEditProvider::Antigravity,
            (1280, 800),
            &mask,
            "AI retouch",
        )
        .expect("placement");

        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        // "3:2" crops follow the model's real 1264x848 output grid (79:53),
        // not the nominal 3:2, so the model can map its output 1:1.
        assert_eq!((part.crop.width, part.crop.height), (1185, 795));
        assert_eq!(part.working.aspect_label, "3:2");
        assert!(rect_contains(part.crop, placement.mask_bounds));
    }

    #[test]
    fn antigravity_wide_document_uses_extreme_ratio_crop() {
        // Regression for the 2600x600 retouch runs: with the extreme ratios
        // available, a full-height 4:1 crop covers the widest document slice
        // in one part using the model's real 2064x512 output grid.
        let mask = mask_png_with_rects(2600, 600, &[(1316, 157, 651, 443)]);
        let placement = plan_ai_edit_placement(
            AiEditProvider::Antigravity,
            (2600, 600),
            &mask,
            "AI retouch",
        )
        .expect("placement");

        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        assert_eq!(part.working.aspect_label, "4:1");
        assert_eq!((part.crop.width, part.crop.height), (2322, 576));
        assert!(rect_contains(part.crop, placement.mask_bounds));
    }

    #[test]
    fn antigravity_crops_cap_at_the_4k_output_grid() {
        // A giant document must not produce a crop larger than the model's
        // 4K output — the result would upscale back onto the document and
        // smear protected pixels past the drift gate's tolerance.
        let mask = mask_png_with_rects(7920, 3360, &[(3000, 1500, 200, 200)]);
        let placement = plan_ai_edit_placement(
            AiEditProvider::Antigravity,
            (7920, 3360),
            &mask,
            "AI retouch",
        )
        .expect("placement");

        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        assert_eq!(part.working.aspect_label, "21:9");
        // Exactly the 4K "21:9" grid (4 x 1584x672).
        assert_eq!((part.crop.width, part.crop.height), (6336, 2688));
        assert!(rect_contains(part.crop, placement.mask_bounds));
    }

    #[test]
    fn antigravity_21_9_crop_uses_real_33_14_grid() {
        // The old nominal 21:9 crop (7:3) mismatched the model's real
        // 1584x672 = 33:14 output grid, forcing the model to reframe. The
        // crop must land exactly on the real grid.
        let mask = mask_png_with_rects(1400, 600, &[(600, 200, 100, 100)]);
        let placement = plan_ai_edit_placement(
            AiEditProvider::Antigravity,
            (1400, 600),
            &mask,
            "AI retouch",
        )
        .expect("placement");

        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        assert_eq!(part.working.aspect_label, "21:9");
        assert_eq!((part.crop.width, part.crop.height), (1386, 588));
        assert_eq!(part.crop.width * 14, part.crop.height * 33);
        assert!(rect_contains(part.crop, placement.mask_bounds));
    }

    #[test]
    fn antigravity_single_crop_clamps_to_document_edge() {
        let mask = mask_png_with_rects(1280, 800, &[(1240, 380, 40, 40)]);
        let placement = plan_ai_edit_placement(
            AiEditProvider::Antigravity,
            (1280, 800),
            &mask,
            "AI retouch",
        )
        .expect("placement");

        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        assert_eq!((part.crop.width, part.crop.height), (1185, 795));
        assert_eq!(part.crop.x, 95);
        assert!(rect_contains(part.crop, placement.mask_bounds));
    }

    #[test]
    fn wide_document_splits_into_overlapping_sequential_parts() {
        let mask = mask_png_with_rects(6000, 480, &[(0, 0, 6000, 480)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (6000, 480), &mask, "AI retouch")
                .expect("placement");

        // Full-height 3:1 strips (1440x480) across the width — every part a
        // single full-height strip, each overlapping its predecessor within
        // the cap, together covering the doc. No snug tail tile: a narrow
        // finisher carries too little finished context for the image model
        // to continue the scene.
        assert!(placement.parts.len() > 1);
        let cap = max_split_overlap(6000);
        let document = PixelRect {
            x: 0,
            y: 0,
            width: 6000,
            height: 480,
        };
        let mut previous_end = 0_u32;
        for (index, part) in placement.parts.iter().enumerate() {
            assert_eq!(part.crop.height, 480, "tiles must fill the full height");
            assert_eq!(part.crop.y, 0);
            assert!(rect_contains(document, part.crop));
            if index > 0 {
                assert!(
                    part.crop.x < previous_end,
                    "part {index} should overlap its predecessor"
                );
                assert!(
                    previous_end - part.crop.x <= cap,
                    "part {index} overlap must stay within the cap"
                );
            }
            previous_end = part.crop.x + part.crop.width;
        }
        assert_eq!(previous_end, 6000);
        // The last part is another full-width strip flush to the edge, not a
        // context-starved snug finisher.
        assert_eq!(
            placement.parts.last().unwrap().crop.width,
            placement.parts[0].crop.width
        );
    }

    #[test]
    fn codex_split_uses_balanced_wide_strips() {
        // A 2600x600 codex fill covers with two balanced 1552x600 strips
        // overlapping 504px — each part keeps a wide band of finished context
        // near the seam, instead of a wide anchor plus a context-starved snug
        // finisher.
        let mask = mask_png_with_rects(2600, 600, &[(0, 0, 2600, 600)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (2600, 600), &mask, "AI retouch")
                .expect("placement");

        assert_eq!(placement.parts.len(), 2);
        assert_eq!(
            placement.parts[0].crop,
            PixelRect {
                x: 0,
                y: 0,
                width: 1552,
                height: 600
            }
        );
        assert_eq!(
            placement.parts[1].crop,
            PixelRect {
                x: 1048,
                y: 0,
                width: 1552,
                height: 600
            }
        );
        let overlap =
            (placement.parts[0].crop.x + placement.parts[0].crop.width) - placement.parts[1].crop.x;
        assert_eq!(overlap, 504);
        assert!(overlap <= max_split_overlap(2600));
        let mut covered = CoverageGrid::empty(2600, 600);
        for part in &placement.parts {
            covered.mark_rect(part.crop);
        }
        assert_eq!(
            covered.bounds(),
            Some(PixelRect {
                x: 0,
                y: 0,
                width: 2600,
                height: 600
            })
        );
    }

    #[test]
    fn split_prunes_parts_whose_mask_region_is_already_owned() {
        let mask = mask_png_with_rects(6000, 480, &[(0, 0, 100, 480), (5900, 0, 100, 480)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (6000, 480), &mask, "AI retouch")
                .expect("placement");

        assert_eq!(placement.parts.len(), 2);
        assert!(rect_contains(
            placement.parts[0].crop,
            PixelRect {
                x: 0,
                y: 0,
                width: 100,
                height: 480
            }
        ));
        assert!(rect_contains(
            placement.parts[1].crop,
            PixelRect {
                x: 5900,
                y: 0,
                width: 100,
                height: 480
            }
        ));
    }

    #[test]
    fn antigravity_split_uses_heterogeneous_tiles_within_overlap_cap() {
        // Regression for the 2600x600 antigravity fill: use supported real
        // provider grids, keep overlaps bounded, and cover the whole document
        // without leaving featureless continuation gaps.
        let mask = mask_png_with_rects(2600, 600, &[(0, 0, 2600, 600)]);
        let placement = plan_ai_edit_placement(
            AiEditProvider::Antigravity,
            (2600, 600),
            &mask,
            "AI retouch",
        )
        .expect("placement");

        assert!((2..=3).contains(&placement.parts.len()));
        assert_ne!(placement.parts[0].working.aspect_label, "1:1");
        assert!(placement.parts[0].crop.width > placement.parts[0].crop.height);
        assert!(placement
            .parts
            .iter()
            .all(|part| part.working.aspect_label != "21:9"));
        for pair in placement.parts.windows(2) {
            let overlap = (pair[0].crop.x + pair[0].crop.width).saturating_sub(pair[1].crop.x);
            assert!(overlap <= max_split_overlap(2600));
            assert!(pair[1].crop.x <= pair[0].crop.x + pair[0].crop.width);
        }
        let mut covered = CoverageGrid::empty(2600, 600);
        for part in &placement.parts {
            covered.mark_rect(part.crop);
        }
        assert_eq!(
            covered.bounds(),
            Some(PixelRect {
                x: 0,
                y: 0,
                width: 2600,
                height: 600
            })
        );
    }

    #[test]
    fn antigravity_auto_uses_wide_cover_for_three_thousand_by_eight_hundred_fill() {
        let mask = mask_png_with_rects(3000, 800, &[(0, 0, 3000, 800)]);
        let placement = plan_ai_fill_placement(
            AiEditProvider::Antigravity,
            AiFillMethod::Auto,
            AiFillRedundancy::Medium,
            (3000, 800),
            &mask,
            None,
            "Generative fill",
        )
        .expect("placement");

        assert_eq!(placement.method, AiFillMethod::WideCover);
        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        assert_eq!(part.working.aspect_label, "21:9");
        assert_eq!(
            part_output_tier(placement.provider, part).as_deref(),
            Some("2K")
        );
        assert_eq!(
            part.crop,
            PixelRect {
                x: 0,
                y: 0,
                width: 3000,
                height: 800
            }
        );
        assert_eq!(part.working.original_dimensions, (3003, 1274));
        assert_eq!(
            part.input_paste_rect,
            PixelRect {
                x: 1,
                y: 237,
                width: 3000,
                height: 800
            }
        );
        assert_ne!(part.working.aspect_label, "1:1");
        assert_ne!(part.working.original_dimensions, (800, 800));
    }

    #[test]
    fn antigravity_explicit_starter_uses_medium_context_for_three_thousand_by_eight_hundred_fill() {
        let mask = mask_png_with_rects(3000, 800, &[(0, 0, 3000, 800)]);
        let placement = plan_ai_fill_placement(
            AiEditProvider::Antigravity,
            AiFillMethod::WideStarterContinue,
            AiFillRedundancy::Medium,
            (3000, 800),
            &mask,
            None,
            "Generative fill",
        )
        .expect("placement");

        assert_eq!(placement.method, AiFillMethod::WideStarterContinue);
        assert_eq!(placement.parts.len(), 2);
        let starter = &placement.parts[0];
        assert_eq!(starter.working.aspect_label, "21:9");
        assert_eq!(starter.working.original_dimensions, (1914, 812));
        assert_eq!(
            starter.crop,
            PixelRect {
                x: 0,
                y: 0,
                width: 1914,
                height: 800
            }
        );
        assert_eq!(
            starter.input_paste_rect,
            PixelRect {
                x: 0,
                y: 6,
                width: 1914,
                height: 800
            }
        );
        let continuation = &placement.parts[1];
        assert_eq!(continuation.working.aspect_label, "16:9");
        assert_eq!(continuation.working.original_dimensions, (1462, 816));
        assert_eq!(
            continuation.crop,
            PixelRect {
                x: 1538,
                y: 0,
                width: 1462,
                height: 800
            }
        );
        assert!(placement
            .parts
            .iter()
            .all(|part| part.working.original_dimensions != (800, 800)));
        assert!(placement
            .parts
            .iter()
            .all(|part| part.working.aspect_label != "1:1"));
    }

    #[test]
    fn split_fill_inputs_protect_expanded_frame_padding() {
        let mask = mask_png_with_rects(3000, 800, &[(0, 0, 3000, 800)]);
        let source = solid_png(3000, 800, [20, 40, 80, 255]);
        let placement = plan_ai_fill_placement(
            AiEditProvider::Antigravity,
            AiFillMethod::WideStarterContinue,
            AiFillRedundancy::High,
            (3000, 800),
            &mask,
            None,
            "Generative fill",
        )
        .expect("placement");
        let composer = AiEditComposer::new(&source, &source, &mask, None, "Generative fill")
            .expect("composer");
        let inputs = composer
            .part_inputs_hiding_unpainted_editable(&placement.parts[0], "Generative fill", true)
            .expect("inputs");
        let mask = decode_png_rgba(&inputs.mask_png, "mask").expect("decode mask");
        assert_eq!(mask.dimensions(), (1914, 812));
        assert_eq!(mask.get_pixel(0, 0).0, [0, 0, 0, 255]);
        assert_eq!(mask.get_pixel(0, 5).0, [0, 0, 0, 255]);
        assert_eq!(mask.get_pixel(0, 6).0, [255, 255, 255, 255]);
        assert_eq!(mask.get_pixel(0, 805).0, [255, 255, 255, 255]);
        assert_eq!(mask.get_pixel(0, 806).0, [0, 0, 0, 255]);
        let source = decode_png_rgba(&inputs.source_png, "source").expect("decode source");
        assert_eq!(source.get_pixel(0, 0).0, UNKNOWN_EDIT_FILL.0);
        assert_eq!(source.get_pixel(0, 5).0, UNKNOWN_EDIT_FILL.0);
        assert_eq!(source.get_pixel(0, 6).0, UNKNOWN_EDIT_FILL.0);
        assert_eq!(source.get_pixel(0, 806).0, UNKNOWN_EDIT_FILL.0);
    }

    #[test]
    fn wide_cover_fill_source_padding_is_editable_placeholder() {
        let mask = mask_png_with_rects(3000, 800, &[(0, 0, 3000, 800)]);
        let source = solid_png(3000, 800, [20, 40, 80, 255]);
        let placement = plan_ai_fill_placement(
            AiEditProvider::Antigravity,
            AiFillMethod::WideCover,
            AiFillRedundancy::Medium,
            (3000, 800),
            &mask,
            Some("4:1"),
            "Generative fill",
        )
        .expect("placement");
        let part = &placement.parts[0];
        assert_eq!(part.working.original_dimensions, (3225, 800));
        assert_eq!(
            part.input_paste_rect,
            PixelRect {
                x: 112,
                y: 0,
                width: 3000,
                height: 800
            }
        );
        let composer = AiEditComposer::new(&source, &source, &mask, None, "Generative fill")
            .expect("composer");
        let inputs = composer
            .part_inputs_with_editable_frame_padding(part, "Generative fill")
            .expect("inputs");
        let source = decode_png_rgba(&inputs.source_png, "source").expect("decode source");
        assert_eq!(source.dimensions(), (3225, 800));
        assert_eq!(source.get_pixel(0, 400).0, UNKNOWN_EDIT_FILL.0);
        assert_eq!(source.get_pixel(111, 400).0, UNKNOWN_EDIT_FILL.0);
        assert_eq!(source.get_pixel(112, 400).0, [20, 40, 80, 255]);
        assert_eq!(source.get_pixel(3111, 400).0, [20, 40, 80, 255]);
        assert_eq!(source.get_pixel(3112, 400).0, UNKNOWN_EDIT_FILL.0);
        let mask = decode_png_rgba(&inputs.mask_png, "mask").expect("decode mask");
        assert_eq!(mask.get_pixel(0, 400).0, [255, 255, 255, 255]);
        assert_eq!(mask.get_pixel(3224, 400).0, [255, 255, 255, 255]);
    }

    #[test]
    fn antigravity_starter_context_redundancy_controls_continuation_overlap() {
        let mask = mask_png_with_rects(3000, 800, &[(0, 0, 3000, 800)]);
        let plan = |redundancy| {
            plan_ai_fill_placement(
                AiEditProvider::Antigravity,
                AiFillMethod::WideStarterContinue,
                redundancy,
                (3000, 800),
                &mask,
                None,
                "Generative fill",
            )
            .expect("placement")
        };
        let low = plan(AiFillRedundancy::Low);
        let medium = plan(AiFillRedundancy::Medium);
        let high = plan(AiFillRedundancy::High);

        assert_eq!(low.redundancy, AiFillRedundancy::Low);
        assert_eq!(low.parts[1].working.aspect_label, "3:2");
        assert_eq!(low.parts[1].working.original_dimensions, (1264, 848));
        assert_eq!(low.parts[1].crop.x, 1736);

        assert_eq!(medium.redundancy, AiFillRedundancy::Medium);
        assert_eq!(medium.parts[1].working.aspect_label, "16:9");
        assert_eq!(medium.parts[1].working.original_dimensions, (1462, 816));
        assert_eq!(medium.parts[1].crop.x, 1538);

        assert_eq!(high.redundancy, AiFillRedundancy::High);
        assert_eq!(high.parts[1].working.aspect_label, "21:9");
        assert_eq!(high.parts[1].working.original_dimensions, (1914, 812));
        assert_eq!(high.parts[1].crop.x, 1086);
    }

    #[test]
    fn antigravity_explicit_strips_for_wide_fill_falls_back_to_wide_starter() {
        let mask = mask_png_with_rects(3000, 800, &[(0, 0, 3000, 800)]);
        let placement = plan_ai_fill_placement(
            AiEditProvider::Antigravity,
            AiFillMethod::BalancedStrips,
            AiFillRedundancy::Medium,
            (3000, 800),
            &mask,
            None,
            "Generative fill",
        )
        .expect("placement");

        assert_eq!(placement.method, AiFillMethod::WideStarterContinue);
        assert_eq!(placement.parts[0].working.aspect_label, "21:9");
        assert!(placement
            .parts
            .iter()
            .all(|part| part.working.original_dimensions != (800, 800)));
    }

    #[test]
    fn antigravity_auto_uses_wide_cover_for_twenty_six_hundred_by_six_hundred_fill() {
        let mask = mask_png_with_rects(2600, 600, &[(0, 0, 2600, 600)]);
        let placement = plan_ai_fill_placement(
            AiEditProvider::Antigravity,
            AiFillMethod::Auto,
            AiFillRedundancy::Medium,
            (2600, 600),
            &mask,
            None,
            "Generative fill",
        )
        .expect("placement");

        assert_eq!(placement.method, AiFillMethod::WideCover);
        assert_eq!(placement.parts.len(), 1);
        assert_eq!(
            placement.parts[0].crop,
            PixelRect {
                x: 0,
                y: 0,
                width: 2600,
                height: 600
            }
        );
        assert_eq!(placement.parts[0].working.aspect_label, "4:1");
    }

    #[test]
    fn auto_keeps_small_wide_document_masks_exact_in_place() {
        let mask = mask_png_with_rects(3000, 800, &[(1400, 300, 120, 120)]);
        let placement = plan_ai_fill_placement(
            AiEditProvider::Antigravity,
            AiFillMethod::Auto,
            AiFillRedundancy::Medium,
            (3000, 800),
            &mask,
            None,
            "Generative fill",
        )
        .expect("placement");

        assert_eq!(placement.method, AiFillMethod::ExactInPlace);
        assert_ne!(placement.parts[0].working.aspect_label, "21:9");
        assert_eq!(
            placement.parts[0].working.original_dimensions,
            (
                placement.parts[0].crop.width,
                placement.parts[0].crop.height
            )
        );
    }

    #[test]
    fn codex_auto_uses_max_ratio_full_height_strips_for_wide_fill() {
        let mask = mask_png_with_rects(3000, 800, &[(0, 0, 3000, 800)]);
        let placement = plan_ai_fill_placement(
            AiEditProvider::Codex,
            AiFillMethod::Auto,
            AiFillRedundancy::Medium,
            (3000, 800),
            &mask,
            None,
            "Generative fill",
        )
        .expect("placement");

        assert_eq!(placement.method, AiFillMethod::BalancedStrips);
        assert_eq!(placement.parts.len(), 2);
        assert_eq!(
            placement.parts[0].crop,
            PixelRect {
                x: 0,
                y: 0,
                width: 2400,
                height: 800
            }
        );
        assert_eq!(
            placement.parts[1].crop,
            PixelRect {
                x: 600,
                y: 0,
                width: 2400,
                height: 800
            }
        );
        for part in &placement.parts {
            assert_eq!(part.working.original_dimensions, (2400, 800));
            assert_eq!(part.working.aspect_label, "codex-crop");
        }
    }

    #[test]
    fn antigravity_split_uses_supported_ratio_tiles() {
        let mask = mask_png_with_rects(6000, 480, &[(0, 0, 6000, 480)]);
        let placement = plan_ai_edit_placement(
            AiEditProvider::Antigravity,
            (6000, 480),
            &mask,
            "AI retouch",
        )
        .expect("placement");

        assert!(placement.parts.len() > 1);
        let ratio_labels: Vec<&str> = ai_antigravity_image_capability()
            .aspect_ratios
            .iter()
            .map(|ratio| ratio.label.as_str())
            .collect();
        let mut covered_to = 0_u32;
        for part in &placement.parts {
            assert!(ratio_labels.contains(&part.working.aspect_label.as_str()));
            assert!(part.crop.x <= covered_to, "tiles must not leave gaps");
            covered_to = covered_to.max(part.crop.x + part.crop.width);
        }
        assert_eq!(covered_to, 6000);
    }

    #[test]
    fn placement_rejects_empty_mask() {
        let mask = mask_png_with_rects(64, 64, &[]);
        let error = plan_ai_edit_placement(AiEditProvider::Codex, (64, 64), &mask, "AI retouch")
            .expect_err("empty mask must fail");
        assert!(error.contains("no editable pixels"));
    }

    #[test]
    fn composer_pastes_whole_part_rect_without_baking_the_mask() {
        let source = solid_png(64, 32, [0, 0, 200, 255]);
        let mask = mask_png_with_rects(64, 32, &[(8, 8, 16, 16)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (64, 32), &mask, "AI retouch")
                .expect("placement");
        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];
        assert_eq!((part.crop.width, part.crop.height), (64, 32));

        let mut composer =
            AiEditComposer::new(&source, &source, &mask, None, "AI retouch").expect("composer");
        let result = solid_png(part.crop.width, part.crop.height, [200, 0, 0, 255]);
        composer
            .apply_part_result(part, &result, "AI retouch")
            .expect("apply");

        // The raw result covers the whole crop rect — including pixels
        // outside the edit mask. The app applies the mask non-destructively
        // via the linked mask layer, so the user can still edit the mask
        // after import.
        let composed = composer.composed_png("AI retouch").expect("composed");
        let composed = decode_png_rgba(&composed, "composed").expect("decode");
        assert_eq!(composed.dimensions(), (64, 32));
        assert_eq!(composed.get_pixel(10, 10).0, [200, 0, 0, 255]);
        assert_eq!(composed.get_pixel(0, 0).0, [200, 0, 0, 255]);
        assert_eq!(composed.get_pixel(40, 10).0, [200, 0, 0, 255]);
    }

    #[test]
    fn composer_feeds_completed_parts_into_later_part_inputs() {
        let source = solid_png(48, 32, [0, 0, 200, 255]);
        let mask = mask_png_with_rects(48, 32, &[(0, 0, 48, 32)]);
        let first = ai_edit_part(
            PixelRect {
                x: 0,
                y: 0,
                width: 32,
                height: 32,
            },
            "codex",
        );
        let second = ai_edit_part(
            PixelRect {
                x: 16,
                y: 0,
                width: 32,
                height: 32,
            },
            "codex",
        );

        let mut composer =
            AiEditComposer::new(&source, &source, &mask, None, "AI retouch").expect("composer");
        let red = solid_png(32, 32, [200, 0, 0, 255]);
        composer
            .apply_part_result(&first, &red, "AI retouch")
            .expect("apply first");

        let second_inputs = composer.part_inputs(&second, "AI retouch").expect("inputs");
        let second_source =
            decode_png_rgba(&second_inputs.source_png, "second source").expect("decode source");
        // The overlap region shows part one's generated pixels as context.
        assert_eq!(second_source.get_pixel(0, 0).0, [200, 0, 0, 255]);
        let second_mask =
            decode_png_rgba(&second_inputs.mask_png, "second mask").expect("decode mask");
        // Deep inside part one's output the mask is protected (opaque black so
        // alpha-stripping consumers still read it correctly); near part two's
        // fresh region it becomes a gray hand-off band; fresh stays editable.
        assert_eq!(second_mask.get_pixel(0, 0).0, [0, 0, 0, 255]);
        assert_eq!(second_mask.get_pixel(15, 0).0, [128, 128, 128, 255]);
        assert_eq!(second_mask.get_pixel(31, 0).0, [255, 255, 255, 255]);

        let second_layer_mask = composer
            .part_result_mask_png(&second, "AI retouch mask")
            .expect("layer mask");
        let second_layer_mask =
            decode_png_rgba(&second_layer_mask, "second layer mask").expect("decode mask");
        assert_eq!(second_layer_mask.dimensions(), (48, 32));
        assert_eq!(second_layer_mask.get_pixel(0, 10).0, [0, 0, 0, 0]);
        assert_eq!(second_layer_mask.get_pixel(16, 10).0, [0, 0, 0, 0]);
        assert_eq!(second_layer_mask.get_pixel(24, 10).0, [255, 255, 255, 128]);
        assert_eq!(second_layer_mask.get_pixel(40, 10).0, [255, 255, 255, 255]);

        let green = solid_png(32, 32, [0, 200, 0, 255]);
        composer
            .apply_part_result(&second, &green, "AI retouch")
            .expect("apply second");
        let composed = composer.composed_png("AI retouch").expect("composed");
        let composed = decode_png_rgba(&composed, "composed").expect("decode");
        // Far side of the feather band keeps part one's pixels, fresh pixels
        // are pure part two, and the band in between cross-fades — no more
        // hard ownership cut at the part boundary.
        assert_eq!(composed.get_pixel(16, 10).0, [200, 0, 0, 255]);
        assert_eq!(composed.get_pixel(40, 10).0, [0, 200, 0, 255]);
        let blended = composed.get_pixel(24, 10).0;
        assert!(
            blended[0] > 0 && blended[0] < 200 && blended[1] > 0 && blended[1] < 200,
            "band pixel should mix both parts, got {blended:?}"
        );
        // The blend ramps monotonically toward part two across the band.
        let closer_to_first = composed.get_pixel(18, 10).0;
        let closer_to_second = composed.get_pixel(30, 10).0;
        assert!(closer_to_first[0] > blended[0] && blended[0] > closer_to_second[0]);
    }

    #[test]
    fn generative_fill_inputs_hide_unpainted_editable_pixels_but_keep_completed_overlap() {
        let source = solid_png(48, 32, [0, 0, 200, 255]);
        let mask = mask_png_with_rects(48, 32, &[(0, 0, 48, 32)]);
        let first = ai_edit_part(
            PixelRect {
                x: 0,
                y: 0,
                width: 32,
                height: 32,
            },
            "codex",
        );
        let second = ai_edit_part(
            PixelRect {
                x: 16,
                y: 0,
                width: 32,
                height: 32,
            },
            "codex",
        );

        let mut composer = AiEditComposer::new(&source, &source, &mask, None, "Generative fill")
            .expect("composer");
        let red = solid_png(32, 32, [200, 0, 0, 255]);
        composer
            .apply_part_result(&first, &red, "Generative fill")
            .expect("apply first");

        let second_inputs = composer
            .part_inputs_hiding_unpainted_editable(&second, "Generative fill", false)
            .expect("inputs");
        let second_source =
            decode_png_rgba(&second_inputs.source_png, "second source").expect("decode source");
        let second_target = decode_png_rgba(&second_inputs.edit_target_png, "second target")
            .expect("decode target");

        assert_eq!(second_source.get_pixel(0, 16).0, [200, 0, 0, 255]);
        assert_eq!(second_target.get_pixel(0, 16).0, [200, 0, 0, 255]);
        assert_eq!(second_source.get_pixel(31, 16).0, UNKNOWN_EDIT_FILL.0);
        assert_eq!(second_target.get_pixel(31, 16).0, UNKNOWN_EDIT_FILL.0);

        let overview = composer
            .overview_png_hiding_unpainted_editable(&second, "Generative fill")
            .expect("overview");
        let overview = decode_png_rgba(&overview, "overview").expect("decode overview");
        assert_eq!(overview.get_pixel(8, 16).0, [200, 0, 0, 255]);
        assert_eq!(overview.get_pixel(40, 16).0, UNKNOWN_EDIT_FILL.0);
    }

    #[test]
    fn generative_fill_inputs_use_storyboard_draft_for_unpainted_editable_pixels() {
        let source = solid_png(48, 32, [0, 0, 200, 255]);
        let mask = mask_png_with_rects(48, 32, &[(0, 0, 48, 32)]);
        let draft = solid_png(48, 32, [0, 200, 0, 255]);
        let first = ai_edit_part(
            PixelRect {
                x: 0,
                y: 0,
                width: 32,
                height: 32,
            },
            "codex",
        );
        let second = ai_edit_part(
            PixelRect {
                x: 16,
                y: 0,
                width: 32,
                height: 32,
            },
            "codex",
        );

        let mut composer = AiEditComposer::new(&source, &source, &mask, None, "Generative fill")
            .expect("composer");
        let first_inputs = composer
            .part_inputs_with_storyboard_draft(&first, &draft, "Generative fill", true)
            .expect("first inputs");
        let first_target =
            decode_png_rgba(&first_inputs.edit_target_png, "first target").expect("decode");
        assert_eq!(first_target.get_pixel(16, 16).0, [0, 200, 0, 255]);

        let overview = composer
            .overview_png_with_storyboard_draft(&first, &draft, "Generative fill")
            .expect("overview");
        let overview = decode_png_rgba(&overview, "overview").expect("decode overview");
        assert_eq!(overview.get_pixel(40, 16).0, [0, 200, 0, 255]);

        let red = solid_png(32, 32, [200, 0, 0, 255]);
        composer
            .apply_part_result(&first, &red, "Generative fill")
            .expect("apply first");

        let second_inputs = composer
            .part_inputs_with_storyboard_draft(&second, &draft, "Generative fill", true)
            .expect("second inputs");
        let second_source =
            decode_png_rgba(&second_inputs.source_png, "second source").expect("decode source");
        let second_target = decode_png_rgba(&second_inputs.edit_target_png, "second target")
            .expect("decode target");

        assert_eq!(second_source.get_pixel(0, 16).0, [0, 200, 0, 255]);
        assert_eq!(second_target.get_pixel(0, 16).0, [0, 200, 0, 255]);
        assert_eq!(second_source.get_pixel(31, 16).0, [0, 200, 0, 255]);
        assert_eq!(second_target.get_pixel(31, 16).0, [0, 200, 0, 255]);

        let second_overview = composer
            .overview_png_with_storyboard_draft(&second, &draft, "Generative fill")
            .expect("second overview");
        let second_overview =
            decode_png_rgba(&second_overview, "second overview").expect("decode overview");
        assert_eq!(second_overview.get_pixel(8, 16).0, [0, 200, 0, 255]);
    }

    #[test]
    fn composer_rejects_part_results_with_wrong_dimensions() {
        let source = solid_png(64, 32, [0, 0, 200, 255]);
        let mask = mask_png_with_rects(64, 32, &[(8, 8, 16, 16)]);
        let part = ai_edit_part(
            PixelRect {
                x: 0,
                y: 0,
                width: 64,
                height: 32,
            },
            "codex",
        );
        let mut composer =
            AiEditComposer::new(&source, &source, &mask, None, "AI retouch").expect("composer");

        let wrong = solid_png(32, 32, [200, 0, 0, 255]);
        let error = composer
            .apply_part_result(&part, &wrong, "AI retouch")
            .expect_err("wrong dimensions must fail");
        assert!(error.contains("must be 64x32"));
    }

    #[test]
    fn overview_scales_document_and_outlines_part_region() {
        let source = solid_png(1600, 400, [10, 10, 10, 255]);
        let mask = mask_png_with_rects(1600, 400, &[(0, 0, 1600, 400)]);
        let part = ai_edit_part(
            PixelRect {
                x: 400,
                y: 0,
                width: 800,
                height: 400,
            },
            "codex",
        );
        let composer =
            AiEditComposer::new(&source, &source, &mask, None, "AI retouch").expect("composer");

        let overview = composer
            .overview_png(&part, "AI retouch")
            .expect("overview");
        let overview = decode_png_rgba(&overview, "overview").expect("decode");
        assert_eq!(overview.dimensions(), (768, 192));
        // Left edge of the outlined region: 400 * 768 / 1600 = 192.
        assert_eq!(overview.get_pixel(192, 96).0, OVERVIEW_OUTLINE_COLOR.0);
        assert_eq!(overview.get_pixel(10, 96).0, [10, 10, 10, 255]);
    }

    #[test]
    fn storyboard_overview_has_no_part_outline() {
        let source = solid_png(1600, 400, [10, 10, 10, 255]);
        let mask = mask_png_with_rects(1600, 400, &[(0, 0, 1600, 400)]);
        let composer = AiEditComposer::new(&source, &source, &mask, None, "Generative fill")
            .expect("composer");

        let overview = composer
            .storyboard_overview_png("Generative fill storyboard")
            .expect("overview");
        let overview = decode_png_rgba(&overview, "overview").expect("decode");

        assert_eq!(overview.dimensions(), (768, 192));
        assert!(overview
            .pixels()
            .all(|pixel| pixel.0 != OVERVIEW_OUTLINE_COLOR.0));
        assert_eq!(overview.get_pixel(192, 96).0, UNKNOWN_EDIT_FILL.0);
    }

    #[test]
    fn storyboard_draft_canvas_and_normalized_result_keep_document_ratio() {
        let overview = solid_png(768, 205, [80, 90, 100, 255]);
        let canvas = storyboard_draft_canvas_png(
            &overview,
            (2064, 512),
            (3000, 800),
            "storyboard draft canvas",
        )
        .expect("canvas");
        let canvas = decode_png_rgba(&canvas, "canvas").expect("decode");
        assert_eq!(canvas.dimensions(), (2064, 512));
        assert_eq!(canvas.get_pixel(1032, 256).0, [80, 90, 100, 255]);
        assert_eq!(canvas.get_pixel(10, 256).0, [0, 0, 0, 255]);

        let mask = storyboard_draft_mask_png((2064, 512), (3000, 800), "storyboard draft mask")
            .expect("mask");
        let mask = decode_png_rgba(&mask, "mask").expect("decode mask");
        assert_eq!(mask.dimensions(), (2064, 512));
        assert_eq!(mask.get_pixel(10, 256).0, [0, 0, 0, 255]);
        assert_eq!(mask.get_pixel(72, 256).0, [255, 255, 255, 255]);
        assert_eq!(mask.get_pixel(1991, 256).0, [255, 255, 255, 255]);
        assert_eq!(mask.get_pixel(1992, 256).0, [0, 0, 0, 255]);

        let provider_draft = image::RgbaImage::from_fn(2064, 512, |x, _y| {
            if x < 72 {
                image::Rgba([0, 0, 0, 255])
            } else if x < 1992 {
                image::Rgba([120, 130, 140, 255])
            } else {
                image::Rgba([0, 0, 0, 255])
            }
        });
        let provider_draft = encode_rgba_png(provider_draft, "provider draft").expect("draft");
        let (normalized, source_dimensions, changed) =
            normalize_storyboard_draft_png(&provider_draft, (3000, 800), "storyboard draft")
                .expect("normalized");
        let normalized = decode_png_rgba(&normalized, "normalized").expect("decode");

        assert_eq!(source_dimensions, (2064, 512));
        assert!(changed);
        assert_eq!(normalized.dimensions(), (1920, 512));
        assert_eq!(normalized.get_pixel(960, 256).0, [120, 130, 140, 255]);
    }

    #[test]
    fn geometry_notes_describe_full_document_crop_and_parts() {
        let full_mask = mask_png_with_rects(1280, 800, &[(600, 380, 60, 40)]);
        let single =
            plan_ai_edit_placement(AiEditProvider::Codex, (1280, 800), &full_mask, "AI retouch")
                .expect("single placement");
        let note = ai_part_geometry_note(&single, 0);
        assert!(note.contains("the full PaintNode document"));
        assert!(note.contains("do not crop, zoom, pan, rotate, or reframe"));
        // Single-crop notes must not leak pixel numbers the agent could
        // forward to the image model.
        assert!(!note.contains("1280"));
        assert!(!note.contains("800"));
        assert!(!note.contains("part 1 of"));
        assert!(!note.contains("chroma"));

        let edge_mask = mask_png_with_rects(1280, 800, &[(1240, 380, 40, 40)]);
        let cropped = plan_ai_edit_placement(
            AiEditProvider::Antigravity,
            (1280, 800),
            &edge_mask,
            "AI retouch",
        )
        .expect("cropped placement");
        let note = ai_part_geometry_note(&cropped, 0);
        assert!(note.contains("a crop of a larger PaintNode document"));
        assert!(note.contains("paste your result back into the correct document region"));
        assert!(!note.contains("1280"));
        assert!(!note.contains("x=80"));

        let wide_mask = mask_png_with_rects(6000, 480, &[(0, 0, 6000, 480)]);
        let split =
            plan_ai_edit_placement(AiEditProvider::Codex, (6000, 480), &wide_mask, "AI retouch")
                .expect("split placement");
        let note = ai_part_geometry_note(&split, 1);
        assert!(note.contains("a crop of a larger PaintNode document"));
        assert!(note.contains("`overview.png`"));
        assert!(note.contains("joins it seamlessly"));
        assert!(note.contains("produce only what belongs inside this crop's mask"));
        // Split notes must not reveal the tiling to the image model: document
        // dimensions, part counters, or crop coordinates push it toward
        // rendering a split/multi-panel design.
        assert!(!note.contains("6000"));
        assert!(!note.contains("480"));
        assert!(!note.contains("part"));
        assert!(!note.contains("split"));
        assert!(!note.contains("x="));

        let wide_cover_mask = mask_png_with_rects(3000, 800, &[(0, 0, 3000, 800)]);
        let wide_cover = plan_ai_fill_placement(
            AiEditProvider::Antigravity,
            AiFillMethod::Auto,
            AiFillRedundancy::Medium,
            (3000, 800),
            &wide_cover_mask,
            None,
            "Generative fill",
        )
        .expect("wide-cover placement");
        let note = ai_part_geometry_note(&wide_cover, 0);
        assert!(note.contains("an expanded working frame"));
        assert!(note.contains("paste the generated document region back automatically"));
        assert!(!note.contains("3000"));
        assert!(!note.contains("800"));
        assert!(!note.contains("1274"));
        assert!(!note.contains("part"));

        // Continuation rules appear only for split parts after the first, stay
        // geometry-free, and tell the agent to continue the finished content
        // instead of forwarding the full scene prompt.
        assert_eq!(ai_part_continuation_note(&split, 0), "");
        let continuation = ai_part_continuation_note(&split, 1);
        assert!(continuation.contains("continuation instruction"));
        assert!(continuation.contains("Do not pass the user prompt's full scene description"));
        assert!(continuation.contains("exact size, scale, perspective, lighting, and style"));
        assert!(!continuation.contains("6000"));
        assert!(!continuation.contains("part"));
        let context = ai_part_prompt_context(&split, 1);
        assert!(context.contains("a crop of a larger PaintNode document"));
        assert!(context.contains("Continuation rules for this crop:"));
        assert_eq!(
            ai_part_prompt_context(&split, 0),
            ai_part_geometry_note(&split, 0)
        );
        assert_eq!(
            ai_part_prompt_context(&single, 0),
            ai_part_geometry_note(&single, 0)
        );
        let orchestrated = ai_orchestrated_part_prompt_context(&split, 1, true);
        assert!(orchestrated.contains("draft enhancement frame"));
        assert!(orchestrated.contains("same-size masked image enhancement/restoration pass"));
        assert!(orchestrated.contains("Retouch/up-res what is already there"));
        assert!(orchestrated.contains("Do not add, remove, replace, move, duplicate"));
        assert!(!orchestrated.contains("storyboard-draft-crop.png"));
        assert!(!orchestrated.contains("orchestrator note"));
        assert!(!orchestrated.contains("Continuation rules for this crop"));
        assert!(!orchestrated.contains("6000"));
        assert!(!orchestrated.contains("part"));
        assert!(!orchestrated.contains("split"));
        assert!(!orchestrated.contains("x="));

        assert_eq!(
            ai_part_progress_message(&split, 1, "Starting local Codex AI retouch"),
            "Part 2/5: Starting local Codex AI retouch"
        );
        assert_eq!(
            ai_part_progress_message(&single, 0, "Starting local Codex AI retouch"),
            "Starting local Codex AI retouch"
        );
    }

    #[test]
    fn restore_placement_tiles_cover_image_at_native_density() {
        let placement =
            plan_ai_restore_placement(AiEditProvider::Codex, (4000, 1500), "AI upscale")
                .expect("codex restore placement");
        assert!(placement.parts.len() > 1);
        let mut covered = CoverageGrid::full(4000, 1500);
        for part in &placement.parts {
            assert!(part.crop.width <= 2048 && part.crop.height <= 2048);
            assert!(part.crop.x + part.crop.width <= 4000);
            assert!(part.crop.y + part.crop.height <= 1500);
            covered.clear_rect(part.crop);
        }
        assert!(
            covered.bounds().is_none(),
            "tiles must cover the whole image"
        );

        let placement =
            plan_ai_restore_placement(AiEditProvider::Antigravity, (1600, 600), "AI upscale")
                .expect("antigravity restore placement");
        let ratio_labels: Vec<&str> = ai_antigravity_image_capability()
            .aspect_ratios
            .iter()
            .map(|ratio| ratio.label.as_str())
            .collect();
        let mut covered = CoverageGrid::full(1600, 600);
        for part in &placement.parts {
            assert!(part.crop.width.max(part.crop.height) <= 1344);
            assert!(ratio_labels.contains(&part.working.aspect_label.as_str()));
            covered.clear_rect(part.crop);
        }
        assert!(covered.bounds().is_none());

        let small = plan_ai_restore_placement(AiEditProvider::Codex, (800, 600), "AI upscale")
            .expect("small restore placement");
        assert_eq!(small.parts.len(), 1);
        assert_eq!(
            (small.parts[0].crop.width, small.parts[0].crop.height),
            (800, 600)
        );

        let error = plan_ai_restore_placement(AiEditProvider::Codex, (20000, 20000), "AI upscale")
            .expect_err("oversized restore must fail");
        assert!(error.contains("Use a smaller scale"));
    }

    #[test]
    fn cover_crop_preserves_ratio_and_reports_upscale() {
        // 16:9-ish source into a wider 8:3 target: full width kept, height
        // cropped, mild enlargement reported.
        let source = solid_png(1376, 768, [10, 20, 30, 255]);
        let (normalized, source_dimensions, upscale) =
            cover_crop_png_to_dimensions(&source, (1600, 600), "generated image")
                .expect("cover crop");
        let normalized = decode_png_rgba(&normalized, "normalized").expect("decode");
        assert_eq!(normalized.dimensions(), (1600, 600));
        assert_eq!(source_dimensions, (1376, 768));
        assert!((upscale - 1600.0 / 1376.0).abs() < 0.001);

        // Wider source than target: crop the sides and downscale — no upscale.
        let source = solid_png(3000, 800, [10, 20, 30, 255]);
        let (normalized, _, upscale) =
            cover_crop_png_to_dimensions(&source, (1600, 600), "generated image")
                .expect("cover crop");
        let normalized = decode_png_rgba(&normalized, "normalized").expect("decode");
        assert_eq!(normalized.dimensions(), (1600, 600));
        assert_eq!(upscale, 1.0);

        // Exact match passes through untouched.
        let source = solid_png(1600, 600, [10, 20, 30, 255]);
        let (normalized, _, upscale) =
            cover_crop_png_to_dimensions(&source, (1600, 600), "generated image")
                .expect("cover crop");
        assert_eq!(normalized, source);
        assert_eq!(upscale, 1.0);
    }

    #[test]
    fn full_coverage_composer_marks_everything_editable_until_owned() {
        let source = solid_png(48, 32, [0, 0, 200, 255]);
        let first = ai_edit_part(
            PixelRect {
                x: 0,
                y: 0,
                width: 32,
                height: 32,
            },
            "codex-crop",
        );
        let second = ai_edit_part(
            PixelRect {
                x: 16,
                y: 0,
                width: 32,
                height: 32,
            },
            "codex-crop",
        );
        let mut composer =
            AiEditComposer::new_full_coverage(&source, "AI upscale").expect("composer");

        let inputs = composer.part_inputs(&first, "AI upscale").expect("inputs");
        let mask = decode_png_rgba(&inputs.mask_png, "mask").expect("decode mask");
        assert_eq!(mask.get_pixel(0, 0).0, [255, 255, 255, 255]);
        assert_eq!(mask.get_pixel(31, 31).0, [255, 255, 255, 255]);
        assert!(inputs.annotated_source_png.is_none());

        let red = solid_png(32, 32, [200, 0, 0, 255]);
        composer
            .apply_part_result(&first, &red, "AI upscale")
            .expect("apply");
        let second_inputs = composer.part_inputs(&second, "AI upscale").expect("inputs");
        let second_mask = decode_png_rgba(&second_inputs.mask_png, "mask").expect("decode");
        assert_eq!(second_mask.get_pixel(0, 0).0, [0, 0, 0, 255]);
        assert_eq!(second_mask.get_pixel(15, 0).0, [128, 128, 128, 255]);
        assert_eq!(second_mask.get_pixel(31, 0).0, [255, 255, 255, 255]);
        let second_source =
            decode_png_rgba(&second_inputs.source_png, "source").expect("decode source");
        assert_eq!(second_source.get_pixel(0, 0).0, [200, 0, 0, 255]);
    }

    #[test]
    fn upscale_target_dimensions_validate_scale() {
        assert_eq!(
            ai_upscale_target_dimensions((1600, 600), 100).unwrap(),
            (1600, 600)
        );
        assert_eq!(
            ai_upscale_target_dimensions((1600, 600), 250).unwrap(),
            (4000, 1500)
        );
        assert!(ai_upscale_target_dimensions((1600, 600), 99).is_err());
        assert!(ai_upscale_target_dimensions((1600, 600), 1001).is_err());
    }

    #[test]
    fn placement_manifest_records_document_and_part_coordinates() {
        let job = crate::ai::TempJobDir::new("paintnode-placement-manifest-test").expect("job dir");
        let mask = mask_png_with_rects(6000, 480, &[(0, 0, 6000, 480)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (6000, 480), &mask, "AI retouch")
                .expect("placement");
        prepare_ai_job_dir_for_placement(job.path(), &placement, "AI retouch").expect("manifest");

        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(job.path().join("placement.json")).expect("read manifest"),
        )
        .expect("parse manifest");
        assert_eq!(manifest["version"], 1);
        assert_eq!(manifest["provider"], "codex");
        assert_eq!(manifest["method"], "exactInPlace");
        assert_eq!(manifest["redundancy"], "medium");
        assert_eq!(manifest["document"]["width"], 6000);
        assert_eq!(manifest["document"]["height"], 480);
        let parts = manifest["parts"].as_array().expect("parts array");
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0]["dir"], "part-1");
        assert_eq!(parts[0]["crop"]["width"], 1440);
        assert_eq!(parts[0]["crop"]["height"], 480);
        assert_eq!(parts[0]["pasteRect"]["width"], 1440);
        assert_eq!(parts[0]["inputFrame"]["width"], 1440);
        assert_eq!(parts[0]["inputFrame"]["height"], 480);
        assert_eq!(parts[0]["inputPasteRect"]["x"], 0);
        assert_eq!(parts[0]["inputPasteRect"]["y"], 0);
        // The last part is another full-width strip flush to the right edge.
        assert_eq!(parts[4]["crop"]["x"], 4560);
        assert_eq!(parts[4]["crop"]["width"], 1440);

        let single_mask = mask_png_with_rects(1280, 800, &[(600, 380, 60, 40)]);
        let single = plan_ai_edit_placement(
            AiEditProvider::Codex,
            (1280, 800),
            &single_mask,
            "AI retouch",
        )
        .expect("single placement");
        prepare_ai_job_dir_for_placement(job.path(), &single, "AI retouch").expect("manifest");
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(job.path().join("placement.json")).expect("read manifest"),
        )
        .expect("parse manifest");
        assert_eq!(manifest["parts"][0]["dir"], ".");

        let wide_mask = mask_png_with_rects(3000, 800, &[(0, 0, 3000, 800)]);
        let wide = plan_ai_fill_placement(
            AiEditProvider::Antigravity,
            AiFillMethod::Auto,
            AiFillRedundancy::Medium,
            (3000, 800),
            &wide_mask,
            None,
            "Generative fill",
        )
        .expect("wide placement");
        prepare_ai_job_dir_for_placement(job.path(), &wide, "Generative fill").expect("manifest");
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(job.path().join("placement.json")).expect("read manifest"),
        )
        .expect("parse manifest");
        assert_eq!(manifest["provider"], "antigravity");
        assert_eq!(manifest["method"], "wideCover");
        assert_eq!(manifest["redundancy"], "medium");
        assert_eq!(manifest["parts"][0]["aspectLabel"], "21:9");
        assert_eq!(manifest["parts"][0]["outputTier"], "2K");
        assert_eq!(manifest["parts"][0]["pasteRect"]["width"], 3000);
        assert_eq!(manifest["parts"][0]["inputFrame"]["width"], 3003);
        assert_eq!(manifest["parts"][0]["inputFrame"]["height"], 1274);
        assert_eq!(manifest["parts"][0]["inputPasteRect"]["y"], 237);
    }

    #[test]
    fn job_dir_resumes_on_matching_placement_and_wipes_on_mismatch() {
        let job = crate::ai::TempJobDir::new("paintnode-placement-resume-test").expect("job dir");
        let mask = mask_png_with_rects(6000, 480, &[(0, 0, 6000, 480)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (6000, 480), &mask, "AI retouch")
                .expect("placement");

        // Fresh folder: nothing to resume.
        assert!(
            !prepare_ai_job_dir_for_placement(job.path(), &placement, "AI retouch").expect("fresh")
        );
        let part_dir = job.path().join("part-1");
        fs::create_dir_all(&part_dir).expect("part dir");
        let part_output = solid_png(1440, 480, [1, 2, 3, 255]);
        fs::write(part_dir.join("part_result.png"), &part_output).expect("part result");

        // Same placement again: previous part outputs survive.
        assert!(
            prepare_ai_job_dir_for_placement(job.path(), &placement, "AI retouch").expect("resume")
        );
        assert!(part_dir.join("part_result.png").exists());

        // A different placement wipes the stale attempt.
        let other_mask = mask_png_with_rects(6000, 480, &[(0, 0, 100, 480)]);
        let other = plan_ai_edit_placement(
            AiEditProvider::Codex,
            (6000, 480),
            &other_mask,
            "AI retouch",
        )
        .expect("other placement");
        assert!(
            !prepare_ai_job_dir_for_placement(job.path(), &other, "AI retouch").expect("mismatch")
        );
        assert!(!part_dir.join("part_result.png").exists());
    }

    #[test]
    fn reuse_part_result_accepts_valid_previous_outputs() {
        let job = crate::ai::TempJobDir::new("paintnode-part-reuse-test").expect("job dir");
        let part = ai_edit_part(
            PixelRect {
                x: 0,
                y: 0,
                width: 64,
                height: 32,
            },
            "codex",
        );

        // Nothing on disk yet.
        assert!(reuse_part_result(job.path(), &part).is_none());

        // Invalid PNG bytes are rejected.
        fs::write(job.path().join("result.png"), b"not a png").expect("write");
        assert!(reuse_part_result(job.path(), &part).is_none());

        // A raw result at a same-ratio resolution is normalized to crop size.
        fs::write(
            job.path().join("result.png"),
            solid_png(128, 64, [9, 9, 9, 255]),
        )
        .expect("write");
        let reused = reuse_part_result(job.path(), &part).expect("reuse resized");
        let reused = decode_png_rgba(&reused, "reused").expect("decode");
        assert_eq!(reused.dimensions(), (64, 32));

        // The canonical normalized output wins over the raw result.
        fs::write(
            job.path().join("part_result.png"),
            solid_png(64, 32, [4, 5, 6, 255]),
        )
        .expect("write");
        let reused = reuse_part_result(job.path(), &part).expect("reuse exact");
        let reused = decode_png_rgba(&reused, "reused").expect("decode");
        assert_eq!(reused.get_pixel(0, 0).0, [4, 5, 6, 255]);

        // Wrong-ratio leftovers are not reusable.
        fs::remove_file(job.path().join("part_result.png")).expect("remove");
        fs::write(
            job.path().join("result.png"),
            solid_png(64, 64, [9, 9, 9, 255]),
        )
        .expect("write");
        assert!(reuse_part_result(job.path(), &part).is_none());
    }
}
