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
