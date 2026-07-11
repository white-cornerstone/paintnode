# Native PaintNode QA

Workflow-board checkpoints must use the repo-built Tauri desktop application.
The browser build is useful for layout checks only and the installed production
PaintNode must not be used as a substitute.

## Provider-free smoke test

```sh
npm run qa:native:provider-free
```

This builds and launches an isolated macOS app bundle named **PaintNode
Blueprint QA — Provider Free**, with bundle ID
`com.paintnode.editor.blueprintqa.provider.free`. Codex and Antigravity
detection, capability discovery, execution, and managed-runtime auth probes are
disabled. Use this exact bundle identity for routine workflow-board interaction
and Computer Use validation.

The build also writes a `.paintnode-qa-build.json` provenance sidecar beside the
app. It binds the bundle to the source Git SHA/tree, clean-or-dirty build state,
bundle ID, and actual executable SHA-256 without modifying the signed app.
Creator-study readiness requires a clean checkout and keeps the sidecar beside
the app; `qa:creator-study:setup` rejects missing/stale provenance, dirty source,
or executable fingerprint drift.

### Creator-study session isolation

Generic Provider Free QA keeps its existing profile for ordinary smoke testing.
For every new moderated participant on macOS 14 or newer, start a new isolated
macOS WebKit data store instead:

```sh
npm run qa:native:provider-free -- --fresh-study-session
```

The generated raw 16-byte profile identifier remains in an ignored local state
file. Build provenance and the setup receipt contain only its SHA-256
fingerprint. A fresh profile cannot restore the generic QA project, rehearsal,
workflow, local task/attempt data, scenario component state, or any earlier
participant profile. Before opening a project, visibly confirm both Project and
Workflow are empty and record that check through the creator-study setup
command.

Quit/reopen inside the same participant session uses the same profile so Task 8
can verify real persistence:

```sh
npm run qa:native:provider-free -- --resume-study-session
```

Never use `--resume-study-session` for the next participant. Start another
`--fresh-study-session`; the setup verifier rejects a resumed or generic build.
Neither flag is accepted by Provider E2E, and normal PaintNode is unchanged.

Inside this bundle only, Campaign Composer exposes a clearly labelled **QA
Fake** Generate path after native QA mode detection completes. It creates
deterministic 1024 x 1024, 1024 x 1280, and 1280 x 720 PNGs in memory and stores them through the normal project
asset store. It never invokes Codex, Antigravity, provider authentication,
pickers, network requests, or visual-input file reads. The command that creates
the PNG rejects normal and provider-E2E modes.

Manual Creative Blueprint checkpoint:

1. Create a genuinely empty local folder outside PaintNode. It must contain no
   PaintNode manifest, assets, workflows, or copied QA fixture.
2. Launch the provider-free QA app. In the Project panel choose **Open Project
   Folder**, select that empty folder, and confirm **Assets / Imported** is empty.
3. In **Assets / Imported**, choose **Import images** (or the **Import external
   images** icon), select a Product PNG through the app picker, and wait for the
   imported Product card to appear. Do not seed the project from the filesystem.
4. Choose **File > New**, open the **Workflow** tab, select **Campaign Composer**,
   confirm Product is required while Subject and Style are optional, then choose
   **Create**.
5. Assign the Product from **Assets / Imported** to the guided Product slot;
   leave optional Subject and Style empty.
6. Generate concept branches, use arrow/Home/End keys to compare them, simulate
   and retry one candidate failure, then promote one direction.
7. Return an editor revision of the promoted direction, run downstream, and
   confirm Square, Portrait 4:5, and Landscape 16:9 use that accepted direction.
8. Run unchanged downstream again and confirm selective preflight schedules no
   provider work. Change Product and confirm only affected descendants stale.
9. Simulate one format failure, retry it, and confirm completed siblings remain.
10. Save the workflow, quit the QA app, reopen the project and workflow, and
   confirm promotion, editor revision, outputs, and retry history remain.
11. Open or create an image document and use Place; success is valid only when a
   real layer is inserted.

The provider-free automation for this journey is
`src/lib/workflow/campaignComposerFlagshipAcceptance.test.ts`; focused tests
cover additional boundary cases. This scenario is draft exit evidence only. Issue #85 remains
open for exit purposes until a configured-provider native invocation and a
moderated 6–8 creator walkthrough are recorded separately.

Execute the walkthrough with the screener, consent language, neutral prompts,
metrics, severity rubric, templates, and evidence-integrity rules in the
[Creative Blueprint moderated creator study protocol](creative-blueprint-creator-study.md).
The protocol does not count as a completed study and no result may be inferred
from provider-free QA alone.

Editor round-trip checkpoint:

1. Open an accepted Transform result, or the currently promoted verified Review
   result, with **Open in Editor**. Unpromoted candidates must not expose the
   action.
2. Edit the document and choose **Return to Workflow**. Confirm the workflow
   preview and downstream Output use the edited PNG while the original run and
   candidate remain unchanged.
3. Reopen the same result and confirm PaintNode restores the latest layered ORA,
   not a flattened PNG. Return a second edit and confirm it supersedes the first
   binding without deleting either revision.
4. Make another edit, close the tab, and verify the prompt offers **Return to
   Workflow**, **Discard**, and **Cancel**. Discard must leave the last returned
   workflow result unchanged.
5. For a promoted candidate, promote a different candidate while the first is
   open. Returning the old tab must fail safely and must not link its newly
   stored artifacts into the workflow.

A missing ORA recovers from its exact-hash PNG as a flattened one-layer repair;
a missing PNG recovers from its exact-hash ORA so Return can recreate the
flattened output. If both are missing, or either present file has the wrong
hash, opening blocks rather than substituting a different project asset.

Workflow close, replacement with a new or opened workflow, and project
switch/close remain blocked while any editor tab is linked to that workflow.
Return, discard, or close those tabs first so their private return authority
cannot outlive the workflow or project it belongs to.
When quitting, a successful Return must also persist the newly dirty workflow;
if that workflow save fails or is cancelled, quit must stop.

Normal PaintNode and **Provider E2E** never expose this fake executor.

## Explicit provider E2E

Pass canonical, trusted executables rather than relying on the GUI process
`PATH`:

```sh
npm run qa:native:provider-e2e -- \
  --codex-path /opt/homebrew/bin/codex \
  --antigravity-path "$HOME/.local/bin/agy"
```

Run the same fail-closed checks without building or launching PaintNode:

```sh
npm run qa:provider:doctor -- \
  --codex-path /opt/homebrew/bin/codex \
  --antigravity-path "$HOME/.local/bin/agy"
```

The doctor resolves npm-installed Codex launchers to their native executable,
so the repo QA app never depends on a stale Node shim or a different `codex`
earlier on `PATH`. On macOS it verifies the provider's code signature and
expected vendor Team ID, rejects revoked or malware-blocked identities before
execution, and applies bounded timeouts with whole-process-tree cleanup to
`--version`, `codex login status`, and `agy models`. It requires an affirmative
Codex login status and at least one available Antigravity model. These checks
do not submit a prompt or image request.

Normal native discovery also bounds each Rust-side Codex, Antigravity, or
Claude `--version` probe to 15 seconds. PaintNode isolates the probe in the same
owned Unix process group or Windows kill-on-close Job Object used for provider
runs, terminates and reaps that tree on timeout, and returns one cached
fail-closed reason to every caller waiting on the same executable. Timeout is a
transient rejection, so a later resolver call may retry the unchanged path;
other rejected checks remain cached until the executable's filesystem
fingerprint changes. A timed-out process never remains registered as in flight.

The full lane then hands the exact preflighted paths and version metadata to
PaintNode's Rust resolver without re-executing the providers, and launches the
uniquely identified **PaintNode Blueprint QA — Provider E2E** bundle. A missing
executable, bad signature,
revoked certificate, timed-out command, missing Codex login, or unavailable
Antigravity model list fails with the provider and path identified before the
app launches. The full lane still does not submit an image-generation request;
the two billable Generate actions require explicit action-time approval.

Do not bypass Gatekeeper, alter quarantine attributes, or remove a rejected
provider install as part of QA. Fix or replace that install outside PaintNode.
