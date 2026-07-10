# Grok (xAI) provider integration — Implementation Plan

Add **Grok** as a PaintNode AI provider, mirroring the **Antigravity** integration:
- **AI Director** → drives the local **`grok`** CLI (like Antigravity drives `agy`).
- **Image generator** → **decoupled** direct call to `https://api.x.ai/v1/images/generations`
  using the token in `~/.grok/auth.json` (no API key), exactly as verified in the feasibility study.

Scope now: **text-to-image generation + Grok-as-Director**. Image **edit** (image-to-image:
fill / retouch / auto-adjust / upscale / decouple / compose) and **video** are documented in
`docs/grok-future-expansion.md` for a later pass — they depend on the xAI image-edit / video
endpoints which are not yet live-verified.

Reference files: `src-tauri/src/ai/antigravity.rs` (image + director), `codex.rs` (provider enums),
`mod.rs` (shared enums/helpers), `canvas.rs` + `src/lib/ai/imageModelCapabilities.json`
(capabilities), `placement.rs` (`AiEditProvider`), `lib.rs` (command registration), and the
frontend map in `src/lib/state/settings.ts` + dialogs.

---

## Stage 1: Rust — Grok image engine (decoupled) + detection/capabilities
**Goal**: `grok.rs` module that authenticates from `~/.grok/auth.json`, POSTs to the xAI images
API, and returns PNG bytes; plus `detect_grok` / `discover_grok_capabilities`. Direct generation
only (no agentic director loop yet).
**Success Criteria**: `cargo check` green; `generate_grok_image` command produces a PNG from a
prompt end-to-end against the real endpoint.
**Tests**: unit — auth.json parsing, request-body build (geometry-free), response b64 decode,
aspect/size mapping. Manual — one real generation.
**Status**: Complete (see end-of-stage note below).

- `grok.rs`: `load_grok_auth_token` (read file, parse JWT expiry), `grok_token_needs_refresh`,
  `wake_grok_auth` (`grok models` to refresh), `post_grok_image_request`, `run_grok_direct_image`,
  `decode_grok_images_response` (`data[0].b64_json` → PNG via `image` crate), `grok_image_request_json`.
- `canvas.rs` + `imageModelCapabilities.json`: `grok` capability (aspect ratios + size tiers).
- `mod.rs`: module decl. `lib.rs`: register commands.
- Note: the standalone `generate_grok_image` command does NOT need `PaintNodeImageProvider`/
  `AiEditProvider` (those are edit-path only), so that enum wiring is deferred to the edit doc.
**Status**: Complete — `grok.rs` added, `cargo check` green, 5 unit tests pass. Generate path
mirrors the verified standalone call (`api.x.ai/v1/images/generations`, b64_json → PNG).

## Stage 2: Rust — Grok as AI Director (local CLI)
**Goal**: `AiDirectorProvider::Grok` fully wired into the director loop so Grok can supervise any
image generation, driving `grok -p --output-format streaming-json --always-approve`.
**Success Criteria**: `cargo check` green; selecting Grok director runs the `grok` CLI and its
`thought`/`text`/`end` events surface as progress; session reuse via `--session-id`/`--resume`.
**Tests**: unit — streaming-json event → progress mapping, command arg construction, capabilities
parse. Manual — a generate run with Grok as director.
**Status**: Complete — `AiDirectorProvider::Grok` + `PaintNodeDirectorProvider::Grok` wired through
every dispatch match (`mod.rs`, `codex.rs`, `antigravity.rs`); `run_grok_director_request` drives
`grok -p --output-format streaming-json --always-approve`, session reuse via `end.sessionId`. Grok
Director bin/model use defaults for now (not threaded through image commands — noted as follow-up).
Grok-directed generative fill returns a "coming soon" error. `cargo check` clean, all 167 tests pass.

- `run_grok_director_request` + `build_grok_command` + `run_grok_with_progress` (reuse
  `spawn_output_reader`, add grok event parsing to `provider_progress_update`).
- Add `Grok` arms: `mod.rs` (`AiDirectorProvider`, `label`, `ai_provider_features` transport
  `"cli"`+`structured_progress:true`, `ai_director_provider` parser), `codex.rs`
  (`PaintNodeDirectorProvider` + 5 methods + director dispatch matches), `antigravity.rs` director
  dispatch matches, `placement.rs` `AiEditProvider`.

## Stage 3: Frontend — expose Grok in settings/UI + wire generate
**Goal**: user can pick Grok as image generator and/or AI Director; generate dispatches to the
Grok command.
**Success Criteria**: `npm run check` 0/0; Grok selectable in Settings, profile radios, per-run
popover, wizard; a generate run uses `generate_grok_image`; edit-family ops show a clear
"coming soon" for Grok rather than mis-routing.
**Tests**: existing vitest suite passes; geometry-free prompt guards extended.
**Status**: Complete — `'grok'` added to `AiProvider`; settings types/normalizers/defaults/clone/profile
mappers, `desktop.ts` (`generateGrokImage`/`detectGrok`/`discoverGrokCapabilities` + config), capability
loader/fallback, generate dispatch (`generateExecutor.ts`), and UI (Settings dropdowns + profile radios,
per-run popover, labels) all wired. Edit-family ops (retouch/auto-adjust/upscale/decouple/compose/fill)
show a clear "coming soon" guard for Grok instead of misrouting. `npm run check` 0/0, 201 vitest pass.

- `settings.ts` union types + normalizers + model consts + `ai` fields + defaults/normalize/clone.
- `desktop.ts` invoke wrappers (`detectGrok`, `discoverGrokCapabilities`, `generateGrokImage`) +
  config builders. `providerCapabilities.ts` loader + fallback.
- Dropdowns/radios/popover/wizard (`SettingsDialog`, `AiRunOptionsControl`, `AiSetupWizard`),
  label + run-dir helpers (`taskSupport.ts`), detection message.
- Edit-family dispatch (`AiRetouchDialog`, `AiUpscaleDialog`, `AiDecoupleDialog`, `WorkflowBoard`,
  `generateExecutor`): Grok → friendly "not yet supported" guard.

## Stage 4: Future-expansion doc
**Goal**: `docs/grok-future-expansion.md` detailing image-edit (image-to-image) and video flows,
the verified facts, endpoints, and how to implement each in this codebase.
**Success Criteria**: doc covers endpoint contracts, auth, request/response shapes, PaintNode
wiring points, and open questions (token refresh, moderation, ZDR, tier gating).
**Status**: Complete — `docs/grok-future-expansion.md` written (image edit + video flows, verified
vs. to-capture facts, exact PaintNode wiring points, shared prereqs).

---

## Cross-cutting facts (verified)
- Endpoint: `POST https://api.x.ai/v1/images/generations`, headers `authorization: Bearer <jwt>`,
  `user-agent: xai-grok-build/<ver>`, `x-grok-client-version: <ver>`.
- Body: `{model:"grok-imagine-image-quality", prompt, n:1, aspect_ratio, resolution:"1k", response_format:"b64_json"}`.
- Response: `{data:[{b64_json, mime_type}], usage}`. Moderation → HTTP 400 with `error` + `cost_in_usd_ticks`.
- Token: `~/.grok/auth.json` → first record → `.key` (JWT, ~6h, `.refresh_token`); `grok models` refreshes it.
- Prompts stay geometry-free (AGENTS.md): aspect via `aspect_ratio` param, size via `resolution`, never pixels in prose.
- Debug artifacts (raw request/response JSON) gated behind keep-debug-artifacts, off by default (AGENTS.md).
