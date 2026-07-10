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
Fake** Generate path after native QA mode detection completes. It creates a
deterministic 1024 x 1024 PNG in memory and stores it through the normal project
asset store. It never invokes Codex, Antigravity, provider authentication,
pickers, network requests, or visual-input file reads. The command that creates
the PNG rejects normal and provider-E2E modes.

Manual Creative Blueprint checkpoint:

1. Open a project folder that already contains a Product asset.
2. Create Campaign Composer and assign Product; leave optional Subject and
   Style empty.
3. Confirm the green QA Fake notice, run Square, and observe Running then
   Generated on the Transform card.
4. Confirm Square preview and asset binding, save the workflow, reopen it, and
   confirm the binding remains.
5. Open or create an image document and use Place; success is valid only when a
   real layer is inserted.

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
