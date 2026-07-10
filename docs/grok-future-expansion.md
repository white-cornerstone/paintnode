# Grok (xAI) provider — future expansion: video (image edit now implemented)

> **Status update:** image editing is now IMPLEMENTED. The endpoint was
> confirmed against the official xAI docs (`POST /v1/images/edits`; single
> `image {url}` or `images: [{url}...]` data-URI inputs, max 3, referenced as
> `<IMAGE_n>` in the prompt; `aspect_ratio`; `resolution: "1k"|"2k"`; same
> `data[{b64_json}]` envelope) and cross-checked against strings in the grok
> CLI binary. PaintNode wiring: `run_grok_owned_image_edit` +
> `grok_restore_image_details` in `src-tauri/src/ai/grok.rs`, Tauri commands
> `generate_grok_fill_image` / `generate_grok_retouch_image` /
> `upscale_grok_image` / `compose_grok_workflow`, `AiEditProvider::Grok` +
> `PaintNodeImageProvider::Grok` through placement/codex dispatch, reference
> images (≤3) routed through the edit endpoint, a >1.25x detail-restoration
> pass after cover-crop, and a user-facing `grokImageResolution`
> (auto/1k/2k) setting. Asset extraction (decouple) remains unimplemented —
> it needs an agentic manifest loop the xAI image API does not provide.
> **Video generation below remains future work.**

This document captures the flow, verified facts, and PaintNode wiring for
Grok **video generation** (not yet implemented) and retains the original
image-edit research notes for reference.

All of this reuses the same decoupled auth model already implemented in
`src-tauri/src/ai/grok.rs`: read the bearer JWT from `~/.grok/auth.json`, refresh
by running `grok models`. No xAI API key is needed. Image/video generation is a
**SuperGrok-tier** feature; free / X-Basic accounts receive an upgrade error.

---

## Status of what is verified

| Capability | Endpoint | Verified? |
|---|---|---|
| Text-to-image | `POST https://api.x.ai/v1/images/generations` | ✅ live-captured + replayed |
| Image edit (image-to-image) | *(unconfirmed — see below)* | ⚠️ inferred from CLI strings + session logs; **must be captured** |
| Video (image→video) | *(unconfirmed — start→poll→download)* | ⚠️ inferred from binary strings; **must be captured** |

**How to capture the unconfirmed endpoints** (same method as the generate proof):
run `mitmproxy` on a port, trust its CA in the macOS keychain, launch the Grok CLI
with `HTTPS_PROXY`/`HTTP_PROXY` set, and drive one `image_edit` / `image_to_video`
call. The CLI is a `reqwest` client that honors the proxy env and validates TLS via
the macOS keychain (`rustls-platform-verifier`), so the decrypted request reveals
the exact endpoint, headers, and body. Grok CLI is `rustls`-based; the image tools
run client-side (the HTTP 400 moderation error originates in
`crates/.../grok_build/image_edit/mod.rs`).

---

## 1. Image edit (image-to-image)

### CLI-observed contract (from session logs `~/.grok/sessions/.../chat_history.jsonl`)
The Grok CLI `image_edit` tool takes:
```jsonc
{ "prompt": "describe only what changes; note what stays the same",
  "image": ["/abs/path.jpg", ...],      // one or more source/reference images
  "aspect_ratio": "16:9" }               // optional; used for multi-image edits
```
It returns a saved image path; failures come back as the same Imagine error shape:
```jsonc
{ "code": "...", "error": "...rejected by content moderation.", "usage": { "cost_in_usd_ticks": 600000000 } }
```
Tool description in the binary: *"Edit or transform existing image(s) via the xAI
Imagine API; use instead of image_gen for image-to-image work (preserve likeness,
transfer style, remix)."*

### Likely HTTP shape (to confirm by capture)
Two candidates, both OpenAI-compatible and on `api.x.ai`:
- `POST /v1/images/generations` with an added `image` (base64 / data-URL) input, or
- a dedicated `POST /v1/images/edits`.
Auth + headers are identical to generation (`Authorization: Bearer <auth.json key>`,
`user-agent: xai-grok-build/<ver>`, `x-grok-client-version: <ver>`). Response is
expected to be the same `{ data:[{ b64_json, mime_type }], usage }` envelope.

### PaintNode wiring (mirror Antigravity's edit path)
Image editing is where PaintNode's `PaintNodeImageProvider` / `AiEditProvider`
machinery is required (unlike pure generation). To add Grok edit:

1. **`src-tauri/src/ai/grok.rs`** — add `run_grok_owned_image_edit(...)`: like
   `run_grok_direct_image` but sends the working-canvas crop as the `image` input
   and returns the edited PNG. Reuse `AiWorkingCanvas` + `read_png_bytes_cropped_to_ai_working_canvas`.
2. **`src-tauri/src/ai/codex.rs`** — `enum PaintNodeImageProvider` (~L103): add
   `Grok`; extend `from_option` (`"grok" | "xai"`), `PaintNodeImageProviderOptions`
   (add `grok_*` fields + initializer + command-arg plumbing at ~L3362/3425), and the
   dispatch match in `run_paintnode_owned_fill_image_request` (~L2481) →
   `PaintNodeImageProvider::Grok => run_grok_owned_image_edit(...)`. Map to
   `AiEditProvider::Grok` (~L3472).
3. **`src-tauri/src/ai/placement.rs`** — `enum AiEditProvider` (~L77): add `Grok`
   and every match arm (label L85, source-frame dims L544, crop dims L557, split
   candidates L608, fill geometry L939, overview/anchor L2692). Decide Grok geometry
   behaves like Antigravity (ratio-based crops via the `grok` capability in
   `imageModelCapabilities.json`) rather than Codex tile-splitting.
4. **New Tauri commands** in `grok.rs`, registered in `src-tauri/src/lib.rs`:
   `generate_grok_fill_image`, `generate_grok_retouch_image`, `upscale_grok_image`,
   and (if an agentic asset-extractor is wanted) `decouple_grok_image` /
   `compose_grok_workflow`. NB: `decouple` in this repo shells out to an agentic CLI
   and reads `manifest.json`; xAI has no agentic image loop, so a Grok decouple would
   have to be driven by the **Grok Director** (`grok` CLI) writing the manifest, or
   dropped.
5. **Frontend** (`src/lib/integrations/desktop.ts` invoke wrappers + config builders;
   dispatch ternaries in `generateExecutor.ts`, `AiRetouchDialog.svelte`,
   `AiAutoAdjustDialog.svelte`, `AiUpscaleDialog.svelte`, `AiDecoupleDialog.svelte`,
   `WorkflowBoard.svelte`): replace the current "Grok edit coming soon" guard with the
   real 3-way branch, and add `grok` to `imageModelCapabilities.ts` `AiImageProvider`.

### Notes / open questions
- Multi-image references (identity/style) are supported by the CLI tool; confirm the
  API field name and max count. (Grok CLI `reference_to_video` allows 2–7 refs.)
- Moderation and `cost_in_usd_ticks` metering flow through unchanged.

---

## 2. Video generation (image → video)

### CLI-observed contract (session logs)
- `image_to_video`: `{ image: "<abs path>", prompt, duration: 6|10, resolution_name: "480p"|"720p" }`
- `reference_to_video`: `{ images: ["<2..7 paths>"], prompt, aspect_ratio, duration, resolution_name }`
- There is **no text-to-video**; a source image (frame 1) is always required.
- Model: `grok-imagine-video-1.5-preview`. Video is SuperGrok-only.

### Flow (from binary strings — to confirm by capture)
1. **Start**: POST the source image + prompt + duration/resolution → returns a
   `request_id`. (Endpoint unconfirmed; likely `api.x.ai/v1/videos/generations`.)
2. **Poll**: GET/POST by `request_id` until complete ("Video generation still in
   progress" → "Video generation completed"); returns a download URL.
3. **Download**: fetch the `video/mp4`. For **ZDR** (zero-data-retention) accounts,
   the source image is uploaded to a presigned S3 URL and the output video is fetched
   via a presigned GET (`x-zero-data-retention` header seen on responses; grok binary
   references `zdr_video_output_s3`, `grok-videos/` prefix).

### PaintNode wiring
PaintNode has no video document model yet, so this is the larger lift:
1. **`src-tauri/src/ai/grok.rs`** — `run_grok_image_to_video(...)`: auth (reuse
   `load_grok_auth_token`), POST start, poll loop with `ai_run_cancelled` checks +
   `emit_codex_progress`, download MP4 bytes. Add a `generate_grok_video` Tauri
   command returning the saved video path (not `GeneratedImageResult`).
2. **New result type** (video path + metadata) and a frontend surface to place/preview
   video output — this does not fit the current PNG-layer pipeline and needs product
   design (where video lives on the node board / canvas).
3. Register the command in `lib.rs`; add a "Generate video" affordance gated to Grok +
   SuperGrok, with duration (6/10s) and resolution (480p/720p) controls.
4. Assemble multi-shot sequences with FFmpeg stream-copy (`-c copy`, no re-encode), per
   the Grok `imagine` skill guidance, keeping every shot at the same resolution/fps.

### Notes / open questions
- Capture the start/poll/download endpoints and the ZDR presign handshake before
  implementing; the polling contract (field names, terminal states, expiry) must be exact.
- Duration is 6 or 10 seconds only; resolution 480p or 720p.
- This is the flagship tie-in to the node workflow board — video shots as nodes.

---

## Shared prerequisites for both

- **Token refresh without the CLI**: today PaintNode relies on `grok models` to refresh
  `~/.grok/auth.json`. A fully self-contained integration should implement the OIDC
  refresh-token flow against `https://auth.x.ai` directly (endpoint not yet captured),
  so PaintNode can renew tokens even if the CLI is never run.
- **Debug artifacts** (raw request/response JSON) must stay gated behind the
  keep-debug-artifacts setting and default off (AGENTS.md).
- **Geometry-free prompts**: express shape only via `aspect_ratio` / `resolution` /
  `duration` parameters, never pixel dimensions in prompt prose (AGENTS.md).
