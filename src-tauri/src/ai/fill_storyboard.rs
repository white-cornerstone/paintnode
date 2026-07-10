//! Master draft planning support for split generative fill runs.
//!
//! The persisted artifact is still named `storyboard.json` for compatibility,
//! but its purpose is same-photo draft/refinement guidance, not narrative
//! storyboarding. It is deliberately qualitative: prompt prose must not carry
//! pixel dimensions, coordinates, or crop rectangles into image-generation
//! instructions.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::ai::canvas::ai_antigravity_image_capability;
use crate::ai::placement::{AiEditPlacement, AiEditProvider, AiFillMethod};

pub(crate) const FILL_STORYBOARD_FILE: &str = "storyboard.json";
pub(crate) const FILL_STORYBOARD_DRAFT_FILE: &str = "storyboard-draft-result.png";
pub(crate) const FILL_STORYBOARD_DRAFT_CANVAS_FILE: &str = "storyboard-draft-canvas.png";
pub(crate) const FILL_STORYBOARD_DRAFT_MASK_FILE: &str = "storyboard-draft-mask.png";
pub(crate) const FILL_STORYBOARD_ERROR_FILE: &str = "storyboard-error.txt";
pub(crate) const FILL_STORYBOARD_INVALID_FILE: &str = "storyboard-invalid.json";
pub(crate) const FILL_STORYBOARD_OVERVIEW_FILE: &str = "storyboard-overview.png";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct FillStoryboard {
    pub(crate) version: u32,
    pub(crate) fallback: bool,
    pub(crate) global_scene_intent: String,
    pub(crate) global_style_rules: Vec<String>,
    pub(crate) forbidden_per_crop_artifacts: Vec<String>,
    pub(crate) parts: Vec<FillStoryboardPart>,
}

impl Default for FillStoryboard {
    fn default() -> Self {
        Self {
            version: 1,
            fallback: false,
            global_scene_intent: String::new(),
            global_style_rules: Vec::new(),
            forbidden_per_crop_artifacts: Vec::new(),
            parts: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
#[derive(Default)]
pub(crate) struct FillStoryboardPart {
    pub(crate) index: usize,
    pub(crate) role: String,
    pub(crate) continuity_edges: Vec<String>,
    pub(crate) expected_content: Vec<String>,
    pub(crate) prompt_guidance: String,
}

struct PlannedPart {
    role: String,
    continuity_edges: Vec<String>,
    expected_content: Vec<String>,
    prompt_guidance: String,
}

pub(crate) fn should_storyboard_fill(placement: &AiEditPlacement) -> bool {
    placement.is_split()
}

fn fill_method_label(method: AiFillMethod) -> &'static str {
    match method {
        AiFillMethod::Auto => "auto",
        AiFillMethod::ExactInPlace => "exact in-place",
        AiFillMethod::WideCover => "wide cover",
        AiFillMethod::WideStarterContinue => "wide starter plus continue",
        AiFillMethod::BalancedStrips => "balanced strips",
    }
}

fn split_axis(placement: &AiEditPlacement) -> &'static str {
    let min_x = placement
        .parts
        .iter()
        .map(|part| part.crop.x)
        .min()
        .unwrap_or(0);
    let max_x = placement
        .parts
        .iter()
        .map(|part| part.crop.x)
        .max()
        .unwrap_or(0);
    let min_y = placement
        .parts
        .iter()
        .map(|part| part.crop.y)
        .min()
        .unwrap_or(0);
    let max_y = placement
        .parts
        .iter()
        .map(|part| part.crop.y)
        .max()
        .unwrap_or(0);
    if max_x > min_x || placement.document_dimensions.0 >= placement.document_dimensions.1 {
        "horizontal"
    } else if max_y > min_y {
        "vertical"
    } else {
        "horizontal"
    }
}

fn planned_part(placement: &AiEditPlacement, index: usize) -> PlannedPart {
    let axis = split_axis(placement);
    let last = placement.parts.len().saturating_sub(1);
    let (role, continuity_edges) = match (axis, index, index == last) {
        ("vertical", 0, false) => ("top draft-refinement anchor", vec!["lower handoff edge must keep the same still-image surfaces, scale, lighting, and perspective"]),
        ("vertical", _, true) => (
            "bottom draft-refinement area",
            vec!["upper handoff edge must match the protected neighboring pixels at the same scale and camera position"],
        ),
        ("vertical", _, false) => (
            "middle draft-refinement area",
            vec![
                "upper handoff edge must match the protected neighboring pixels at the same scale and camera position",
                "lower handoff edge must keep the same still-image surfaces, scale, lighting, and perspective",
            ],
        ),
        (_, 0, false) => (
            "left draft-refinement anchor",
            vec!["right handoff edge must keep the same still-image horizon, surfaces, scale, lighting, and perspective"],
        ),
        (_, _, true) => (
            "right draft-refinement area",
            vec!["left handoff edge must match the protected neighboring pixels at the same scale and camera position"],
        ),
        _ => (
            "center draft-refinement area",
            vec![
                "left handoff edge must match the protected neighboring pixels at the same scale and camera position",
                "right handoff edge must keep the same still-image horizon, surfaces, scale, lighting, and perspective",
            ],
        ),
    };

    let expected_content = if index == 0 {
        vec![
            "Use the visual draft as the locked composition for this anchor area; include the requested main subject and scene details only where the draft places them.",
            "Render the low-detail draft inside the editable mask into final high-detail pixels while leaving horizons, surfaces, and perspective lines open at the handoff edge.",
        ]
    } else {
        vec![
            "The white mask already contains a rough draft of the same still image, not a later story beat, new shot, zoom-out, or alternate camera view.",
            "Enhance the draft pixels and match the protected neighbor's visible surfaces, horizon, lighting, texture scale, and camera perspective before considering any new subject.",
        ]
    };
    let prompt_guidance = if index == 0 {
        "Refine the low-detail draft visible in the white mask into a high-detail same-photo anchor. Preserve the draft's composition, subject placement, camera, and open handoff edge; avoid self-contained endings, crop-local vignettes, dark corners, borders, or frame effects."
    } else {
        "Refine the low-detail draft visible in the white mask into high-detail same-photo pixels that match the protected neighbor. Do not forward the full user prompt verbatim; do not continue a story, zoom out, reframe, change camera position, duplicate the primary subject, or add new people, props, or activities beyond what is already visible in the draft."
    };

    PlannedPart {
        role: role.into(),
        continuity_edges: continuity_edges.into_iter().map(str::to_string).collect(),
        expected_content: expected_content.into_iter().map(str::to_string).collect(),
        prompt_guidance: prompt_guidance.into(),
    }
}

pub(crate) fn fallback_fill_storyboard(placement: &AiEditPlacement) -> FillStoryboard {
    let parts = placement
        .parts
        .iter()
        .enumerate()
        .map(|(index, _part)| {
            let planned = planned_part(placement, index);
            FillStoryboardPart {
                index: index + 1,
                role: planned.role,
                continuity_edges: planned.continuity_edges,
                expected_content: planned.expected_content,
                prompt_guidance: planned.prompt_guidance,
            }
        })
        .collect();

    FillStoryboard {
        version: 1,
        fallback: true,
        global_scene_intent:
            "Create one coherent still image by refining the rough draft across the PaintNode fill area."
                .into(),
        global_style_rules: vec![
            "Apply requested color, grain, lens feel, medium, era, and perspective consistently across the final composed image.".into(),
            "Keep the same camera position, subject scale, lighting direction, horizon flow, texture size, and perspective across handoff edges.".into(),
            "Treat style as global still-image character, not as an effect that ends at an individual extension area edge.".into(),
        ],
        forbidden_per_crop_artifacts: default_forbidden_artifacts(),
        parts,
    }
}

fn default_forbidden_artifacts() -> Vec<String> {
    vec![
        "vignettes or dark corners inside an individual crop".into(),
        "borders, film frame edges, matte edges, or picture-in-picture framing".into(),
        "localized light leaks, corner shadows, lens masks, or edge fades that do not continue across the final image".into(),
        "story progression, next-moment scenes, new camera angles, zoomed-out views, or alternate shots in extension areas".into(),
        "duplicated main subjects or restarted standalone compositions in extension areas".into(),
    ]
}

fn clean_text(value: &str, field: &str) -> Result<String, String> {
    let text = sanitize_split_tile_words(&value.split_whitespace().collect::<Vec<_>>().join(" "));
    if text.is_empty() {
        return Err(format!("{field} is empty."));
    }
    if contains_forbidden_geometry(&text) {
        return Err(format!("{field} contains canvas geometry."));
    }
    Ok(text.chars().take(700).collect())
}

fn clean_plan_text(value: &str, field: &str) -> Result<String, String> {
    let text = clean_text(value, field)?;
    if contains_forbidden_extension_plan_text(&text) {
        return Err(format!(
            "{field} contains story-continuation or reframing language."
        ));
    }
    Ok(text)
}

fn clean_list(values: &[String], field: &str) -> Result<Vec<String>, String> {
    let mut cleaned = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let value = clean_text(value, &format!("{field} item {}", index + 1))?;
        if !cleaned.contains(&value) {
            cleaned.push(value);
        }
    }
    Ok(cleaned)
}

fn clean_plan_list(values: &[String], field: &str) -> Result<Vec<String>, String> {
    let mut cleaned = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let value = clean_plan_text(value, &format!("{field} item {}", index + 1))?;
        if !cleaned.contains(&value) {
            cleaned.push(value);
        }
    }
    Ok(cleaned)
}

fn sanitize_split_tile_words(value: &str) -> String {
    value
        .replace("SPLIT", "EXTENSION")
        .replace("Split", "Extension")
        .replace("split", "extension")
        .replace("TILING", "EXTENSION")
        .replace("Tiling", "Extension")
        .replace("tiling", "extension")
        .replace("TILES", "AREAS")
        .replace("Tiles", "Areas")
        .replace("tiles", "areas")
        .replace("TILE", "AREA")
        .replace("Tile", "Area")
        .replace("tile", "area")
}

fn has_dimension_pattern(value: &str) -> bool {
    let chars = value.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        if !chars[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let mut cursor = index;
        while cursor < chars.len() && chars[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor < chars.len()
            && matches!(chars[cursor], 'x' | 'X')
            && cursor + 1 < chars.len()
            && chars[cursor + 1].is_ascii_digit()
        {
            return true;
        }
        index = cursor + 1;
    }
    false
}

fn contains_part_number(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    (1..=32).any(|index| lower.contains(&format!("part {index}")))
}

fn contains_forbidden_geometry(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    has_dimension_pattern(value)
        || contains_part_number(value)
        || lower.contains("coordinate")
        || lower.contains("x=")
        || lower.contains("y=")
        || lower.contains("width=")
        || lower.contains("height=")
        || lower.contains("crop rectangle")
}

fn contains_forbidden_extension_plan_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let phrases = [
        "story continuation",
        "narrative continuation",
        "continues the story",
        "continue the story",
        "continue a story",
        "later in the story",
        "story development",
        "storytelling continuation",
        "story-telling continuation",
        "time progression",
        "scene progresses",
        "next moment",
        "new moment",
        "later moment",
        "new shot",
        "alternate shot",
        "different shot",
        "new scene",
        "alternate view",
        "different view",
        "new camera angle",
        "different camera angle",
        "alternate camera",
        "zoomed out",
        "zoom out to",
        "zoom out from",
        "pull back",
        "pulled back",
        "complete the wide shot",
    ];

    phrases.iter().any(|phrase| {
        let mut search_from = 0;
        while let Some(relative) = lower[search_from..].find(phrase) {
            let start = search_from + relative;
            let prefix_start = start.saturating_sub(96);
            let prefix = &lower[prefix_start..start];
            let negated = prefix.contains("do not ")
                || prefix.contains("not ")
                || prefix.contains("never ")
                || prefix.contains("avoid ")
                || prefix.contains("without ")
                || prefix.contains("forbid")
                || prefix.contains("forbidden")
                || prefix.contains("no ");
            if !negated {
                return true;
            }
            search_from = start + phrase.len();
        }
        false
    })
}

fn prompt_guidance_starts_with_generation_verb(value: &str) -> bool {
    let lower = value.trim_start().to_ascii_lowercase();
    [
        "extend ",
        "continue ",
        "generate ",
        "create ",
        "create a ",
        "show ",
        "compose ",
        "paint ",
        "fill ",
        "zoom ",
        "pull back",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn extract_json_object(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    (end >= start).then_some(&raw[start..=end])
}

pub(crate) fn parse_fill_storyboard_json(
    raw: &str,
    expected_parts: usize,
) -> Result<FillStoryboard, String> {
    let parse = |text: &str| {
        serde_json::from_str::<FillStoryboard>(text)
            .map_err(|e| format!("storyboard.json is not valid JSON: {e}"))
    };
    let storyboard = parse(raw.trim()).or_else(|_| {
        let extracted = extract_json_object(raw)
            .ok_or_else(|| "storyboard.json does not contain a JSON object.".to_string())?;
        parse(extracted)
    })?;
    normalize_fill_storyboard(storyboard, expected_parts)
}

fn normalize_fill_storyboard(
    mut storyboard: FillStoryboard,
    expected_parts: usize,
) -> Result<FillStoryboard, String> {
    if expected_parts == 0 {
        return Err("storyboard requires at least one crop.".into());
    }
    if storyboard.version != 1 {
        return Err("storyboard.json version must be 1.".into());
    }
    if storyboard.parts.len() != expected_parts {
        return Err(format!(
            "storyboard.json must contain {expected_parts} crop roles."
        ));
    }

    storyboard.global_scene_intent =
        clean_plan_text(&storyboard.global_scene_intent, "globalSceneIntent")?;
    storyboard.global_style_rules = clean_list(&storyboard.global_style_rules, "globalStyleRules")?;
    if storyboard.global_style_rules.is_empty() {
        return Err("globalStyleRules must not be empty.".into());
    }
    storyboard.forbidden_per_crop_artifacts = clean_list(
        &storyboard.forbidden_per_crop_artifacts,
        "forbiddenPerCropArtifacts",
    )?;
    if storyboard.forbidden_per_crop_artifacts.is_empty() {
        storyboard.forbidden_per_crop_artifacts = default_forbidden_artifacts();
    }

    for (index, part) in storyboard.parts.iter_mut().enumerate() {
        if part.index != index + 1 {
            return Err("storyboard part indexes must be sequential.".into());
        }
        part.role = clean_text(&part.role, "part role")?;
        part.continuity_edges = clean_list(&part.continuity_edges, "continuityEdges")?;
        part.expected_content = clean_plan_list(&part.expected_content, "expectedContent")?;
        part.prompt_guidance = clean_plan_text(&part.prompt_guidance, "promptGuidance")?;
        if prompt_guidance_starts_with_generation_verb(&part.prompt_guidance) {
            return Err(
                "promptGuidance must be a draft-refinement instruction, not a broad generation instruction."
                    .into(),
            );
        }
        if part.continuity_edges.is_empty() || part.expected_content.is_empty() {
            return Err("storyboard parts require continuityEdges and expectedContent.".into());
        }
    }

    Ok(storyboard)
}

pub(crate) fn read_fill_storyboard_file(
    job_path: &Path,
    expected_parts: usize,
) -> Result<FillStoryboard, String> {
    let raw = fs::read_to_string(job_path.join(FILL_STORYBOARD_FILE))
        .map_err(|e| format!("Failed to read storyboard.json: {e}"))?;
    parse_fill_storyboard_json(&raw, expected_parts)
}

pub(crate) fn write_fill_storyboard_file(
    job_path: &Path,
    storyboard: &FillStoryboard,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(storyboard)
        .map_err(|e| format!("Failed to serialize storyboard.json: {e}"))?;
    fs::write(job_path.join(FILL_STORYBOARD_FILE), json)
        .map_err(|e| format!("Failed to write storyboard.json: {e}"))
}

pub(crate) fn record_fill_storyboard_failure(job_path: &Path, reason: &str) {
    let _ = fs::write(job_path.join(FILL_STORYBOARD_ERROR_FILE), reason);
}

pub(crate) fn preserve_invalid_fill_storyboard_file(job_path: &Path) {
    if let Ok(raw) = fs::read(job_path.join(FILL_STORYBOARD_FILE)) {
        let _ = fs::write(job_path.join(FILL_STORYBOARD_INVALID_FILE), raw);
    }
}

pub(crate) fn fill_storyboard_part_prompt(
    storyboard: &FillStoryboard,
    part_index: usize,
    has_storyboard_draft: bool,
) -> String {
    if has_storyboard_draft {
        return String::new();
    }
    let part = storyboard
        .parts
        .get(part_index)
        .or_else(|| storyboard.parts.first())
        .expect("validated storyboard has at least one part");
    format!(
        r#"Orchestrator subtask prompt:
Role: {role}
{guidance}

Use this subtask prompt as the content instruction for the image-generation tool. Do not expand it with a separate scene brief or repeat the full original user prompt unless the subtask prompt itself asks for it."#,
        role = part.role,
        guidance = part.prompt_guidance,
    )
}

pub(crate) fn fill_storyboard_part_is_anchor(
    storyboard: &FillStoryboard,
    part_index: usize,
) -> bool {
    storyboard
        .parts
        .get(part_index)
        .or_else(|| storyboard.parts.first())
        .map(|part| {
            let role = part.role.to_ascii_lowercase();
            part_index == 0 || role.contains("anchor")
        })
        .unwrap_or(part_index == 0)
}

fn planned_roles_summary(placement: &AiEditPlacement) -> String {
    placement
        .parts
        .iter()
        .enumerate()
        .map(|(index, _part)| {
            let planned = planned_part(placement, index);
            format!(
                "- index {}: role `{}`; {}",
                index + 1,
                planned.role,
                planned.continuity_edges.join("; ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn fill_storyboard_antigravity_draft_aspect_label(
    placement: &AiEditPlacement,
) -> &'static str {
    let target_aspect =
        f64::from(placement.document_dimensions.0) / f64::from(placement.document_dimensions.1);
    ai_antigravity_image_capability()
        .aspect_ratios
        .iter()
        .min_by(|a, b| {
            let a_error = (f64::from(a.width) / f64::from(a.height.max(1)) - target_aspect).abs();
            let b_error = (f64::from(b.width) / f64::from(b.height.max(1)) - target_aspect).abs();
            a_error.total_cmp(&b_error)
        })
        .map(|ratio| ratio.label.as_str())
        .unwrap_or("16:9")
}

fn draft_generation_note(
    placement: &AiEditPlacement,
    draft_canvas_path: &str,
    draft_mask_path: &str,
) -> String {
    match placement.provider {
        AiEditProvider::Antigravity => {
            let aspect_label = fill_storyboard_antigravity_draft_aspect_label(placement);
            format!(
                "- Use `{draft_canvas_path}` as the base image for a mask-guided draft image edit, and attach `{draft_mask_path}` as the edit mask. Set the Antigravity aspect-ratio parameter to `{aspect_label}` and the size tier to `1K`. Compose only inside the white mask area; keep black-mask provider padding plain and unchanged. PaintNode will crop the provider frame back to the real composition before parts use it."
            )
        }
        AiEditProvider::Codex => "- For the draft image tool call, use the closest flexible canvas shape to the full PaintNode composition. It can be low-resolution and slightly rough; composition, subject placement, horizon, lighting, and continuity matter more than detail.".into(),
    }
}

pub(crate) fn fill_storyboard_master_prompt(
    user_prompt: &str,
    provider_label: &str,
    job_dir: &str,
    placement: &AiEditPlacement,
    reference_names: &[String],
) -> String {
    let storyboard_path = if job_dir == "." {
        FILL_STORYBOARD_FILE.to_string()
    } else {
        format!("{job_dir}/{FILL_STORYBOARD_FILE}")
    };
    let draft_path = if job_dir == "." {
        FILL_STORYBOARD_DRAFT_FILE.to_string()
    } else {
        format!("{job_dir}/{FILL_STORYBOARD_DRAFT_FILE}")
    };
    let overview_path = if job_dir == "." {
        FILL_STORYBOARD_OVERVIEW_FILE.to_string()
    } else {
        format!("{job_dir}/{FILL_STORYBOARD_OVERVIEW_FILE}")
    };
    let draft_canvas_path = if job_dir == "." {
        FILL_STORYBOARD_DRAFT_CANVAS_FILE.to_string()
    } else {
        format!("{job_dir}/{FILL_STORYBOARD_DRAFT_CANVAS_FILE}")
    };
    let draft_mask_path = if job_dir == "." {
        FILL_STORYBOARD_DRAFT_MASK_FILE.to_string()
    } else {
        format!("{job_dir}/{FILL_STORYBOARD_DRAFT_MASK_FILE}")
    };
    let draft_canvas_input_note = match placement.provider {
        AiEditProvider::Antigravity => format!(
            "\n- `{draft_canvas_path}`: provider-ratio draft scaffold.\n- `{draft_mask_path}`: draft edit mask. White marks the PaintNode composition area to fill; black marks protected provider padding that must stay plain and must not become final content."
        ),
        AiEditProvider::Codex => String::new(),
    };
    let reference_note = if reference_names.is_empty() {
        "- No additional user reference images are attached.".to_string()
    } else {
        let prefix = if job_dir == "." {
            String::new()
        } else {
            format!("{job_dir}/")
        };
        let mut lines = vec!["Additional user reference images:".to_string()];
        for name in reference_names {
            lines.push(format!("- `{prefix}{name}`"));
        }
        lines.join("\n")
    };
    let draft_note = draft_generation_note(placement, &draft_canvas_path, &draft_mask_path);
    format!(
        r#"Create a master draft-and-refinement plan for a PaintNode split generative fill. Save the JSON plan as `{storyboard_path}` and a rough visual draft as `{draft_path}`.

Role:
- You are the master image editor and AI Director for the selected {provider_label} image-fill session.
- This is spatial extension of one still image into white mask areas. It is not story continuation, time progression, a new shot, a zoom-out, an alternate view, or a new camera angle.
- Keep the same moment, camera position, perspective, horizon, lighting, subject scale, and texture scale across the final composed image.
- Use image generation only once to create the low-resolution draft plate. Do not create `result.png`; the part agents create final pixels later.
- The visual draft is the composition authority for later part agents. They will not author new scene content; they will retouch/up-res the draft inside their local masks.
- Review the user intent, the planned extension roles, and the attached overview/reference images, then write `{storyboard_path}` and `{draft_path}`.

Input files:
- `{overview_path}`: preview of the full PaintNode composition and editable area, with no crop outline. Use it for composition only.
- `placement.json`: machine-readable crop and paste data. Use it only to understand extension ordering. Do not copy pixel dimensions, coordinates, crop rectangles, or aspect labels into any plan prose.
{draft_canvas_input_note}
{reference_note}

Original user fill prompt:
{user_prompt}

Treat the original prompt as final still-image intent and global style, not as permission to repeat all subjects in every extension area.

Provider and frame plan:
- Provider: {provider_label}
- Frame plan: {method}

Planned extension roles:
{roles}

Required JSON schema for `{storyboard_path}`:
{{
  "version": 1,
  "globalSceneIntent": "one concise sentence",
  "globalStyleRules": ["style rule", "style rule"],
  "forbiddenPerCropArtifacts": ["artifact to avoid", "artifact to avoid"],
  "parts": [
    {{
      "index": 1,
      "role": "left draft-refinement anchor",
      "continuityEdges": ["qualitative edge handoff"],
      "expectedContent": ["what the draft should show in this refinement area"],
      "promptGuidance": "complete local image-tool instruction for refining this draft area"
    }}
  ]
}}

Draft/refinement plan rules:
- Include one `parts` entry for every planned extension index listed above, with sequential `index` values.
- Use qualitative roles such as left draft-refinement anchor, center draft-refinement area, right draft-refinement area, top draft-refinement anchor, or bottom draft-refinement area.
- Separate global style from crop-local artifacts. Film color, grain, lens feel, and perspective can be global style. Vignettes, dark corners, borders, frame edges, localized light leaks, and edge fades must be forbidden inside individual extension areas unless they continue across the final composed image.
- `promptGuidance` is the local refinement prompt that PaintNode will pass to the crop agent after the rough draft has been embedded into `source.png` and `edit_target.png`. Make it concise and directly usable as an instruction to refine/up-res the visible draft, not to invent a new composition.
- Start each `promptGuidance` with a refinement verb such as Refine, Render, Sharpen, or Detail. Do not start with Extend, Continue, Generate, Create a new, Zoom out, or Pull back.
- Tell anchor areas to refine the draft according to the original prompt, including the requested main subject and requested companions only where the draft places them. Also tell anchor areas to avoid self-contained endings at handoff edges.
- Treat the original prompt as final composition intent. You may assign requested subjects, companions, props, and background elements to any extension area when they spatially belong there in one coherent still image.
- Do not force every area to repeat the full prompt. Each area should receive only the local content it owns in the final composition.
- Do not duplicate an already-finished primary subject unless the user requested multiple similar subjects, companions, or group activity, or unless a cut-off subject/object visibly continues through the editable mask.
- For non-anchor areas, refine whatever the draft already places in the white mask and match the protected neighboring pixels at the same still-image moment, scale, lens perspective, camera position, horizon, lighting, and texture.
- Non-anchor `promptGuidance` must be a local image-editor instruction for improving the existing low-detail draft inside the white mask, not a broad outpainting request, repair-only instruction, or new story beat.
- Explicitly say the visible draft wins over text if there is any conflict. Do not add people, props, activities, or a separate scene unless they are already visible in the draft or needed to finish a cut-off visible element.
- Do not describe new storytelling beats, story development, a later moment, a new scene, a new shot, a zoom-out, an alternate camera view, or a smaller repeated version of an existing subject.
- Do not include pixel dimensions, coordinates, crop rectangles, `part N of N` wording, or split/tile wording inside string fields.
- Draft image requirements:
  - Generate `{draft_path}` as a rough complete visual plate for the final composed image, not as a polished final output.
  - The draft should establish subject placement, large shapes, horizon/ground plane, lighting direction, camera feel, and continuity across all extension areas.
  - It may be low-resolution, soft, and missing fine detail, but it must not include borders, frames, masks, checkerboards, UI, red guide marks, labels, or multiple panels.
  - Later part agents will use this draft as the locked composition guide while rendering their own local high-quality crop. They should refine what is visible in the draft, not invent new scene content.
  {draft_note}
- Finish with one short confirmation after both files are written. Do not stop after writing only `{storyboard_path}`; `{draft_path}` is required because later part agents use it as their visual composition authority."#,
        method = fill_method_label(placement.method),
        roles = planned_roles_summary(placement),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::canvas::PixelRect;
    use crate::ai::placement::{plan_ai_fill_placement, AiEditProvider, AiFillRedundancy};

    fn mask_png_with_rects(width: u32, height: u32, rects: &[PixelRect]) -> Vec<u8> {
        let mut image = image::RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 0]));
        for rect in rects {
            for y in rect.y..rect.y + rect.height {
                for x in rect.x..rect.x + rect.width {
                    image.put_pixel(x, y, image::Rgba([255, 255, 255, 255]));
                }
            }
        }
        crate::png::encode_rgba_png(image, "mask").expect("mask png")
    }

    fn split_placement() -> AiEditPlacement {
        let mask = mask_png_with_rects(
            13000,
            400,
            &[PixelRect {
                x: 0,
                y: 0,
                width: 13000,
                height: 400,
            }],
        );
        plan_ai_fill_placement(
            AiEditProvider::Antigravity,
            AiFillMethod::Auto,
            AiFillRedundancy::High,
            (13000, 400),
            &mask,
            None,
            "Generative fill",
        )
        .expect("split placement")
    }

    #[test]
    fn fallback_storyboard_assigns_spatial_extension_roles() {
        let placement = split_placement();
        let storyboard = fallback_fill_storyboard(&placement);
        assert!(should_storyboard_fill(&placement));
        assert!(storyboard.fallback);
        assert_eq!(storyboard.parts.len(), placement.parts.len());
        assert_eq!(storyboard.parts[0].role, "left draft-refinement anchor");
        assert!(storyboard.parts[0]
            .prompt_guidance
            .contains("Refine the low-detail draft"));
        assert!(storyboard.parts[1].role.contains("draft-refinement area"));
        assert!(storyboard.parts[1]
            .prompt_guidance
            .contains("Do not forward the full user prompt verbatim"));
        assert!(storyboard.parts[1]
            .prompt_guidance
            .contains("do not continue a story"));
        assert!(storyboard.parts[1]
            .prompt_guidance
            .contains("add new people, props, or activities beyond what is already visible"));
        assert!(storyboard
            .forbidden_per_crop_artifacts
            .iter()
            .any(|item| item.contains("vignettes or dark corners")));
    }

    #[test]
    fn parse_storyboard_rejects_geometry_and_accepts_schema() {
        let valid = r#"{
          "version": 1,
          "globalSceneIntent": "A coherent beach still image extends across every area.",
          "globalStyleRules": ["Keep film grain and wide lens perspective global."],
          "forbiddenPerCropArtifacts": ["No vignettes or dark corners inside one crop."],
          "parts": [
            {
              "index": 1,
              "role": "left draft-refinement anchor",
              "continuityEdges": ["right handoff edge keeps the horizon and shoreline open"],
              "expectedContent": ["Establish the beach and leave the shoreline open."],
              "promptGuidance": "Refine the anchor draft without edge darkening."
            },
            {
              "index": 2,
              "role": "right draft-refinement area",
              "continuityEdges": ["left handoff edge extends the finished neighboring water"],
              "expectedContent": ["Continue water, beach, and horizon."],
              "promptGuidance": "Refine the visible draft into the same still image."
            }
          ]
        }"#;
        let storyboard = parse_fill_storyboard_json(valid, 2).expect("valid storyboard");
        assert_eq!(storyboard.parts[1].role, "right draft-refinement area");

        let invalid = valid.replace(
            "Refine the visible draft into the same still image.",
            "Continue pixels from x=1086 in the 3000x800 document.",
        );
        let error = parse_fill_storyboard_json(&invalid, 2).expect_err("geometry rejected");
        assert!(error.contains("canvas geometry"));

        let narrative = valid.replace(
            "Refine the visible draft into the same still image.",
            "Zoomed out alternate shot from a new camera angle.",
        );
        let error = parse_fill_storyboard_json(&narrative, 2).expect_err("narrative rejected");
        assert!(error.contains("story-continuation or reframing"));

        let broad_generation = valid.replace(
            "Refine the visible draft into the same still image.",
            "Extend the sandy beach and ocean scene to the right.",
        );
        let error = parse_fill_storyboard_json(&broad_generation, 2)
            .expect_err("broad generation rejected");
        assert!(error.contains("draft-refinement instruction"));

        let added_subjects = valid.replace(
            "Continue water, beach, and horizon.",
            "Additional female friends playing in the background, adding depth to the group vacation scene.",
        );
        let storyboard = parse_fill_storyboard_json(&added_subjects, 2)
            .expect("orchestrator can allocate requested companions to a non-anchor area");
        assert!(storyboard.parts[1].expected_content[0].contains("Additional female friends"));

        let spatial_continuation = valid.replace(
            "Refine the visible draft into the same still image.",
            "Refine the existing draft area into the same wide-angle train interior, matching the protected left edge in perspective, light, and texture. Sharpen the bench, windows, and seaside background details without changing the composition or adding a new scene beat.",
        );
        parse_fill_storyboard_json(&spatial_continuation, 2)
            .expect("spatial continuation with negated story-beat language is valid");

        let negated_subjects = valid.replace(
            "Continue water, beach, and horizon.",
            "Continue water, beach, and horizon. No duplicate main subjects, extra friends, or new focal elements.",
        );
        parse_fill_storyboard_json(&negated_subjects, 2)
            .expect("negated extra subjects are allowed");

        let anchor_friends = valid.replace(
            "Establish the beach and leave the shoreline open.",
            "Include the requested primary subject with additional friends only where they naturally belong in this anchor.",
        );
        parse_fill_storyboard_json(&anchor_friends, 2)
            .expect("anchor can include requested friends");
    }

    #[test]
    fn part_prompt_uses_extension_plan_without_forwarding_full_prompt() {
        let placement = split_placement();
        let storyboard = fallback_fill_storyboard(&placement);
        let anchor = fill_storyboard_part_prompt(&storyboard, 0, true);
        assert_eq!(anchor, "");

        let continuation = fill_storyboard_part_prompt(&storyboard, 1, true);
        assert_eq!(continuation, "");

        let no_draft = fill_storyboard_part_prompt(&storyboard, 1, false);
        assert!(no_draft.contains("Orchestrator subtask prompt"));
        assert!(no_draft.contains("Use this subtask prompt as the content instruction"));
    }

    #[test]
    fn master_prompt_frames_split_fill_as_same_photo_outpainting() {
        let placement = split_placement();
        let prompt = fill_storyboard_master_prompt(
            "film beach photo with a woman and friends",
            "Antigravity",
            ".",
            &placement,
            &[],
        );

        assert!(prompt.contains("spatial extension of one still image"));
        assert!(prompt.contains("draft-and-refinement plan"));
        assert!(prompt.contains("not story continuation"));
        assert!(prompt.contains("storyboard-draft-result.png"));
        assert!(prompt.contains("storyboard-draft-canvas.png"));
        assert!(prompt.contains("storyboard-draft-mask.png"));
        assert!(prompt.contains("rough complete visual plate"));
        assert!(prompt.contains("visual draft is the composition authority"));
        assert!(prompt.contains("provider-ratio draft scaffold"));
        assert!(prompt.contains("mask-guided draft image edit"));
        assert!(prompt.contains("Compose only inside the white mask area"));
        assert!(prompt.contains("Antigravity aspect-ratio parameter"));
        assert!(prompt.contains("size tier to `1K`"));
        assert!(prompt.contains("Treat the original prompt as final composition intent"));
        assert!(prompt.contains("You may assign requested subjects"));
        assert!(prompt.contains("`promptGuidance` is the local refinement prompt"));
        assert!(prompt.contains("refine/up-res the visible draft"));
        assert!(prompt.contains("Start each `promptGuidance` with a refinement verb"));
        assert!(prompt.contains("For non-anchor areas, refine whatever the draft already places"));
        assert!(prompt.contains("not a broad outpainting request"));
        assert!(prompt.contains("visible draft wins over text"));
        assert!(prompt.contains("Tell anchor areas to refine the draft"));
        assert!(prompt.contains("Film color, grain, lens feel, and perspective can be global"));
        assert!(prompt.contains("Vignettes, dark corners, borders"));
        assert!(prompt.contains("Do not describe new storytelling beats"));
        assert!(prompt.contains("with no crop outline"));
        assert!(!prompt.contains("Do not call any image-generation tool"));
        assert!(!prompt.contains("Output valid JSON only"));
        assert!(!prompt.contains("part 1 of"));
        assert!(!prompt.contains("3000x800"));
    }
}
