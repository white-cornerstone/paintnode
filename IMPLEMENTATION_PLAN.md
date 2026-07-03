# Photoshop-parity Type Tool: Character/Paragraph panels + editable PSD text

Goal: extend PaintNode's text engine toward Photoshop's Type tool — Character panel
(family/style, size, leading, tracking, V/H scale, baseline shift, color, faux bold/
italic, all/small caps, super/subscript, underline/strikethrough, anti-alias) and
Paragraph panel (7 alignment modes, indents, first-line indent, space before/after,
hyphenate) — then import PSD text layers as *editable* text when representable
(instead of locked), keeping the passthrough safety net for everything else.

ag-psd caveats handled: edited text layers are written with `invalidateTextLayers`
(Photoshop re-renders them, with its standard "update text layers" prompt); vertical
orientation, box/area text, warp, and path text stay locked-passthrough (never
rewritten); forking ag-psd is deferred until we hit a concrete limitation that
matters (documented at the end).

## Stage 1: Text model v2 + renderer
**Goal**: extend `engine/text/model.ts` (per-run: strikethrough, leading px|auto,
horizontal/vertical scale %, baseline shift, caps none/small/all, script
none/super/sub; per-paragraph: justify-* alignments, indents, first-line indent,
space before/after, hyphenate flag; model-level antiAlias for round-trip) with
defensive coercion + migration of old `lineHeight` docs to explicit leading.
Extend `engine/text/render.ts`: leading-based baseline advance, per-run transforms
for scales, baseline shift, script sizing/shift, manual small-caps segments,
strikethrough, indents and paragraph spacing, justify-* mapped for point text.
**Tests**: model round-trip/migration + layout math via fake surface.
**Status**: Complete

## Stage 2: Editor APIs + overlay parity + Character/Paragraph panels
**Goal**: editor methods to apply character/paragraph patches to the current edit
selection (via overlay) or the selected text layer (via applyTextEdit); overlay
CSS/dataset round-trip for new attributes; `CharacterPanel.svelte` +
`ParagraphPanel.svelte` registered in the right-dock 'edits' tab group, reflecting
the caret/selection style; font style dropdown (Regular/Italic/Bold/Bold Italic).
**Status**: Complete

## Stage 3: Editable PSD text import/export
**Goal**: pure `psdTextToModel` mapping (fonts from PostScript names, styles,
paragraphs split on \r, units converted) with conservative bail-outs (vertical,
box text, warp, path text, stroke) that fall back to locked; loader marks
convertible text layers as editable `kind: 'text'` keeping the original bitmap +
passthrough; export maps all new fields back and sets `invalidateTextLayers`
only when a text layer is actually (re)written.
**Tests**: mapping units/bail-outs; round-trip PSD text fixture.
**Status**: Not Started

## Stage 4: End-to-end verification
**Goal**: fixture PSD with styled text opened in the running app; text editable;
panels drive styling; export re-read to confirm text data + untouched-layer
byte-identity; document the Photoshop re-render prompt behavior.
**Status**: Not Started

## Deferred
- Forking ag-psd (vertical text writing, predefined Paragraph/Character Styles,
  regenerating text bitmaps to avoid Photoshop's update prompt) — revisit once the
  in-app engine is at parity and we can measure what actually blocks users.
- Box/area text with wrapping + hyphenation; vertical type; type mask tools.
- Per-pair manual kerning and optical kerning; OpenType feature toggles; language
  dictionaries.
- Real font-face enumeration (weights per family) instead of faux bold/italic.
