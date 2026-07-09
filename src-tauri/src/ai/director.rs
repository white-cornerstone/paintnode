//! Shared AI Director tool-loop contract.
//!
//! PaintNode keeps deterministic ownership of files, masks, provider calls, and
//! import. The selected Director provider owns the decision loop through a small
//! job-folder protocol: write an action, receive a PaintNode observation, then
//! accept, retry, or fail.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::ai::{AgentRunResult, AiDirectorInvolvement, AiDirectorMode};

pub(crate) const PAINTNODE_DIRECTOR_ACTION_FILE: &str = "paintnode-director-action.json";
pub(crate) const PAINTNODE_DIRECTOR_OBSERVATION_FILE: &str = "paintnode-director-observation.json";
pub(crate) const PAINTNODE_DIRECTOR_FINAL_FILE: &str = "paintnode-director-final.json";
pub(crate) const PAINTNODE_DIRECTOR_TIMELINE_FILE: &str = "paintnode-director-timeline.jsonl";

const PAINTNODE_DIRECTOR_FULL_REVIEW_MAX_TURNS: usize = 5;
const PAINTNODE_DIRECTOR_ENSURE_COMPLETION_MAX_TURNS: usize = 3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct DirectorImageRequest {
    pub(crate) base_image: String,
    pub(crate) prompt: String,
    pub(crate) constraints: Vec<String>,
    pub(crate) avoid: Vec<String>,
    pub(crate) notes: String,
}

impl Default for DirectorImageRequest {
    fn default() -> Self {
        Self {
            base_image: "source.png".into(),
            prompt: String::new(),
            constraints: Vec::new(),
            avoid: Vec::new(),
            notes: String::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DirectorActionKind {
    GenerateCandidate,
    AcceptResult,
    Fail,
}

fn default_director_action_kind() -> DirectorActionKind {
    DirectorActionKind::GenerateCandidate
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectorAction {
    #[serde(default = "default_director_action_kind")]
    pub(crate) action: DirectorActionKind,
    #[serde(default)]
    pub(crate) base_image: Option<String>,
    #[serde(default)]
    pub(crate) prompt: String,
    #[serde(default)]
    pub(crate) constraints: Vec<String>,
    #[serde(default)]
    pub(crate) avoid: Vec<String>,
    #[serde(default)]
    pub(crate) notes: Option<String>,
    #[serde(default)]
    pub(crate) candidate: Option<String>,
    #[serde(default)]
    pub(crate) reason: Option<String>,
}

impl DirectorAction {
    pub(crate) fn from_image_request(request: DirectorImageRequest) -> Self {
        Self {
            action: DirectorActionKind::GenerateCandidate,
            base_image: Some(request.base_image),
            prompt: request.prompt,
            constraints: request.constraints,
            avoid: request.avoid,
            notes: Some(request.notes),
            candidate: None,
            reason: None,
        }
    }

    pub(crate) fn into_image_request(self) -> Result<DirectorImageRequest, String> {
        let prompt = self.prompt.trim();
        if prompt.is_empty() {
            return Err(
                "PaintNode Director action must include a non-empty `prompt` for `generateCandidate`."
                    .into(),
            );
        }
        Ok(DirectorImageRequest {
            base_image: self
                .base_image
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "source.png".into()),
            prompt: prompt.to_string(),
            constraints: self.constraints,
            avoid: self.avoid,
            notes: self.notes.unwrap_or_default(),
        })
    }
}

pub(crate) struct DirectorCandidate<T> {
    pub(crate) result: T,
    pub(crate) file_name: String,
}

pub(crate) struct DirectorLoopSpec<'a> {
    pub(crate) provider_label: &'a str,
    pub(crate) involvement: AiDirectorInvolvement,
    pub(crate) legacy_request_file: &'a str,
    pub(crate) base_prompt_text: &'a str,
    pub(crate) review_criteria: &'a str,
    pub(crate) ensure_completion_acceptance_note: &'a str,
}

pub(crate) fn director_uses_agentic_loop(
    mode: AiDirectorMode,
    involvement: AiDirectorInvolvement,
) -> bool {
    mode != AiDirectorMode::Skip && involvement != AiDirectorInvolvement::PlanOnly
}

pub(crate) fn director_candidate_file(turn: usize) -> String {
    format!("director-candidate-{turn}.png")
}

pub(crate) fn clear_director_action_files(part_path: &Path, legacy_request_file: &str) {
    let _ = fs::remove_file(part_path.join(PAINTNODE_DIRECTOR_ACTION_FILE));
    let _ = fs::remove_file(part_path.join(legacy_request_file));
}

pub(crate) fn read_director_action_or_legacy_request(
    part_path: &Path,
    legacy_request_file: &str,
) -> Result<DirectorAction, String> {
    let action_path = part_path.join(PAINTNODE_DIRECTOR_ACTION_FILE);
    if action_path.exists() {
        let text = fs::read_to_string(&action_path).map_err(|e| {
            format!(
                "Failed to read PaintNode Director action at {}: {e}",
                action_path.display()
            )
        })?;
        return serde_json::from_str::<DirectorAction>(&text).map_err(|e| {
            format!(
                "PaintNode Director action at {} is invalid JSON: {e}",
                action_path.display()
            )
        });
    }

    let legacy_path = part_path.join(legacy_request_file);
    if legacy_path.exists() {
        let text = fs::read_to_string(&legacy_path).map_err(|e| {
            format!(
                "Failed to read legacy PaintNode image request at {}: {e}",
                legacy_path.display()
            )
        })?;
        let request: DirectorImageRequest = serde_json::from_str(&text).map_err(|e| {
            format!(
                "Legacy PaintNode image request at {} is invalid JSON: {e}",
                legacy_path.display()
            )
        })?;
        return Ok(DirectorAction::from_image_request(request));
    }

    Err(format!(
        "The AI Director did not create `{PAINTNODE_DIRECTOR_ACTION_FILE}`."
    ))
}

pub(crate) fn write_director_json(
    part_path: &Path,
    file_name: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(&payload)
        .map_err(|e| format!("Failed to encode PaintNode Director {file_name}: {e}"))?;
    fs::write(part_path.join(file_name), text)
        .map_err(|e| format!("Failed to write PaintNode Director {file_name}: {e}"))
}

fn append_director_timeline_event(
    part_path: &Path,
    payload: serde_json::Value,
) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(part_path.join(PAINTNODE_DIRECTOR_TIMELINE_FILE))
        .map_err(|e| format!("Failed to open PaintNode Director timeline: {e}"))?;
    let text = serde_json::to_vec(&payload)
        .map_err(|e| format!("Failed to encode PaintNode Director timeline event: {e}"))?;
    file.write_all(&text)
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("Failed to write PaintNode Director timeline event: {e}"))
}

pub(crate) fn write_director_turn_action(
    part_path: &Path,
    turn: usize,
    action: &DirectorAction,
) -> Result<(), String> {
    let payload = json!({
        "version": 1,
        "turn": turn,
        "event": "directorAction",
        "action": action,
    });
    write_director_json(
        part_path,
        &format!("director-turn-{turn}-action.json"),
        payload.clone(),
    )?;
    append_director_timeline_event(part_path, payload)
}

pub(crate) fn write_director_observation(
    part_path: &Path,
    turn: usize,
    status: &str,
    candidate_file: Option<&str>,
    message: &str,
) -> Result<(), String> {
    let payload = json!({
        "version": 1,
        "turn": turn,
        "event": "paintnodeObservation",
        "status": status,
        "candidate": candidate_file.map(|file| json!({ "file": file })),
        "message": message,
    });
    write_director_json(
        part_path,
        PAINTNODE_DIRECTOR_OBSERVATION_FILE,
        payload.clone(),
    )?;
    write_director_json(
        part_path,
        &format!("director-turn-{turn}-observation.json"),
        payload.clone(),
    )?;
    append_director_timeline_event(part_path, payload)
}

fn director_involvement_label(involvement: AiDirectorInvolvement) -> &'static str {
    match involvement {
        AiDirectorInvolvement::PlanOnly => "planOnly",
        AiDirectorInvolvement::EnsureCompletion => "ensureCompletion",
        AiDirectorInvolvement::FullReview => "fullReview",
    }
}

pub(crate) fn write_director_final(
    part_path: &Path,
    status: &str,
    provider_label: &str,
    involvement: AiDirectorInvolvement,
    candidate_file: Option<&str>,
    notes: &str,
) -> Result<(), String> {
    let payload = json!({
        "version": 1,
        "event": "directorFinal",
        "status": status,
        "provider": provider_label,
        "involvement": director_involvement_label(involvement),
        "candidate": candidate_file.map(|file| json!({ "file": file })),
        "notes": notes,
    });
    write_director_json(part_path, PAINTNODE_DIRECTOR_FINAL_FILE, payload.clone())?;
    append_director_timeline_event(part_path, payload)
}

pub(crate) fn director_turn_prompt(
    turn: usize,
    involvement: AiDirectorInvolvement,
    review_criteria: &str,
) -> String {
    let review_instruction = match involvement {
        AiDirectorInvolvement::EnsureCompletion => {
            "If the observation reports a failed image-tool call, write a new `generateCandidate` action with the smallest faithful prompt adjustment. If a candidate completed, no review turn should be needed."
        }
        AiDirectorInvolvement::FullReview => {
            "Inspect the latest candidate image, any attached source/reference images, and `paintnode-director-observation.json`. Write `acceptResult` only if the candidate satisfies the task and the workflow review criteria. Otherwise write another `generateCandidate` action with the smallest useful correction."
        }
        AiDirectorInvolvement::PlanOnly => "Write one `generateCandidate` action only.",
    };
    let review_criteria = review_criteria.trim();
    let criteria_section = if review_criteria.is_empty() {
        String::new()
    } else {
        format!("\nWorkflow review criteria:\n{review_criteria}\n")
    };
    format!(
        r#"Continue as PaintNode's AI Director for turn {turn}.

{review_instruction}
{criteria_section}
Tool protocol:
- Read `prompt.txt` for the original PaintNode Director brief when you need the task context.
- Read `{PAINTNODE_DIRECTOR_OBSERVATION_FILE}` for the latest PaintNode tool result.
- Write `{PAINTNODE_DIRECTOR_ACTION_FILE}` as UTF-8 JSON in the current working directory.
- Choose exactly one action: `generateCandidate`, `acceptResult`, or `fail`.
- Do not invoke image-generation tools yourself, do not create `result.png`, and do not edit files other than `{PAINTNODE_DIRECTOR_ACTION_FILE}`.
- Do not ask follow-up questions.

Action examples:
{{ "version": 1, "action": "acceptResult", "candidate": "latest", "notes": "accepted" }}
{{ "version": 1, "action": "generateCandidate", "baseImage": "source.png", "prompt": "revised prompt", "constraints": [], "avoid": [], "notes": "retry reason" }}
{{ "version": 1, "action": "fail", "reason": "short reason" }}"#
    )
}

pub(crate) fn reset_director_loop_files(part_path: &Path) {
    let _ = fs::remove_file(part_path.join(PAINTNODE_DIRECTOR_OBSERVATION_FILE));
    let _ = fs::remove_file(part_path.join(PAINTNODE_DIRECTOR_FINAL_FILE));
    let _ = fs::remove_file(part_path.join(PAINTNODE_DIRECTOR_TIMELINE_FILE));
    if let Ok(entries) = fs::read_dir(part_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if file_name.starts_with("director-turn-")
                && (file_name.ends_with("-prompt.txt")
                    || file_name.ends_with("-action.json")
                    || file_name.ends_with("-observation.json"))
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}

pub(crate) fn run_candidate_director_loop<T, RunTurn, FinalMessage, GenerateCandidate>(
    part_path: &Path,
    spec: DirectorLoopSpec<'_>,
    mut run_turn: RunTurn,
    mut final_agent_message: FinalMessage,
    mut generate_candidate: GenerateCandidate,
) -> Result<T, String>
where
    RunTurn: FnMut(usize, &str, Option<&Path>) -> Result<AgentRunResult, String>,
    FinalMessage: FnMut(&AgentRunResult) -> Option<String>,
    GenerateCandidate:
        FnMut(usize, DirectorImageRequest, &str) -> Result<DirectorCandidate<T>, String>,
{
    let max_turns = match spec.involvement {
        AiDirectorInvolvement::EnsureCompletion => PAINTNODE_DIRECTOR_ENSURE_COMPLETION_MAX_TURNS,
        AiDirectorInvolvement::FullReview => PAINTNODE_DIRECTOR_FULL_REVIEW_MAX_TURNS,
        AiDirectorInvolvement::PlanOnly => 1,
    };
    reset_director_loop_files(part_path);

    let mut latest_result = None::<T>;
    let mut latest_candidate_file = None::<String>;

    for turn in 1..=max_turns {
        clear_director_action_files(part_path, spec.legacy_request_file);
        let prompt_text = if turn == 1 {
            spec.base_prompt_text.to_string()
        } else {
            director_turn_prompt(turn, spec.involvement, spec.review_criteria)
        };
        if turn > 1 {
            fs::write(
                part_path.join(format!("director-turn-{turn}-prompt.txt")),
                &prompt_text,
            )
            .map_err(|e| format!("Failed to write Director turn prompt: {e}"))?;
        }
        let candidate_path = latest_candidate_file
            .as_ref()
            .map(|file| part_path.join(file));
        let run = run_turn(turn, &prompt_text, candidate_path.as_deref())?;
        let action = read_director_action_or_legacy_request(part_path, spec.legacy_request_file)
            .map_err(|error| {
                if let Some(message) = final_agent_message(&run) {
                    format!("{error}\n\n{message}")
                } else {
                    error
                }
            })?;
        write_director_turn_action(part_path, turn, &action)?;

        match action.action {
            DirectorActionKind::GenerateCandidate => {
                let request = action.into_image_request()?;
                let prompt = image_request_prompt(&request)?;
                match generate_candidate(turn, request, &prompt) {
                    Ok(candidate) => {
                        write_director_observation(
                            part_path,
                            turn,
                            "candidateGenerated",
                            Some(&candidate.file_name),
                            "PaintNode generated a candidate image.",
                        )?;
                        latest_candidate_file = Some(candidate.file_name.clone());
                        latest_result = Some(candidate.result);
                        if spec.involvement == AiDirectorInvolvement::EnsureCompletion {
                            write_director_final(
                                part_path,
                                "accepted",
                                spec.provider_label,
                                spec.involvement,
                                latest_candidate_file.as_deref(),
                                spec.ensure_completion_acceptance_note,
                            )?;
                            return latest_result.take().ok_or_else(|| {
                                "PaintNode completed a candidate but could not return it."
                                    .to_string()
                            });
                        }
                    }
                    Err(error) => {
                        write_director_observation(part_path, turn, "toolError", None, &error)?;
                        if turn == max_turns {
                            write_director_final(
                                part_path,
                                "failed",
                                spec.provider_label,
                                spec.involvement,
                                latest_candidate_file.as_deref(),
                                &error,
                            )?;
                            return Err(error);
                        }
                    }
                }
            }
            DirectorActionKind::AcceptResult => {
                let accepted_candidate_file = action
                    .candidate
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && *value != "latest")
                    .map(str::to_string)
                    .or_else(|| latest_candidate_file.clone());
                let notes = action
                    .notes
                    .or(action.reason)
                    .unwrap_or_else(|| "Director accepted the latest candidate.".into());
                let accepted = latest_result.take().ok_or_else(|| {
                    "AI Director accepted a result before PaintNode generated a candidate."
                        .to_string()
                })?;
                write_director_final(
                    part_path,
                    "accepted",
                    spec.provider_label,
                    spec.involvement,
                    accepted_candidate_file.as_deref(),
                    &notes,
                )?;
                return Ok(accepted);
            }
            DirectorActionKind::Fail => {
                let reason = action.reason.or(action.notes).unwrap_or_else(|| {
                    "AI Director reported that the task cannot be completed faithfully.".into()
                });
                write_director_final(
                    part_path,
                    "failed",
                    spec.provider_label,
                    spec.involvement,
                    latest_candidate_file.as_deref(),
                    &reason,
                )?;
                return Err(reason);
            }
        }
    }

    let reason = "AI Director reached its turn limit without accepting a completed candidate.";
    write_director_final(
        part_path,
        "failed",
        spec.provider_label,
        spec.involvement,
        latest_candidate_file.as_deref(),
        reason,
    )?;
    Err(reason.into())
}

pub(crate) fn image_request_prompt(request: &DirectorImageRequest) -> Result<String, String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("PaintNode image request must include a non-empty `prompt`.".into());
    }
    let mut lines = vec![prompt.to_string()];
    if !request.constraints.is_empty() {
        lines.push("\nConstraints:".into());
        for item in &request.constraints {
            let item = item.trim();
            if !item.is_empty() {
                lines.push(format!("- {item}"));
            }
        }
    }
    if !request.avoid.is_empty() {
        lines.push("\nAvoid:".into());
        for item in &request.avoid {
            let item = item.trim();
            if !item.is_empty() {
                lines.push(format!("- {item}"));
            }
        }
    }
    if !request.notes.trim().is_empty() {
        lines.push(format!("\nNotes: {}", request.notes.trim()));
    }
    Ok(lines.join("\n"))
}

pub(crate) fn workflow_review_criteria(workflow: &str) -> &'static str {
    match workflow {
        "generative_fill" => {
            "- Candidate must preserve the source framing, protected context, perspective, lighting, color, focus, grain/texture, and camera style.\n- The editable area should be filled naturally without guide marks, borders, UI, checkerboard transparency, or visible mask edges.\n- Do not accept over-crisp denoising, new unrelated objects, subject duplication, or composition drift."
        }
        "retouch" => {
            "- Candidate must be an in-place retouch: the requested change appears only inside the intended mask footprint.\n- Protected context, identity, face, hair, skin, hands, lighting, perspective, grain/texture, and camera style must remain faithful.\n- Do not accept shifted framing, over-smoothed skin, over-crisp denoising, visible seams, guide marks, or unrequested content changes."
        }
        "restore" | "upscale" => {
            "- Candidate must restore local detail while preserving the original content, framing, camera, color balance, exposure character, focus, and intentional medium texture such as film grain.\n- Do not accept content additions/removals, identity changes, restyling, over-sharpening, plastic denoising, or seams against already-restored areas.\n- If the source is grainy, soft, or over-exposed by intent, keep that character unless the user requested restoration/denoise."
        }
        "decouple" => {
            "- Asset pack must extract meaningful reusable objects from the source, with transparent PNGs and no duplicated visual ownership across assets.\n- Preserve object identity, natural edges, contact logic, and soft alpha details where useful.\n- Manifest entries must point to valid PNG files and describe reusable layer names."
        }
        "image_generation" => {
            "- Candidate must satisfy the user's image prompt and reference-image intent without adding UI, borders, watermarks, contact-sheet layouts, or explanatory text.\n- Preserve requested style, subject relationships, camera/lens/medium character, composition intent, and safety-compliant prompt adjustments.\n- Do not accept blocked-prompt drift, irrelevant subjects, collage output, or over-processed rendering that contradicts the requested medium."
        }
        _ => "- Candidate must satisfy the user request while preserving source-image facts and PaintNode's fixed-frame editing constraints.",
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::ai::TempJobDir;

    #[test]
    fn director_action_parser_accepts_tool_action_and_legacy_request() {
        let job = TempJobDir::new("paintnode-director-action-test").expect("temp dir");
        fs::write(
            job.path().join(PAINTNODE_DIRECTOR_ACTION_FILE),
            r#"{
  "version": 1,
  "action": "generateCandidate",
  "baseImage": "source.png",
  "prompt": "extend the bench",
  "constraints": ["match film grain"],
  "avoid": ["crispy denoise"]
}"#,
        )
        .expect("write action");

        let action =
            read_director_action_or_legacy_request(job.path(), "paintnode-image-request.json")
                .expect("action");
        assert_eq!(action.action, DirectorActionKind::GenerateCandidate);
        let request = action.into_image_request().expect("request");
        assert_eq!(request.prompt, "extend the bench");
        assert_eq!(request.constraints, vec!["match film grain"]);
        assert_eq!(request.avoid, vec!["crispy denoise"]);

        clear_director_action_files(job.path(), "paintnode-image-request.json");
        fs::write(
            job.path().join("paintnode-image-request.json"),
            r#"{
  "baseImage": "source.png",
  "prompt": "continue the wall",
  "constraints": [],
  "avoid": [],
  "notes": "legacy"
}"#,
        )
        .expect("write legacy request");
        let legacy =
            read_director_action_or_legacy_request(job.path(), "paintnode-image-request.json")
                .expect("legacy action");
        assert_eq!(legacy.action, DirectorActionKind::GenerateCandidate);
        assert_eq!(legacy.prompt, "continue the wall");
        assert_eq!(legacy.notes.as_deref(), Some("legacy"));
    }

    #[test]
    fn director_followup_prompt_points_to_context_and_action_schema() {
        let prompt = director_turn_prompt(
            2,
            AiDirectorInvolvement::FullReview,
            workflow_review_criteria("upscale"),
        );

        assert!(prompt.contains("Read `prompt.txt`"));
        assert!(prompt.contains(PAINTNODE_DIRECTOR_OBSERVATION_FILE));
        assert!(prompt.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(prompt.contains("intentional medium texture such as film grain"));
        assert!(prompt.contains("\"action\": \"acceptResult\""));
        assert!(prompt.contains("\"action\": \"generateCandidate\""));
        assert!(prompt.contains("\"action\": \"fail\""));
    }

    #[test]
    fn director_writes_turn_snapshots_and_timeline() {
        let job = TempJobDir::new("paintnode-director-timeline-test").expect("temp dir");
        let action = DirectorAction {
            action: DirectorActionKind::GenerateCandidate,
            base_image: Some("source.png".into()),
            prompt: "keep the film grain".into(),
            constraints: vec!["natural texture".into()],
            avoid: vec!["plastic denoise".into()],
            notes: Some("first attempt".into()),
            candidate: None,
            reason: None,
        };

        write_director_turn_action(job.path(), 1, &action).expect("write action");
        write_director_observation(
            job.path(),
            1,
            "candidateGenerated",
            Some("director-candidate-1.png"),
            "PaintNode generated a candidate image.",
        )
        .expect("write observation");
        write_director_final(
            job.path(),
            "accepted",
            "Antigravity",
            AiDirectorInvolvement::FullReview,
            Some("director-candidate-1.png"),
            "accepted",
        )
        .expect("write final");

        assert!(job.path().join("director-turn-1-action.json").exists());
        assert!(job.path().join("director-turn-1-observation.json").exists());
        let timeline = fs::read_to_string(job.path().join(PAINTNODE_DIRECTOR_TIMELINE_FILE))
            .expect("timeline");
        assert_eq!(timeline.lines().count(), 3);
        assert!(timeline.contains("\"event\":\"directorAction\""));
        assert!(timeline.contains("\"event\":\"paintnodeObservation\""));
        assert!(timeline.contains("\"event\":\"directorFinal\""));
    }
}
