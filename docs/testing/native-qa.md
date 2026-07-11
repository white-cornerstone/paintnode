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

Inside this bundle only, Campaign Composer exposes a clearly labelled **QA
Fake** Generate path after native QA mode detection completes. It creates
deterministic 1024 x 1024, 1024 x 1280, and 1280 x 720 PNGs in memory and stores them through the normal project
asset store. It never invokes Codex, Antigravity, provider authentication,
pickers, network requests, or visual-input file reads. The command that creates
the PNG rejects normal and provider-E2E modes.

Manual Creative Blueprint checkpoint:

1. Open a project folder that already contains a Product asset.
2. Create Campaign Composer and assign Product; leave optional Subject and
   Style empty.
3. Generate concept branches, use arrow/Home/End keys to compare them, simulate
   and retry one candidate failure, then promote one direction.
4. Return an editor revision of the promoted direction, run downstream, and
   confirm Square, Portrait 4:5, and Landscape 16:9 use that accepted direction.
5. Run unchanged downstream again and confirm selective preflight schedules no
   provider work. Change Product and confirm only affected descendants stale.
6. Simulate one format failure, retry it, and confirm completed siblings remain.
7. Save the workflow, quit the QA app, reopen the project and workflow, and
   confirm promotion, editor revision, outputs, and retry history remain.
8. Open or create an image document and use Place; success is valid only when a
   real layer is inserted.

This provider-free scenario is automated draft evidence only. Issue #85 remains
open for exit purposes until a configured-provider native invocation and a
moderated 6–8 creator walkthrough are recorded separately.

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

Workflow close and project switch/close remain blocked while any editor tab is
linked to that workflow. Return, discard, or close those tabs first so their
private return authority cannot outlive the workflow or project it belongs to.
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

The lane first exercises PaintNode's Rust resolver and runs only no-cost checks:
`codex login status` and `agy models`. It then launches **PaintNode Repo QA —
provider-e2e**, restricted to those two absolute paths. It does not submit an
image-generation request. A missing executable, non-zero version exit, missing
Codex login, or unavailable Antigravity model list fails with the provider and
path identified before the uniquely bundled **PaintNode Blueprint QA — Provider
E2E** app launches.

Do not bypass Gatekeeper, alter quarantine attributes, or remove a rejected
provider install as part of QA. Fix or replace that install outside PaintNode.
