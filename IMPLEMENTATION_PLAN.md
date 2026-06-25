# Editable Text Layers — Implementation Plan

Goal: text added with the Type tool becomes an **editable text layer** (rich, per-run
styling) that round-trips through `.ora`, can be re-edited and restyled, and can be
converted to pixels via **Rasterize Type**. Fonts can optionally be embedded into the
`.ora` so the file renders identically on other machines.

Format decision: stay on `.ora`. Use its extension mechanisms — custom `cx-*` attributes
on `<layer>` plus extra files in the zip. Each text layer stores:
- a rasterized PNG (`data/layerN.png`) — the composited pixels, for interop + display, and
- a sidecar JSON model (`data/layerN.text.json`) — the editable rich-text model.

Quality gate: `npm run check` must pass with **0 errors / 0 warnings** every stage. The
project has no test framework (AGENTS.md), so check + manual `npm run dev` is the gate.

---

## Stage 1: Engine — text model + renderer
**Goal**: A rich `TextModel` type, a pure renderer that draws it to a canvas, and a `Layer`
that can hold a text model. The existing Type tool produces an editable text layer.
**Files**: `engine/text/model.ts`, `engine/text/render.ts`, `engine/Layer.svelte.ts`,
`state/editor.svelte.ts` (`addText` → builds a model), `components/TextDialog.svelte`.
**Success**: Click Type → dialog → text appears as a `kind:'text'` layer rendered by the
new renderer; `npm run check` clean.
**Status**: Complete

## Stage 2: `.ora` round-trip
**Goal**: Save writes the sidecar JSON + `cx-*` attributes + PNG; load reconstructs the
text layer. Raster layers unchanged. Opens as flat raster in other ORA apps.
**Files**: `ora/save.ts`, `ora/load.ts`.
**Success**: Save a doc with a text layer, reload it → still a text layer with the same
model; `npm run check` clean.
**Status**: Complete

## Stage 3: Edit UI — overlay + Type controls
**Goal**: In-canvas editing of text layers. Overlay `contenteditable` positioned over the
canvas; a floating Character/Paragraph toolbar (family, size, color, B/I/U, alignment,
line height). Click empty canvas = new text; click existing text layer = edit it. Commit
on Esc / click-away; undoable. Type-tool flyout listing the 4 Photoshop variants
(Horizontal active; Vertical + Mask stubbed/deferred).
**Files**: new `components/TextEditorOverlay.svelte`, `engine/text/render.ts` (hit-test +
DOM↔model serialize), `editor.svelte.ts`, `CanvasView.svelte`, `Toolbar.svelte`,
`ToolOptions.svelte`, `icons/index.ts`.
**Success**: Create, edit, restyle a per-run-styled text layer; reopen still editable.
**Status**: Complete

## Stage 4: Rasterize Type
**Goal**: Convert a text layer to a plain raster layer (drop the model, keep pixels).
Undoable. Menu item + a Layers-panel affordance; text layers show a "T" badge.
**Files**: `editor.svelte.ts`, `MenuBar.svelte`, `LayersPanel.svelte`.
**Success**: Rasterize Type on a text layer → `kind:'raster'`, pixels unchanged, no longer
editable as text; undo restores the text layer.
**Status**: Complete

## Stage 5: Fonts — import + optional embed
**Goal**: Import fonts (`FontFace`), curated family list. On save, if text layers use
embeddable (bundled/imported) fonts, prompt to embed them into the `.ora` (`fonts/…` +
`fonts/manifest.json`); system fonts can't be embedded (browser can't read their bytes) —
prompt says so and falls back. On load, register embedded fonts.
**Files**: new `state/fonts.svelte.ts`, save/load, a save-prompt dialog, Type controls.
**Success**: Embed an imported font; the `.ora` registers it on load so re-rendering matches.
**Status**: Not Started
