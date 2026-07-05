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
    ai_fallback_aspect_ratios, ai_working_canvas_accepts_result_dimensions, mask_pixel_coverage,
    AiWorkingCanvas, PixelRect,
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

/// Preferred protected context ring kept around the mask inside a crop.
const MASK_CONTEXT_MARGIN: u32 = 16;

const OVERVIEW_MAX_SIDE: u32 = 768;
const OVERVIEW_OUTLINE_THICKNESS: u32 = 3;
const OVERVIEW_OUTLINE_COLOR: image::Rgba<u8> = image::Rgba([255, 48, 48, 255]);

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

#[derive(Clone, Debug)]
pub(crate) struct AiEditPart {
    /// Where this part's pixels live inside the document.
    pub(crate) crop: PixelRect,
    /// Submission geometry for this part; crops are never padded.
    pub(crate) working: AiWorkingCanvas,
}

#[derive(Clone, Debug)]
pub(crate) struct AiEditPlacement {
    pub(crate) provider: AiEditProvider,
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
    AiEditPart {
        crop,
        working: ai_exact_working_canvas((crop.width, crop.height), aspect_label),
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

    /// Mark every pixel of `rect` that is editable in `editable` as covered.
    fn mark_rect_where_editable(&mut self, rect: PixelRect, editable: &CoverageGrid) {
        let rect = self.clamped(rect);
        for y in rect.y..rect.y + rect.height {
            let row = y as usize * self.width as usize;
            for x in rect.x..rect.x + rect.width {
                if editable.coverage[row + x as usize] > 0 {
                    self.coverage[row + x as usize] = 255;
                }
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

fn ratio_crop_candidates(document: (u32, u32)) -> Vec<(u32, u32, String)> {
    ai_fallback_aspect_ratios()
        .iter()
        .filter_map(|ratio| {
            let units = (document.0 / ratio.width).min(document.1 / ratio.height);
            (units > 0).then(|| {
                (
                    ratio.width * units,
                    ratio.height * units,
                    ratio.label.clone(),
                )
            })
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
        AiEditProvider::Codex => codex_crop_dimensions(document, None).into_iter().collect(),
        AiEditProvider::Antigravity => ratio_crop_candidates(document),
    }
}

/// Choose the tile shape that needs the fewest parts (largest area on ties)
/// and lay tiles over the target region in reading order.
fn best_tiling(
    candidates: Vec<(u32, u32, String)>,
    document: (u32, u32),
    target: PixelRect,
) -> Result<(Vec<PixelRect>, String), String> {
    let mut best: Option<(usize, u64, Vec<PixelRect>, String)> = None;
    for (tile_width, tile_height, label) in candidates {
        let xs = tile_axis_origins(document.0, target.x, target.width, tile_width);
        let ys = tile_axis_origins(document.1, target.y, target.height, tile_height);
        let count = xs.len() * ys.len();
        let area = u64::from(tile_width) * u64::from(tile_height);
        let is_better = best
            .as_ref()
            .map(|(best_count, best_area, _, _)| {
                (count, std::cmp::Reverse(area)) < (*best_count, std::cmp::Reverse(*best_area))
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
        best = Some((count, area, rects, label));
    }
    best.map(|(_, _, rects, label)| (rects, label))
        .ok_or_else(|| "No supported AI crop shape fits this document.".into())
}

fn split_part_rects(
    provider: AiEditProvider,
    document: (u32, u32),
    target: PixelRect,
) -> Result<(Vec<PixelRect>, String), String> {
    best_tiling(split_tile_candidates(provider, document), document, target)
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
            let cap = ai_antigravity_image_capability().restore_tile_side.max(1);
            ai_fallback_aspect_ratios()
                .iter()
                .filter_map(|ratio| {
                    let units = (document.0 / ratio.width)
                        .min(document.1 / ratio.height)
                        .min(cap / ratio.width.max(ratio.height));
                    (units > 0).then(|| {
                        (
                            ratio.width * units,
                            ratio.height * units,
                            ratio.label.clone(),
                        )
                    })
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
    let (rects, aspect_label) = best_tiling(
        restore_tile_candidates(provider, document_dimensions),
        document_dimensions,
        full,
    )?;
    if rects.len() > MAX_AI_EDIT_PARTS {
        return Err(format!(
            "{label} would need {} AI restoration parts for a {width}x{height} image. Use a smaller scale.",
            rects.len()
        ));
    }
    Ok(AiEditPlacement {
        provider,
        document_dimensions,
        mask_bounds: full,
        parts: rects
            .into_iter()
            .map(|rect| ai_edit_part(rect, &aspect_label))
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
            document_dimensions,
            mask_bounds,
            parts: vec![ai_edit_part(crop, &aspect_label)],
        });
    }

    let (rects, aspect_label) = split_part_rects(provider, document_dimensions, target)?;
    let mut parts = Vec::new();
    for rect in rects {
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
        document_dimensions,
        mask_bounds,
        parts,
    })
}

/// Per-part input PNGs cropped from the evolving document composites.
pub(crate) struct AiEditPartInputs {
    pub(crate) source_png: Vec<u8>,
    pub(crate) edit_target_png: Vec<u8>,
    pub(crate) mask_png: Vec<u8>,
    pub(crate) annotated_source_png: Option<Vec<u8>>,
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

    /// Per-pixel paste weights for a part (crop-local, 0..=255): fresh
    /// editable pixels take the part's result fully; pixels an earlier part
    /// painted take it with a weight that ramps down over the feather band so
    /// neighboring parts cross-fade; protected pixels never take it.
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

    pub(crate) fn part_inputs(
        &self,
        part: &AiEditPart,
        label: &str,
    ) -> Result<AiEditPartInputs, String> {
        let crop = part.crop;
        let weights = self.part_blend_weights(crop);
        let mut part_mask = image::RgbaImage::new(crop.width, crop.height);
        for y in 0..crop.height {
            for x in 0..crop.width {
                let document_x = crop.x + x;
                let document_y = crop.y + y;
                let weight = weights[y as usize * crop.width as usize + x as usize];
                // Fresh pixels stay editable; the feather band over earlier
                // parts' output becomes a gray blend buffer (PaintNode
                // cross-fades there); everything else is protected context.
                let pixel = if weight == 0 {
                    image::Rgba([0, 0, 0, 0])
                } else if self.painted.is_covered(document_x, document_y) {
                    image::Rgba([128, 128, 128, 255])
                } else {
                    self.mask
                        .as_ref()
                        .map(|mask| *mask.get_pixel(document_x, document_y))
                        .unwrap_or(image::Rgba([255, 255, 255, 255]))
                };
                part_mask.put_pixel(x, y, pixel);
            }
        }
        Ok(AiEditPartInputs {
            source_png: Self::crop_png(&self.source, crop, label)?,
            edit_target_png: Self::crop_png(&self.edit_target, crop, label)?,
            mask_png: encode_rgba_png(part_mask, label)?,
            annotated_source_png: self
                .annotated_source
                .as_ref()
                .map(|annotated| Self::crop_png(annotated, crop, label))
                .transpose()?,
        })
    }

    /// Downscaled full-document preview with the part's region outlined,
    /// so a part-run agent can see the whole composition it belongs to.
    pub(crate) fn overview_png(&self, part: &AiEditPart, label: &str) -> Result<Vec<u8>, String> {
        let (width, height) = self.source.dimensions();
        let long_side = width.max(height).max(1);
        let scale = f64::from(OVERVIEW_MAX_SIDE.min(long_side)) / f64::from(long_side);
        let scaled = |value: u32| (f64::from(value) * scale).round() as u32;
        let out_width = scaled(width).max(1);
        let out_height = scaled(height).max(1);
        let mut thumb = image::imageops::resize(
            &self.source,
            out_width,
            out_height,
            image::imageops::FilterType::Triangle,
        );
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
        encode_rgba_png(thumb, label)
    }

    /// Paste a normalized part result (already resized to the part's crop size)
    /// into the document composites, but only where this part's mask allowed edits.
    pub(crate) fn apply_part_result(
        &mut self,
        part: &AiEditPart,
        result_png: &[u8],
        label: &str,
    ) -> Result<(), String> {
        let result = decode_png_rgba(result_png, label)?;
        if result.dimensions() != (part.crop.width, part.crop.height) {
            return Err(format!(
                "{label} part result must be {}x{}, but it is {}x{}.",
                part.crop.width,
                part.crop.height,
                result.width(),
                result.height()
            ));
        }
        let weights = self.part_blend_weights(part.crop);
        for y in 0..part.crop.height {
            for x in 0..part.crop.width {
                let weight = weights[y as usize * part.crop.width as usize + x as usize];
                if weight == 0 {
                    continue;
                }
                let document_x = part.crop.x + x;
                let document_y = part.crop.y + y;
                let pixel = if weight == 255 {
                    *result.get_pixel(x, y)
                } else {
                    mix_rgba(
                        *self.source.get_pixel(document_x, document_y),
                        *result.get_pixel(x, y),
                        weight,
                    )
                };
                self.source.put_pixel(document_x, document_y, pixel);
                self.edit_target.put_pixel(document_x, document_y, pixel);
            }
        }
        self.painted
            .mark_rect_where_editable(part.crop, &self.editable);
        Ok(())
    }

    /// Full-document candidate: original pixels everywhere except the pixels
    /// the parts were allowed to edit.
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

/// Prompt block describing how the attached crop maps back into the document.
pub(crate) fn ai_part_geometry_note(placement: &AiEditPlacement, part_index: usize) -> String {
    let part = &placement.parts[part_index];
    let (document_width, document_height) = placement.document_dimensions;
    let crop = part.crop;
    if !placement.is_split() {
        let is_full_document = crop.x == 0
            && crop.y == 0
            && (crop.width, crop.height) == placement.document_dimensions;
        if is_full_document {
            return format!(
                r#"PaintNode image geometry:
- The attached images are the full {document_width}x{document_height} PaintNode document.
- Treat the attached frame as the fixed canvas: do not crop, zoom, pan, rotate, or reframe it."#
            );
        }
        return format!(
            r#"PaintNode image geometry:
- The attached images are a crop of a larger {document_width}x{document_height} PaintNode document.
- The crop covers document region x={x}, y={y}, width={width}, height={height}.
- PaintNode will paste your result back into that exact document region, so treat the attached frame as the fixed canvas: do not crop, zoom, pan, rotate, or reframe it."#,
            x = crop.x,
            y = crop.y,
            width = crop.width,
            height = crop.height
        );
    }
    format!(
        r#"PaintNode multi-part edit context:
- The full PaintNode document is {document_width}x{document_height}. No supported AI image shape can cover this edit at once, so PaintNode split it into {part_count} parts that run one at a time.
- You are editing part {part_number} of {part_count}: document region x={x}, y={y}, width={width}, height={height}.
- `overview.png` is a downscaled preview of the whole document with your part's region outlined in red. Use it only to understand the overall composition and content continuity; never copy its pixels, its resolution, or the red outline into your result.
- Content generated by earlier parts is already included in the attached images. Match its content, lighting, perspective, and style so all parts join seamlessly.
- The user prompt describes the whole edit across all parts; produce only the portion that belongs inside this part's mask.
- PaintNode will paste your result back into this part's document region, so treat the attached frame as the fixed canvas: do not crop, zoom, pan, rotate, or reframe it."#,
        part_number = part_index + 1,
        part_count = placement.parts.len(),
        x = crop.x,
        y = crop.y,
        width = crop.width,
        height = crop.height
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
    crop: PlacementRectJson,
    aspect_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlacementManifestJson {
    version: u32,
    provider: String,
    document: PlacementSizeJson,
    mask_bounds: PlacementRectJson,
    parts: Vec<PlacementPartJson>,
}

fn placement_manifest_json(placement: &AiEditPlacement, label: &str) -> Result<String, String> {
    let manifest = PlacementManifestJson {
        version: 1,
        provider: placement.provider.label().into(),
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
                aspect_label: part.working.aspect_label.clone(),
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
    let target = (part.crop.width, part.crop.height);
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

    fn rect_contains(outer: PixelRect, inner: PixelRect) -> bool {
        inner.x >= outer.x
            && inner.y >= outer.y
            && inner.x + inner.width <= outer.x + outer.width
            && inner.y + inner.height <= outer.y + outer.height
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
        assert_eq!((part.crop.width, part.crop.height), (1200, 800));
        assert_eq!(part.working.aspect_label, "3:2");
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
        assert_eq!((part.crop.width, part.crop.height), (1200, 800));
        assert_eq!(part.crop.x, 80);
        assert!(rect_contains(part.crop, placement.mask_bounds));
    }

    #[test]
    fn wide_document_splits_into_overlapping_sequential_parts() {
        let mask = mask_png_with_rects(6000, 480, &[(0, 0, 6000, 480)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (6000, 480), &mask, "AI retouch")
                .expect("placement");

        assert_eq!(placement.parts.len(), 5);
        let document = PixelRect {
            x: 0,
            y: 0,
            width: 6000,
            height: 480,
        };
        let mut previous_end = 0_u32;
        for (index, part) in placement.parts.iter().enumerate() {
            assert_eq!((part.crop.width, part.crop.height), (1440, 480));
            assert!(rect_contains(document, part.crop));
            assert_eq!(
                part.working.working_dimensions,
                (part.crop.width, part.crop.height)
            );
            if index > 0 {
                assert!(
                    part.crop.x < previous_end,
                    "part {index} should overlap its predecessor"
                );
            }
            previous_end = part.crop.x + part.crop.width;
        }
        assert_eq!(previous_end, 6000);
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
        let ratio_labels: Vec<&str> = ai_fallback_aspect_ratios()
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
    fn composer_pastes_part_results_only_inside_the_mask() {
        let source = solid_png(64, 32, [0, 0, 200, 255]);
        let mask = mask_png_with_rects(64, 32, &[(8, 8, 16, 16)]);
        let placement =
            plan_ai_edit_placement(AiEditProvider::Codex, (64, 32), &mask, "AI retouch")
                .expect("placement");
        assert_eq!(placement.parts.len(), 1);
        let part = &placement.parts[0];

        let mut composer =
            AiEditComposer::new(&source, &source, &mask, None, "AI retouch").expect("composer");
        let result = solid_png(part.crop.width, part.crop.height, [200, 0, 0, 255]);
        composer
            .apply_part_result(part, &result, "AI retouch")
            .expect("apply");

        let composed = composer.composed_png("AI retouch").expect("composed");
        let composed = decode_png_rgba(&composed, "composed").expect("decode");
        assert_eq!(composed.dimensions(), (64, 32));
        assert_eq!(composed.get_pixel(10, 10).0, [200, 0, 0, 255]);
        assert_eq!(composed.get_pixel(0, 0).0, [0, 0, 200, 255]);
        assert_eq!(composed.get_pixel(40, 10).0, [0, 0, 200, 255]);
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
        // Deep inside part one's output the mask is protected; near part two's
        // fresh region it becomes a gray hand-off band; fresh stays editable.
        assert_eq!(second_mask.get_pixel(0, 0).0, [0, 0, 0, 0]);
        assert_eq!(second_mask.get_pixel(15, 0).0, [128, 128, 128, 255]);
        assert_eq!(second_mask.get_pixel(31, 0).0, [255, 255, 255, 255]);

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
    fn geometry_notes_describe_full_document_crop_and_parts() {
        let full_mask = mask_png_with_rects(1280, 800, &[(600, 380, 60, 40)]);
        let single =
            plan_ai_edit_placement(AiEditProvider::Codex, (1280, 800), &full_mask, "AI retouch")
                .expect("single placement");
        let note = ai_part_geometry_note(&single, 0);
        assert!(note.contains("the full 1280x800 PaintNode document"));
        assert!(note.contains("do not crop, zoom, pan, rotate, or reframe"));
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
        assert!(note.contains("a crop of a larger 1280x800 PaintNode document"));
        assert!(note.contains("x=80, y=0, width=1200, height=800"));
        assert!(note.contains("paste your result back into that exact document region"));

        let wide_mask = mask_png_with_rects(6000, 480, &[(0, 0, 6000, 480)]);
        let split =
            plan_ai_edit_placement(AiEditProvider::Codex, (6000, 480), &wide_mask, "AI retouch")
                .expect("split placement");
        let note = ai_part_geometry_note(&split, 1);
        assert!(note.contains("split it into 5 parts"));
        assert!(note.contains("part 2 of 5"));
        assert!(note.contains("`overview.png`"));
        assert!(note.contains("Content generated by earlier parts"));
        assert!(note.contains("produce only the portion that belongs inside this part's mask"));

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
        let ratio_labels: Vec<&str> = ai_fallback_aspect_ratios()
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
        assert_eq!(second_mask.get_pixel(0, 0).0, [0, 0, 0, 0]);
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
        assert_eq!(manifest["document"]["width"], 6000);
        assert_eq!(manifest["document"]["height"], 480);
        let parts = manifest["parts"].as_array().expect("parts array");
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0]["dir"], "part-1");
        assert_eq!(parts[0]["crop"]["width"], 1440);
        assert_eq!(parts[0]["crop"]["height"], 480);
        assert_eq!(parts[4]["crop"]["x"], 4560);

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
