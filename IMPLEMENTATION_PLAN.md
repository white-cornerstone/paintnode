# PSD Open with Photoshop-Compatibility Preservation

Goal: open `.psd` files in PaintNode. Layers we fully support become normal editable
layers; Photoshop-only layers (adjustments, smart objects, text, vectors, effects) are
imported as **locked** raster previews whose original PSD data is preserved and written
back untouched on PSD export — so a PaintNode round trip never destroys Photoshop work.

Key mechanism: `ag-psd` `readPsd(..., { useRawData: true })` keeps each layer's original
compressed channel data (`layer.rawData`), and `writePsd` re-emits `rawData` byte-identical
when present. Untouched layers (locked or clean) pass through; edited layers are rebuilt
from their PaintNode canvas. Groups are flattened for editing but each imported layer
remembers its group chain so the PSD group tree is reconstructed on save.

## Stage 1: PSD import core (read + classify)
**Goal**: `src/lib/psd/import.ts` (pure structure walk/classification, Node-testable) +
`src/lib/psd/load.ts` (DOM decode → PaintDocument). No UI wiring yet.
**Success Criteria**: fake-Psd unit tests pass; classification marks adjustment/smart
object/text/vector/effects/artboard layers as locked with a reason; groups flatten with
recorded group chains; PSD blend modes map to PaintNode modes with an `approximated` flag.
**Tests**: `import.test.ts` — classification, group flattening + visibility inheritance,
blend mapping, clipping flag capture.
**Status**: Complete

## Stage 2: PSD save passthrough
**Goal**: `buildPsdDocument` rebuilds the original PSD tree: untouched imported layers
re-emit their original `rawData` objects (with name/hidden/opacity/position patches),
edited raster layers are rebuilt from canvas keeping parsed metadata, new layers use the
existing export path, group tree reconstructed from recorded chains, document-level
resources (imageResources, linkedFiles, globalLayerMaskInfo) passed through.
**Success Criteria**: Node round-trip test: write a PSD containing passthrough layers →
readPsd again → channel bytes identical; group nesting restored; patches applied.
**Tests**: `save.test.ts` additions + `roundtrip.test.ts`.
**Status**: Complete

## Stage 3: Engine model + locked-layer guards
**Goal**: `Layer.psd` passthrough meta + `locked` getter; `PaintDocument.psdSource`;
guards in editor choke points (applyPixelOp, applyFilter, clearActive, fillActive*,
beginFreeTransform, mergeDown, duplicateLayer, beginMoveSelectedContent, doc-wide
rotate/flip/crop/resize) and CanvasView pointer-down; PSD layer masks render via
compositor (alpha mask honoring defaultColor). Visibility/opacity/blend/rename/reorder/
delete stay allowed on locked layers.
**Success Criteria**: locked layers reject all pixel/structural edits with a flash
message; meta survives history snapshots (cloneLayerExact) and clone/remap paths.
**Tests**: Document/Layer meta preservation tests where pure.
**Status**: Not Started

## Stage 4: Open wiring + Layers panel UI
**Goal**: File ▸ Open accepts `.psd` (picker, drag-drop, desktop paths); import notices
flashed; LayersPanel lock badge (Fluent `LockClosed`) with tooltip explaining preservation;
footer buttons (duplicate/merge) disabled for locked rows; opacity/blend/visibility remain.
**Success Criteria**: opening a real PSD shows layers correctly positioned with locked
badges; `npm run check` and `npm test` pass with 0 errors/warnings.
**Status**: Not Started

## Stage 5: Polish & honesty passes
**Goal**: warn when saving `.ora` that Photoshop-only passthrough data isn't stored in
`.ora` (Export PSD keeps it); clipped-layer compositing approximation if time allows;
PropertiesPanel read-only hint for locked layers.
**Status**: Not Started

## Deferred (future work, discussed but out of scope here)
- Native group/folder support in the layer model, UI, and `.ora` (nested stacks).
- Editable import of simple PSD text layers into PaintNode's text model.
- Applying supported adjustment layers (brightness/contrast, hue/sat) in the compositor
  for closer visual fidelity.
- Persisting PSD passthrough data inside `.ora` for full round trips across sessions.
- Clipping-mask visual compositing; "Rasterize protected layer" explicit action.
