# PaintNode Design

PaintNode uses a compact Photoshop-style desktop UI. Keep controls dense, quiet, and consistent across panels and modal dialogs.

## Typography

- UI font family: inherit the global app stack from `src/app.css`: `-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- Base UI text: `12px`, regular or `500`.
- Panel headers, modal titles, button labels, and form labels: `12px` with `font-weight: 600`.
- Secondary hints, status text, captions, and dense metadata: `11px`, regular to `600` only when emphasis is needed.
- Avoid local modal-only type scales unless there is a clear product reason. Dialogs such as `Modal.svelte`, Generate Image (AI), and custom Photoshop-style dialogs should share the same 12px title/control rhythm.
- Use inherited font settings for `button`, `input`, `select`, and `textarea` unless a component is intentionally rendering document/canvas content.

## Dialogs

- Modal title bars should feel aligned with `src/lib/components/Modal.svelte`: compact height, 12px title text, and medium-semibold weight.
- Form controls should remain narrow enough for desktop tool use, with only the space needed for readable values.
- Prefer increasing dialog height before widening a dialog when controls need more breathing room.
