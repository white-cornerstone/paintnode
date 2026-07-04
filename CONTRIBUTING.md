# Contributing

PaintNode is currently in early MVP development. Contributions and issue reports are welcome once the repository is public, but please keep changes focused and aligned with the app's AI-companion architecture for local model CLIs and layered documents.

## Development Setup

```bash
npm ci
npm run tauri:dev
```

## Before Submitting Changes

Run:

```bash
npm run check
npm test
```

Both must pass. `npm run check` must report 0 errors and 0 warnings.

## Code Guidelines

- Keep framework-agnostic engine logic in `src/lib/engine/`.
- Keep Svelte runes and UI state in `src/lib/state/` and `src/lib/components/`.
- Prefer pure functions and dependency injection for engine logic so it stays unit-testable.
- Use Fluent System Icons through `src/lib/icons/index.ts` and the shared `Icon.svelte` wrapper.
- Icon-only controls need the shared tooltip action and an `aria-label`.
- Follow `AGENTS.md` and `design.md` for project-specific UI and architecture conventions.

## Release Changes

Release and updater changes should also update [docs/release.md](docs/release.md) when the process changes.
