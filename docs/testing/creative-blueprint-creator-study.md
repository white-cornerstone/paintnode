# Creative Blueprint moderated creator study protocol

Updated: 2026-07-11

This protocol defines the issue #85 moderated walkthrough with 6–8 target
creators. It evaluates whether a new creator can complete Campaign Composer
without understanding technical graph wiring. The study uses the repo-built
provider-free QA app so it measures workflow comprehension and recovery rather
than provider latency or image quality.

This document is an execution package, not study evidence. The study is not
complete until 6–8 valid sessions have actually occurred and the de-identified
synthesis has been reviewed. Empty templates, rehearsals, automated tests, AI
summaries, and facilitator predictions never count as participant results.
Real sessions remain required; this operational package cannot satisfy the gate.

Use the copyable templates, Product materials, privacy boundary, setup verifier,
and deterministic synthesis calculator in
[`creator-study/README.md`](creator-study/README.md). Never complete private
templates inside the repository: copy them to the approved restricted research
location first.

## Research questions

1. Can creators start from an empty project, understand the guided inputs, and
   reach a coherent three-format campaign without being taught graph concepts?
2. Can they compare and promote a direction, round-trip it through the editor,
   and understand which result continues downstream?
3. Do selective rerun, blocked, progress, failure, and retry states explain what
   happened and what to do next?
4. Does save, restart, and reopen preserve enough context for the creator to
   continue confidently?
5. Which usability or accessibility findings block the MVP milestone?

This study does not evaluate generated-image quality, provider preference,
pricing, collaboration, recipes, or marketplace behavior.

## Participants and screener

Recruit 6–8 valid participants. Do not stop at six merely because serious
findings have appeared; complete the planned cohort unless safety, consent, or
an unusable build requires the study to pause.

### Target mix

- All participants create or adapt visual assets at least monthly and use a
  desktop image, design, or content-production tool.
- At least four regularly produce one concept in multiple aspect ratios.
- Include both AI-generation experience levels: at least two weekly users and
  at least two occasional or non-users.
- Include at least one keyboard-heavy creator or creator who uses an
  accessibility accommodation, when recruitment permits. Record recruitment
  limits; never infer accessibility coverage that did not occur.
- Exclude PaintNode contributors, anyone who implemented or previously tested
  Creative Blueprint, and anyone who has already seen the facilitator script.

### Screener questions

Ask before scheduling:

1. What kinds of visual assets do you create, and how often?
2. Which desktop image or design tools have you used in the last three months?
3. How often do you adapt one campaign or concept to several output formats?
4. How often do you use AI image generation or editing: never, occasionally,
   monthly, weekly, or daily?
5. Do you normally work mainly with pointer, keyboard, pen, or assistive
   technology? Is there an accommodation needed for this session?
6. Have you used PaintNode's Creative Blueprint or participated in its design,
   implementation, or prior research?
7. Are you comfortable using a supplied non-confidential Product image rather
   than client work?

Record only the eligibility category needed for sampling. Do not store employer,
client, medical, credential, or unrelated demographic information.

## Consent and privacy note

### Study authorization gate

Before recruitment begins, the study owner must complete the private study log
with all of the following:

- study owner name;
- the names of every observer who may access raw research evidence;
- the approved private storage location for recordings and identifiable notes;
- the milestone decision owner and the planned decision date.

Recruitment and sessions are blocked if the approved private storage location
is blank, inaccessible to the study owner, or accessible beyond the study owner
and named observers. The location itself is private study metadata and must not
be committed to this repository. Record only its approved internal reference in
the session log.

Read this before recording or screen sharing:

> We are evaluating PaintNode, not you. You may pause, skip a question, or stop
> at any time without giving a reason. Please do not open confidential client
> work, personal credentials, or private files. We will use a supplied Product
> image. With your separate permission, we may record the screen and audio to
> support note-taking. Only the study owner and the named study observers may
> access the recording or identifiable notes. We de-identify research notes
> under a participant code and report findings without your name or other
> direct identifiers. By default, we delete recordings and identifiable notes
> 30 calendar days after the milestone decision. If an approved exception would
> keep them longer, we will disclose its reason and deletion date to you now,
> before you choose; today, that exception is: [none / state the approved reason
> and deletion date]. Do you consent to participate? Do you separately consent
> to recording?

Recording is off by default. Record `yes` or `no` for participation and
recording separately, and start recording only after the separate recording
answer is explicitly `yes`. A participant who declines recording may still take
part with written notes. Stop recording and the session immediately if
participation consent is withdrawn.

Use participant IDs `P01`–`P08`. Raw recordings and identifiable notes stay in
the approved restricted research location, never in the Git repository. Access
is limited to the study owner and the named observers recorded before
recruitment. De-identify working notes under the participant code as soon as
they are created and remove names, employers, client details, file paths, and
other direct identifiers from synthesis evidence.

Delete recordings and identifiable notes by default 30 calendar days after the
milestone decision. The study owner records the decision date, calculated
deletion due date, and actual deletion date in the private study log. Delete
earlier when consent is withdrawn or policy requires it; a longer retention
period requires a documented approved exception. Repository evidence must
always be de-identified.

## Build, materials, and setup

For every session record:

- completed study authorization gate, including the approved private storage
  reference, study owner, and named observers;
- exact Git SHA and QA app bundle identity;
- operating system, display scale, input method, and app window size;
- whether recording was permitted;
- a genuinely empty participant-specific project folder;
- the same supplied, non-confidential Product PNG;
- a fresh provider-free QA app state with no saved workflow from another
  participant.

Use `npm run qa:native:provider-free` and the bundle identity documented in
[Native PaintNode QA](native-qa.md). Provider-free mode must not invoke Codex,
Antigravity, provider discovery, authentication, or network generation. If a
provider is invoked or a security prompt appears, stop and mark the session
invalid plus a severity-0 safety finding.

Before the participant arrives, verify the build and failure controls in a
separate rehearsal folder. Delete the rehearsal project. Do not pre-import the
Product, pre-create Campaign Composer, or leave a workflow open in the session
folder. Run `npm run qa:creator-study:setup` with the approved SHA, built app
bundle, empty participant project, and deleted rehearsal path as documented in
the operations runbook. The verifier does not replace the visible rehearsal.

Use committed **Product A** for Task 1. Keep **Product B** hidden until Task 6.
Their task assignments, dimensions, provenance, and hashes are pinned in
`creator-study/materials/manifest.json`.

## Session timing

Plan 60 minutes:

| Segment | Time |
| --- | ---: |
| Welcome, consent, and think-aloud practice | 5 minutes |
| Background questions | 5 minutes |
| Empty-project flagship tasks | 38 minutes |
| Post-task ratings and debrief | 10 minutes |
| Facilitator wrap-up | 2 minutes |

Record task time, but do not rush participants. If the session reaches 60
minutes, ask permission for up to 10 additional minutes or stop and mark every
unattempted task accurately.

## Facilitator rules

- Ask the participant to think aloud: what they expect, notice, and choose.
- Read each task prompt verbatim. Do not name controls, point, take the mouse,
  or explain nodes before the participant attempts the task.
- After 90 seconds without progress, ask: “What are you looking for?” This is a
  neutral probe, not assistance.
- If still blocked after another 90 seconds, offer the minimum next-step hint
  and record an assist. Further hints are allowed only to expose later tasks.
- Do not defend the design or interpret an error for the participant.
- Ask follow-up questions only after the task or at a natural stopping point.
- Trigger the candidate and format failures through the QA scenario controls at
  the specified time. Do not tell the participant which control will fail.
- Say “I am setting the test checkpoint for this task” before every scenario
  change. Record the selected checkpoint, timestamp, task, expected trigger,
  observed trigger, and reset in the intervention log. Never change a scenario,
  graph, output, or participant input silently.
- Reset to `Standard checkpoint` immediately after the planned first failure is
  visible and before the participant retries. Do not use another intervention
  to force the retry to succeed.
- Never convert facilitator help into an unaided success.

### Facilitator intervention log

Maintain this log in the approved private study location. Every setup and reset
must be visible and narrated as a test-checkpoint change without revealing the
target branch or format.

| Time | Task | Action | Visible label | Expected trigger | Observed trigger | Reset time | Deviation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | setup / reset | | | | | |

## Empty-project flagship tasks and neutral prompts

Use the exact sequence below. Start timing after reading each prompt.

### Task 1 — Start and supply the Product

Setup: the Project panel has no open project.

Prompt:

> Start a new PaintNode project in this empty folder. Bring this supplied
> Product image into the project, then start a Campaign Composer workflow for a
> multi-format launch. Use only the Product; you do not have Subject or Style
> references for this job.

Observe whether required/optional language, project state, import, workflow
choice, and Product assignment are understood without graph terminology.

### Task 2 — Create alternatives and recover one

Facilitator setup, in this exact order:

1. Confirm the QA scenario reads `Standard checkpoint`.
2. Say “I am setting the test checkpoint for this task.”
3. Select `Branch recovery checkpoint` and record the setup in the intervention
   log. Do not change branch count, graph state, or participant inputs.
4. Read the prompt and start timing.
5. When the planned first branch failure is visible, record the observed trigger,
   say “I am resetting the test checkpoint,” select `Standard checkpoint`, and
   record the reset before the participant retries.

Prompt:

> Create three different campaign directions. If one does not complete, keep
> the useful alternatives and recover the incomplete one.

Observe whether the creator understands branch count, sibling preservation,
failure state, and candidate-local retry.

### Task 3 — Compare and choose a direction

Prompt:

> Compare the available directions, inspect enough context to make a choice,
> and continue with the direction you prefer.

Do not say “Review,” “candidate,” or “Promote.” Record pointer versus keyboard
behavior, comparison strategy, and whether the accepted state is understood.

### Task 4 — Refine in the editor

Prompt:

> Make a small visible edit to the direction you chose, then return that edit
> to the campaign so future formats use the edited version.

Use the same simple edit request for every participant, such as changing one
layer name and opacity. Observe Open in Editor, Return to Workflow, original
versus edited identity, and confidence about what continues downstream.

### Task 5 — Produce the output family

Prompt:

> Finish the campaign as square, portrait, and landscape outputs based on your
> accepted edited direction. Check that you received all three formats.

Observe selective preflight, output identity, progress, and whether the creator
can distinguish accepted Square from generated adaptations.

### Task 6 — Understand reuse and an upstream change

Setup: provide a second supplied Product PNG.

Prompt:

> First run the campaign again without changing anything. Then replace the
> Product with this updated version and bring the campaign up to date while
> keeping work that does not need to change.

Observe whether unchanged work is recognized as reused, changed descendants are
understood as stale, and the creator avoids rebuilding unrelated inputs.

### Task 7 — Recover one format

Facilitator setup, in this exact order:

1. Confirm the QA scenario reads `Standard checkpoint` and Square and Portrait
   remain complete.
2. Say “I am setting the test checkpoint for this task.”
3. Select `Format recovery checkpoint` and record the setup in the intervention
   log before the participant starts the action. Do not change graph state,
   output state, or participant inputs.
4. Read the prompt and start timing. While this checkpoint remains selected,
   Landscape fails regardless of its historical attempt number.
5. When the planned Landscape checkpoint failure is visible, record the
   observed trigger, say “I am resetting the test checkpoint,” visibly select
   `Standard checkpoint`, and record the reset before the participant chooses
   Retry. Retry succeeds because the visible scenario changed to Standard, not
   because of hidden attempt state or a silent facilitator change.

Prompt:

> Complete the campaign after this output problem. Preserve any formats that
> already completed successfully.

Observe error comprehension, retry scope, sibling preservation, and recovery
confidence.

### Task 8 — Resume after restart and use a result

Prompt:

> Save your work, quit PaintNode, reopen the same project and campaign, and
> confirm you can understand where you left off. Then place the edited campaign
> result into an image document.

Observe save path, restart/reopen, promotion and edit continuity, output and
retry history, and whether Place creates a real layer.

## Ratings and interview prompts

After each task, ask a Single Ease Question: “Overall, how difficult or easy was
this task?” Record 1 `very difficult` through 7 `very easy`.

After Task 8 ask, without suggesting an answer:

- What did you think Campaign Composer was doing for you?
- At what point, if any, did the board feel technical rather than creative?
- How did you know which direction and edit would continue downstream?
- What did you expect “run again” and the changed Product to affect?
- Which progress, blocked, or failure message was least clear?
- What would stop you from using this for a real campaign?
- What is the one change you would make before release?

## Metrics and calculation rules

For each task record:

- outcome: `unaided success`, `assisted success`, `failure`, or `not attempted`;
- elapsed seconds;
- neutral probes and direct assists separately;
- wrong turns, repeated actions, error loops, and recovery attempts;
- SEQ rating from 1–7;
- input method and any accessibility barrier;
- confidence evidence in the participant's own words.

Report denominators. `Not attempted` is not a success and must not be silently
excluded. A session is invalid only for withdrawn consent, unusable/wrong build,
provider invocation in provider-free mode, prior exposure that violates the
screener, or facilitator deviation severe enough to coach the result. Report
invalid sessions and replacements.

Primary study metrics:

- full-journey unaided completion rate;
- full-journey assisted-or-unaided completion rate;
- unaided completion per task;
- median task time and range;
- median SEQ and range per task;
- assists and repeated errors per participant;
- number of participants affected by each finding;
- successful persistence/reopen and no-data-loss rate.

These thresholds guide the exit decision; they do not turn qualitative findings
into automatic approval:

- at least 75% complete the full journey with no direct assist;
- at least 85% complete each critical decision task (choose direction, return
  edit, produce outputs, recover, reopen) with at most one direct assist;
- median SEQ is at least 5 for every critical decision task;
- 100% preserve accepted work and reopen without data loss or wrong lineage.

With 6–8 participants, always show counts beside percentages.

## Severity rubric

| Severity | Definition | Examples |
| --- | --- | --- |
| S0 — blocker | Safety, privacy, data loss, wrong lineage/output, provider invocation in provider-free mode, or a critical task impossible with no viable recovery | Saved edit disappears; wrong candidate feeds formats; workflow cannot reopen |
| S1 — critical | Critical task fails or requires facilitator takeover; likely prevents real use | Cannot promote, return edit, recover output, or identify the saved workflow |
| S2 — major | Task completes only with a direct hint, repeated error, or substantial avoidable delay | Required/optional inputs misunderstood; rerun scope repeatedly misread |
| S3 — minor | Local friction with a discoverable workaround and no material outcome risk | Label hesitation, one reversible wrong turn, low-confidence wording |
| S4 — observation | Preference or opportunity without demonstrated task impact | Desired shortcut or alternative layout |

Assign severity from observed impact, not facilitator intuition. Record frequency
separately; do not lower severity because only one participant encountered a
data-loss or lineage problem.

## Milestone blocker rules

The issue #85/MVP exit is blocked when any of these is true:

- recruitment or a session began with a blank approved private storage
  location, or raw evidence access exceeded the study owner and named observers;
- one confirmed S0 finding;
- one unresolved S1 involving data integrity, accepted-direction identity,
  editor return, save/reopen, or keyboard/assistive access;
- the same S1 affects two or more participants;
- full-journey or critical-task thresholds above are missed;
- any participant cannot complete a critical task using their required input or
  accessibility method;
- the cohort has fewer than six valid sessions or misses the required AI
  experience mix without a documented recruitment decision;
- evidence is incomplete, contradictory, fabricated, or cannot be traced to
  actual de-identified session notes.

A single non-integrity S1 requires an explicit Product, Design, Engineering, and
Accessibility decision plus rationale before it can be declared non-blocking.
S2 findings may block when frequency or combined burden causes a threshold miss.
S3/S4 findings normally enter the backlog. Re-test every fixed S0/S1 with affected
tasks before declaring the gate met.

### Recommendation mapping

- `insufficient evidence`: fewer than six valid sessions, incomplete or
  untraceable evidence, missing required cohort coverage without a documented
  recruitment decision, missing values needed for a threshold, missing required
  role sign-offs, or missing configured-provider evidence;
- `block`: evidence is sufficient to decide, but any threshold or blocker rule
  fails;
- `conditional`: no exit blocker remains, but named non-blocking actions or
  re-tests remain. A conditional result never closes issue #85;
- `pass`: 6–8 valid real sessions, complete traceability, cohort coverage or an
  approved recruitment decision, every threshold, no unresolved blocker,
  configured-provider evidence, and all required role sign-offs are complete.

Generate calculations from a de-identified schema-valid input with
`npm run qa:creator-study:synthesize -- --input PATH`. Review the output against
private source records; the calculator cannot make qualitative or privacy
decisions for the study team.

## Per-session observation template

Copy this section for each real session in the approved research location. Do
not commit identifiable raw notes.

```markdown
# Creative Blueprint session P__

- Date/time and facilitator:
- Build Git SHA and QA bundle identity:
- OS/display/window/input method:
- Eligibility summary and cohort bucket:
- Participation consent: yes / withdrawn
- Recording consent: yes / no
- Recording status at session start: off / on after opt-in
- Approved private storage reference (required; never the path itself):
- Study owner and named observers with evidence access:
- Milestone decision date / deletion due date / actual deletion date, or not recorded:
- Session validity: valid / invalid — reason

## Background

- Current creative work and tools:
- Multi-format frequency:
- AI image experience bucket:
- Accessibility accommodation used:

## Task observations

| Task | Outcome | Seconds | Neutral probes | Direct assists | SEQ 1–7 | Errors/behavior | Evidence or de-identified quote |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1. Start and Product | | | | | | | |
| 2. Alternatives/retry | | | | | | | |
| 3. Compare/choose | | | | | | | |
| 4. Editor return | | | | | | | |
| 5. Three outputs | | | | | | | |
| 6. Reuse/Product change | | | | | | | |
| 7. Format recovery | | | | | | | |
| 8. Save/reopen/Place | | | | | | | |

## Findings

| Finding ID | Observation | Task | Severity | Outcome impact | Artifact/time reference |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## Facilitator interventions

| Time | Task | Action | Visible label | Expected trigger | Observed trigger | Reset time | Deviation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | setup / reset | | | | | |

## Debrief

- Participant's mental model:
- Least clear state/message:
- Release concern:
- Requested change:
- Facilitator deviations or technical incidents:
```

## Private working synthesis template

Complete this only from the real session records and only in approved private
storage. The repository-safe decision record is
`creator-study/templates/de-identified-study-decision.md`; it deliberately
excludes the private fields below.

```markdown
# Creative Blueprint creator study synthesis

- Study dates:
- Build SHA(s) and reason for any change:
- Facilitators/observers:
- Recruited / valid / invalid / replacement counts:
- Cohort mix, including AI experience and accessibility coverage:
- Evidence location and recording deletion date:
- Study owner / named observers / approved private storage reference:
- Milestone decision date / default deletion due date / actual deletion date:

## Executive result

- Milestone recommendation: pass / conditional / block / insufficient evidence
- Valid sessions: __ of planned 6–8
- Full-journey unaided: __/__ (__%)
- Full-journey assisted or unaided: __/__ (__%)
- Data-loss or wrong-lineage events: __
- S0 / S1 / S2 / S3 / S4 counts:
- Thresholds met/missed:

## Task metrics

| Task | Unaided | Assisted | Failed/not attempted | Median seconds (range) | Median SEQ (range) | Participants with finding |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |
| 6 | | | | | | |
| 7 | | | | | | |
| 8 | | | | | | |

## Prioritized findings

| ID | Finding and evidence | Frequency | Severity | Requirement affected | Owner | Decision/fix | Re-test evidence |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| | | | | | | | |

## Decision audit

- Blocker rules triggered:
- S1 exceptions and cross-functional rationale:
- Accessibility decision:
- Required fixes before exit:
- Deferred findings and why they do not block:
- Follow-up/re-test plan:
- Product / Design / Engineering / Accessibility sign-off:
```

## Evidence integrity: no fabrication

- Never create synthetic participants, observations, quotes, timings, ratings,
  recordings, counts, or completion claims.
- Never copy rehearsal or automated QA results into participant rows.
- AI tools may format or summarize supplied de-identified notes, but every claim
  must trace to an actual session record. AI must not fill blanks or infer a
  missing result.
- Preserve dissent, failures, invalid sessions, missing data, and denominators.
- If a session or metric did not occur, write `not run`, `not observed`, or
  `insufficient evidence`.
- Do not mark issue #85, the MVP milestone, or PR #65 complete from this protocol
  alone. Completion requires real sessions, reviewed synthesis, blocker
  decisions, and the separate configured-provider evidence in the roadmap.
