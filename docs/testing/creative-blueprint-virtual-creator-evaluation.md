# Creative Blueprint virtual creator evaluation

## Purpose

This lane runs eight isolated AI-operated interaction probes against the exact
approved Provider Free native PaintNode bundle. It is designed to expose
navigation, copy, state, recovery, keyboard, provenance, and persistence
friction before or alongside real creator research.

Every record is explicitly synthetic and requires live owner observation plus
an accept/reject decision. Owner review increases the trustworthiness of the
recorded run; it does not turn an AI agent into an independent qualifying
creator.

## Validity boundary

Virtual creator results:

- may create product hypotheses, regression cases, and backlog candidates;
- may be compared across predefined behavioral lenses;
- may be accepted or rejected by the product owner after live observation;
- must never be copied into real participant rows or human-study metrics;
- do not satisfy recruitment, participation consent, recording consent,
  accessibility representation, facilitator sign-off, or the #85 requirement
  for 6–8 qualifying creators;
- cannot close #85, Milestone 2, or PR #65 under the current acceptance
  contract.

If the milestone contract is intentionally changed later, preserve these
records as synthetic evidence and document the governance decision separately.
Never relabel old virtual sessions as human sessions.

## Study design

The fixed profile matrix lives in
`creator-study/virtual-creators/profiles.json`. Profiles are behavioral lenses,
not demographic personas and not claims of lived experience. They vary visible
interaction constraints and likely mental models without directing the agent to
find a predetermined problem.

Each profile receives:

1. a newly allocated virtual session ID;
2. a new AI task with no forked conversation or prior-session context;
3. a unique empty project folder outside the repository;
4. a cryptographically fresh isolated PaintNode profile;
5. only its own participant-start prompt and the current task prompt;
6. a neutral probe and standardized hints only when the committed facilitator
   algorithm allows them;
7. final owner observation and acceptance or rejection;
8. verified native profile cleanup before the next profile begins.

Sessions are strictly sequential because the approved lifecycle deliberately
allows only one active study profile at a time.

## Operator and creator separation

The generated `operator-deck.md` contains hidden checkpoint setup, timing,
hints, lifecycle commands, and owner-review steps. Never paste that file into
the virtual creator task.

The generated `participant-start.md` contains only one behavioral lens, the
session-specific empty project, supplied Product paths, and the interaction
rules. The operator then sends exactly one task prompt at a time from the
operator deck.

The creator task must use Computer Use against the native repo-built app. It
must not use Terminal, a browser PaintNode build, source code, tests, GitHub,
logs, prior results, operator files, or any other session.

## Prepare one session

Create two owner-only roots outside the repository. Keep control records away
from the empty PaintNode projects:

```sh
mkdir -p "$HOME/Library/Application Support/PaintNode/virtual-creators/control"
mkdir -p "$HOME/Library/Application Support/PaintNode/virtual-creators/projects"
chmod 700 "$HOME/Library/Application Support/PaintNode/virtual-creators/control"
chmod 700 "$HOME/Library/Application Support/PaintNode/virtual-creators/projects"
```

List the eight profiles:

```sh
npm run qa:virtual-creators:prepare -- --list-profiles
```

Prepare V01, substituting the real build-control pack when needed:

```sh
npm run qa:virtual-creators:prepare -- \
  --profile V01 \
  --control-root "$HOME/Library/Application Support/PaintNode/virtual-creators/control" \
  --project-root "$HOME/Library/Application Support/PaintNode/virtual-creators/projects" \
  --build-control-root "$HOME/Library/Application Support/PaintNode/creator-study-ops/2026-07-12-preauth" \
  --approved-checkout "/absolute/clean/detached/checkout/at/the-approved-git-sha"
```

The command creates one owner-only control directory and one separate, empty,
owner-only project. It fails when roots are inside the repository, nested,
symlinked, or when the preserved study-capable bundle/records are absent.
It also rejects an approved checkout whose HEAD differs from the frozen build
or whose source tree, including untracked files, is dirty. Packet generation
also requires a clean virtual-creator kit checkout and pins its Git SHA so the
final validator cannot silently drift. The generated deck
captures hashed `fresh`, `resume`, and `finalize` attestation rows and native
setup/cleanup receipts. The validator reopens those private receipt files and
binds their build, profile, cleanup, phase, and time fields to the observation.
Keep that detached checkout unchanged for all
eight sessions even if `feature/creative-blueprint` advances.

## Run one session

1. Open the generated `operator-deck.md` in the coordinating task only.
2. Launch and verify the exact preserved bundle using the generated commands.
3. Confirm through Computer Use that no document, project, workflow, or imported
   asset is visible. Do not open the project before setup verification.
4. Start a brand-new AI task with no inherited conversation.
5. Paste only `participant-start.md` into that task.
6. Send Task 1, observe the live native run, and record visible evidence.
7. Continue one task at a time. Perform Task 2 and Task 7 checkpoint changes
   from the operator lane, and Task 8 resume from the same native profile.
8. Apply the committed facilitator algorithm exactly: neutral probe at 90
   seconds without progress, H1 at 180 seconds, then recompute the earliest
   incomplete checkpoint and restart timing whenever progress occurs. Deliver
   H2 and takeover only after the additional same-checkpoint intervals.
9. Complete `observation.blank.json` with the distinct external AI task ID,
   three checkout attestations, receipt hashes/fields, exact interventions,
   scenario events, synthetic task outcomes, visible evidence, and findings.
10. Close PaintNode and require successful `qa:creator-study:finalize-session`
    cleanup before starting the next profile.
11. Complete `ownerReview`: observed live, evidence reviewed, accepted/rejected,
    written standard, notes, and UTC review timestamp.
12. Run the fail-closed record validator:

    ```sh
    npm run qa:virtual-creators:validate -- \
      --validate-observation "/absolute/path/to/observation.blank.json"
    ```

An accepted virtual run requires all eight tasks completed, elapsed time and
traceable native UI evidence for every task, the planned Task 2 and Task 7
setup/reset events, only permitted deviations, matching setup/cleanup profile
hashes from validated native receipts, verified data-store removal and
finalization, and the owner’s written explicit decision. A failed or incomplete
run must be rejected.

A packet rejected before launch uses `attemptStage: prelaunch` and must not
invent an external task, attestation, setup, or cleanup evidence. A launched
attempt is retained after verified finalization even when rejected. Prepare a
new packet to retry that profile; keep the rejected attempt with
`selectedForAggregate: false`, and mark exactly one terminal attempt for each
V01–V08 profile `selectedForAggregate: true`. The set validator permits retained
rejected attempts while rejecting missing, duplicate-selected, or reused-task-ID
records.

## Synthesis

Use `virtual-aggregate-template.md`. Keep three layers separate:

1. **Observed UI evidence** — labels, states, dimensions, actions, errors, and
   persisted results actually visible in the native app.
2. **Agent interpretation** — what the assigned behavioral lens inferred.
3. **Human-validation hypothesis** — what should be checked with real creators.

Do not use human-study severity S0–S4, SEQ, participant percentages, cohort
exceptions, or milestone recommendations. Virtual findings use hypothesis
impact and always set `requiresHumanValidation: true`.

## Eight-session completion checklist

- [ ] V01 First-time workflow explorer
- [ ] V02 Keyboard-only workflow explorer
- [ ] V03 Accessibility-tree navigation probe
- [ ] V04 High-volume commerce creator lens
- [ ] V05 Traditional layer-editor lens
- [ ] V06 Prompt-first AI creator lens
- [ ] V07 Multi-format social creator lens
- [ ] V08 Deliberate verification lens
- [ ] Every launched attempt used a distinct AI task, project, and session ID
- [ ] Every session passed its fail-closed observation validator
- [ ] Every profile was finalized before the next allocation
- [ ] Every record has an owner accept/reject decision
- [ ] Exactly one terminal attempt per V01–V08 is selected for the aggregate
- [ ] Aggregate report keeps synthetic findings outside real study evidence

After all eight owner decisions, validate the complete set and task-ID
uniqueness:

```sh
npm run qa:virtual-creators:validate -- \
  --validate-control-root "/absolute/path/to/control"
```
