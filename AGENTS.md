# AGENTS.md

Guidance for AI agents and contributors working on **PaintNode** — a backend-free,
Photoshop-style raster image editor (Svelte 5 + TypeScript + Vite) that uses the open
**OpenRaster (.ora)** format as its native document format.

## Commands

- `npm run dev` — start the dev server (Vite, port 5173)
- `npm run build` — production build → `dist/` (fully static, no backend)
- `npm run check` — `svelte-check` type check. **Must pass with 0 errors and 0 warnings.**
- `npm test` — run the Vitest unit suite (`npm run test:watch` while developing). **Must pass.**

## Testing

Unit tests live next to the code as `*.test.ts` and run in a Node environment via Vitest.
Focus tests on the framework-agnostic engine logic in `src/lib/engine/` — pure functions with
no DOM/canvas dependency are the most valuable to cover (text model, color math, text layout).
Keep that logic testable: prefer pure functions and dependency injection over reaching for the
DOM. For example, the text renderer (`engine/text/render.ts`) takes an injectable measure/draw
surface (a real 2D context in the app, a fake in tests) so its layout math is unit-testable.
DOM/canvas- and component-level coverage needs a browser environment and is not set up yet.

## Project layout

- `src/lib/engine/` — framework-agnostic rendering engine (canvas / pixel work). Plain TS, **no Svelte**.
- `src/lib/state/` — reactive stores (Svelte 5 runes), the editor hub, keyboard, commands.
- `src/lib/components/` — Svelte UI components.
- `src/lib/ora/` — OpenRaster (.ora) load / save.
- `src/lib/icons/` — Fluent icon registry (see below).

## Guidelines

### Icons — use Fluent System Icons only

All UI icons **MUST** come from Microsoft **Fluent System Icons**, via the
`@fluentui/svg-icons` package and the shared `<Icon>` wrapper.

**Do not** hand-write inline `<svg>` markup, and **do not** use emoji or unicode glyphs
(`✕`, `▲`, `▼`, `⇄`, `＋`, `🗑`, `◆`, …) as icons.

> ⚠️ The catalog and most examples online show `@fluentui/react-icons` (the
> `<DismissSquareRegular />` React component API). That package is **React-only and cannot
> run in this Svelte app.** We use the *same icon set* through its framework-agnostic SVG
> source package, `@fluentui/svg-icons`, wrapped by `src/lib/components/Icon.svelte`.

**Using an existing icon** (adjust the relative import paths to your file's location):

```svelte
<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { Dismiss } from '../icons';
</script>

<!-- decorative (button already has aria-label) -->
<button aria-label="Close"><Icon svg={Dismiss} size={16} /></button>

<!-- standalone / meaningful: pass a label -->
<Icon svg={Dismiss} size={20} label="Close" />
```

- Icons inherit the current text color (`currentColor`) — set `color` on the parent.
- `size` is in px (we standardize on the `_24_regular` SVGs and scale at the call site).
- Pass `label` only when the icon conveys meaning on its own; omit it for decorative icons
  (they are rendered `aria-hidden`).

**Adding a new icon:**

1. Find the SVG in `node_modules/@fluentui/svg-icons/icons/`. Files are named
   `<name>_<size>_<style>.svg` — prefer the `_24_regular` variant. Browse the catalog:
   https://storybooks.fluentui.dev/react/?path=/docs/fluent-system-icons_icons-catalog--docs
   (the names shown there map to these files, e.g. `DismissSquare` → `dismiss_square_24_regular.svg`).
2. Re-export it from `src/lib/icons/index.ts` (the `?raw` suffix imports the SVG as a string):

   ```ts
   export { default as DismissSquare } from '@fluentui/svg-icons/icons/dismiss_square_24_regular.svg?raw';
   ```

3. Render it with `<Icon svg={DismissSquare} />`.

Imports are tree-shaken, so only the icons re-exported in the registry are bundled.

### Tooltips — every icon-only control needs one

Any control whose only content is an icon (no visible text label) **MUST** have a tooltip so
its purpose is discoverable on hover/focus. Use the shared `tooltip` action — not the native
`title` attribute (native titles are slow and unstyled).

```svelte
<script lang="ts">
  import { tooltip } from '../actions/tooltip';
</script>

<button use:tooltip={{ text: 'New layer', placement: 'top' }} aria-label="New layer">
  <Icon svg={Add} />
</button>
```

- `use:tooltip={'text'}` (placement defaults to `top`) or `use:tooltip={{ text, placement }}`,
  where `placement` is `top | bottom | left | right` (auto-flips near viewport edges).
- Pick a placement that points away from the nearest edge: `right` for the left tool dock,
  `top` for bottom button bars, `left` for right-hand panels.
- Keep `aria-label` on the control for screen readers; the tooltip is the visual affordance.
- Include the keyboard shortcut in the text when there is one, e.g. `'Brush (B)'`.

### Engine vs. UI separation

Keep heavy pixel/canvas work in `src/lib/engine/` as plain TypeScript so it never depends on
Svelte's reactivity. Svelte runes are for UI state and chrome only.
