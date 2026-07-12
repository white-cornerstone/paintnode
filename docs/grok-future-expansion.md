# Grok provider: implemented scope and future expansion

## Current PaintNode support

PaintNode currently supports Grok as both an AI Director and an image provider.
The implementation uses the signed local Grok CLI for authentication and
Director turns, and the xAI Images API for pixel generation and editing.

| Capability | Status |
| --- | --- |
| AI Director workflow drafting and revision | Implemented |
| Text-to-image generation | Implemented |
| Image-to-image generation with up to three references | Implemented |
| Generative fill and retouch | Implemented |
| Upscale and detail restoration | Implemented |
| Multi-asset workflow composition | Implemented, up to three sources |
| Asset extraction / decouple | Not implemented |
| Video generation | Not implemented |

The image-edit path uses `POST /v1/images/edits` with data-URI image inputs,
an optional aspect ratio, a `1k` or `2k` resolution tier, and the same
base64-image response envelope as generation. The main implementation lives in
`src-tauri/src/ai/grok.rs`; frontend routing and settings live under
`src/lib/ai`, `src/lib/integrations`, and the AI dialogs.

PaintNode discovers and revalidates the canonical signed Grok executable before
every CLI launch. On macOS, it pins the X.AI Corporation Team ID. Authentication
reuses the local Grok sign-in; `grok models` is the no-generation refresh and
capability probe when the stored token needs renewal.

## Remaining image limitation: asset extraction

The image API returns images, not a structured multi-layer asset manifest.
PaintNode's current extraction flow expects an agentic provider to produce and
validate that manifest. Grok asset extraction should remain unavailable until
one of these designs has a tested contract:

1. the Grok Director prepares the same constrained manifest used by existing
   extraction flows; or
2. PaintNode owns deterministic segmentation and uses Grok only for bounded
   cleanup edits.

Do not expose a partial extraction control that silently returns a flattened
image.

## Future capability: video generation

Video does not fit PaintNode's current PNG-layer document model. Before adding a
Grok video control, verify the current official xAI API contract and decide how
video assets live in projects and on the workflow board.

The product design must cover:

- source-image and multi-reference inputs;
- supported duration, resolution, and aspect-ratio choices;
- start, progress, cancellation, retry, and terminal failure states;
- persisted project metadata and preview thumbnails;
- output placement on the workflow board without pretending an MP4 is a raster
  document layer; and
- export or sequence assembly without hidden transcoding.

The implementation should use a dedicated video result type rather than
`GeneratedImageResult`. A future native command would own request submission,
bounded polling, cancellation checks, download validation, and atomic project
storage. The frontend should expose video only when capability discovery confirms
that the signed-in account and selected model support it.

## Shared requirements for future Grok work

- Keep raw request and response artifacts behind the existing debug-artifact
  setting; the default remains off.
- Never log or persist bearer tokens in project files, task details, or provider
  progress.
- Preserve geometry in structured request fields rather than prompt prose.
- Reuse the provider executable resolver, pinned macOS vendor identity, bounded
  process-tree cleanup, and cancellation contracts.
- Add focused Rust and TypeScript tests, a no-generation provider-doctor check,
  and native desktop validation before enabling a new capability.
