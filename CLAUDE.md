# CLAUDE.md

Project instructions for Claude Code working on **CX Paint**.

The full contributor & agent guidelines (commands, project layout, and coding conventions)
live in **AGENTS.md**. Follow them. It is imported here so it always loads into context:

@AGENTS.md

## Most important guideline: Icons

All UI icons must use Microsoft **Fluent System Icons** via `@fluentui/svg-icons` and the
shared `<Icon>` wrapper (`src/lib/components/Icon.svelte`). Never hand-write inline `<svg>`
markup, and never use emoji or unicode glyphs as icons. Note that `@fluentui/react-icons` is
React-only and must **not** be added to this Svelte project — use the SVG source package
instead. See the **Icons** section in AGENTS.md for how to use and add icons.
