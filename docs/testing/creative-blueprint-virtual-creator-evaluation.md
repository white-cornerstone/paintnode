# Creative Blueprint normal-app virtual creator evaluation

## Purpose

This lane runs eight isolated, owner-observed AI creator tasks through the same
normal repository-built PaintNode behavior used by a public user. Generation,
editing, retry, persistence, and recovery use real configured providers and real
subscription-backed results. The lane does not use Provider Free fixtures,
deterministic outputs, injected failures, or hidden QA scenario controls.

The repository app is built and launched with `npm run qa:native:normal`. Its separate
`PaintNode Repo QA — repo-dev` identity prevents Computer Use from accidentally
targeting an installed production build. The command creates a registered
macOS `.app` bundle that Computer Use can control, while leaving provider QA
mode unset so generation behavior remains normal.

## Validity boundary

Each virtual creator uses a predefined behavioral lens, a brand-new AI task,
and a unique empty project. The product owner observes the live run and accepts
or rejects its evidence. These records can create product hypotheses,
regression cases, and backlog candidates.

They remain synthetic records. Owner review makes the run auditable but does
not retrospectively make an AI task a human participant or independently close
the current #85 qualifying-creator gate. Keep any later governance decision
separate and never relabel old records.

## What is isolated

- AI conversation: new task, no fork, no prior creator transcript.
- Project data: unique empty project folder for every attempt.
- Runtime identity: repo-built QA title and bundle ID, distinct from the
  installed production app.
- Source version: clean checkout path and Git SHA pinned in `session-plan.json`.
- Evidence: private control directory and explicit owner disposition.

Provider credentials and normal app settings are intentionally not replaced by
test fixtures. They behave as they do for a public user. Project folders are
preserved after the run for owner evidence review.

## Prepare a session

Create separate private roots outside the repository:

```sh
mkdir -p "$HOME/Library/Application Support/PaintNode/virtual-creators-normal/control"
mkdir -p "$HOME/Library/Application Support/PaintNode/virtual-creators-normal/projects"
chmod 700 "$HOME/Library/Application Support/PaintNode/virtual-creators-normal/control"
chmod 700 "$HOME/Library/Application Support/PaintNode/virtual-creators-normal/projects"
```

From the exact clean feature worktree that will run the app:

```sh
npm run qa:virtual-creators:prepare -- \
  --profile V01 \
  --control-root "$HOME/Library/Application Support/PaintNode/virtual-creators-normal/control" \
  --project-root "$HOME/Library/Application Support/PaintNode/virtual-creators-normal/projects" \
  --app-checkout "$PWD"
```

The command creates:

- `session-plan.json`: immutable runtime, source, project, and profile binding;
- `participant-start.md`: the only session-start file sent to the new AI task;
- `operator-deck.md`: launch, moderation, task, relaunch, and review instructions;
- `observation.blank.json`: schema-v2 evidence record.

Preparation fails if the source checkout is dirty, either private root is
inside the repository, the roots contain each other, or the profile is unknown.

## Run one creator

1. Open only `operator-deck.md` in the coordinating task.
2. Verify the unique project is empty, then run `npm run qa:native:normal` from the
   pinned clean checkout.
3. Confirm `PaintNode Repo QA — repo-dev` is visibly running with no project or
   document open.
4. Create a brand-new, non-forked AI task and paste only
   `participant-start.md`.
5. After its waiting reply, send `APP READY`, then send one task prompt at a
   time from the operator deck.
6. Observe normal real-provider behavior. Do not change a hidden QA mode,
   inject a failure, substitute an output, or silently operate the app for the
   creator. If a real failure occurs, let the creator use only visible recovery
   controls and record the result.
7. For Task 8, the creator saves and quits. The operator restarts the same
   pinned repo app, verifies it is running, then sends `APP RESUMED`. The
   creator reopens its own saved project.
8. Close the repo-dev app after the task, preserve the project, fill the
   observation, and record the owner's accept/reject decision.
9. Validate before moving to the next profile.

```sh
npm run qa:virtual-creators:validate -- \
  --validate-observation "/absolute/path/to/observation.blank.json"
```

Run strictly one profile at a time. A rejected attempt is retained; a retry
gets a new session, project, and AI task.

## Acceptance contract

An accepted session requires:

- all eight tasks completed through visible normal-app controls;
- a distinct external AI task ID and confirmed new-task/no-fork isolation;
- fresh and Task 8 resume launch evidence for the pinned repo app;
- native UI evidence for every task;
- real-provider evidence for Tasks 2, 5, 6, and 7;
- real errors and recovery attempts recorded without injection;
- successful save/reopen and final app closure;
- live owner observation, evidence review, rationale, and timestamp.

After all eight profiles have a selected owner-accepted attempt, validate the set:

```sh
npm run qa:virtual-creators:validate -- \
  --validate-control-root "/absolute/path/to/control"
```

The set validator requires exactly one selected, accepted V01–V08 attempt and
unique AI task IDs and project directories. Rejected attempts remain retained
but unselected.

## Synthesis

Keep three layers separate:

1. observed visible UI and provider evidence;
2. the AI creator's interpretation through its assigned lens;
3. a hypothesis that still requires validation with human creators.

Do not turn variable provider output quality into a deterministic cross-profile
score. Compare workflow comprehension, control discovery, state, recovery,
persistence, and evidence quality instead.
