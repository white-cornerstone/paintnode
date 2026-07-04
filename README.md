# PaintNode

Use Codex CLI and Antigravity inside a real image editor.

PaintNode is a desktop editor for people who already use AI CLIs. Start with a canvas, image, mask, or layered project, ask Codex CLI or Antigravity to generate or edit pixels, then keep the result as editable layers and project assets.

No hosted PaintNode model. No extra API-key billing layer. PaintNode uses the CLI login and subscriptions you already have configured on your machine.

![PaintNode icon](src-tauri/icons/icon.png)

## What You Can Do

- Generate a new image from a prompt and place it directly on the canvas.
- Use a mask to fill or replace part of an existing image.
- Retouch a selected area while keeping the original document open.
- Extract foreground objects or useful assets into project files.
- Let Codex CLI and Antigravity work on the same project in separate runs.
- Keep results in layered OpenRaster (`.ora`) documents, with PNG and PSD export paths.

## Who It Is For

- Codex CLI or Antigravity users who want AI image work to land in an editable document instead of a folder of loose PNGs.
- Developers and designers making app mockups, product visuals, game assets, storyboards, or marketing images.
- People who want local file control and their existing CLI setup, not another hosted AI image account.

PaintNode is not trying to be a full Photoshop replacement. It is focused on making AI CLI output useful inside a practical image-editing workflow: layers, masks, selections, assets, project files, review, edit, export.

## Highlights

- AI image flows for generation, fill, retouching, asset extraction, and workflow composition.
- Provider settings for existing local CLIs, including Codex CLI and Antigravity, with per-run overrides.
- Side-by-side Codex and Antigravity work on the same project through separate assets, tasks, and layers.
- Layered OpenRaster (`.ora`) documents for portable, user-owned creative files.
- Local-first file I/O, PNG/PSD export paths, and project asset management.
- Tauri desktop app built with Svelte 5, TypeScript, Rust, and Canvas2D.
- macOS Quick Look extensions for ORA thumbnail and preview support.
- Signed app updates through Tauri updater and GitHub Releases.

## Status

PaintNode is in early MVP development. Public releases are intended to test the Codex CLI and Antigravity image workflows, the layered document model, and the desktop packaging/update flow. The editor surface, provider contracts, and file compatibility are still evolving.

The current release channel is hosted on GitHub Releases:

```text
https://github.com/white-cornerstone/paintnode/releases
```

## Download

When public releases are available, download the latest build from:

[github.com/white-cornerstone/paintnode/releases/latest](https://github.com/white-cornerstone/paintnode/releases/latest)

macOS builds are signed and notarized by White Cornerstone Pty Ltd. PaintNode also checks GitHub Releases for signed Tauri updater metadata.

## Development

Requirements:

- Node.js 22 or newer
- Rust stable
- macOS for signed/notarized macOS release builds
- Optional local AI CLIs for AI features, such as Codex CLI or Antigravity

Install dependencies:

```bash
npm ci
```

Run the web development server:

```bash
npm run dev
```

Run the Tauri desktop app in development:

```bash
npm run tauri:dev
```

Build the static web app:

```bash
npm run build
```

Build the desktop app:

```bash
npm run tauri:build
```

For a local signed/notarized macOS release build, create `.env.macos-signing.local` with the required Apple and Tauri updater signing values, then run:

```bash
npm run tauri:build:mac:signed
```

## Quality Checks

Run both before publishing changes:

```bash
npm run check
npm test
```

`npm run check` must pass with 0 errors and 0 warnings.

## Repository Layout

```text
src/lib/engine/       framework-agnostic rendering and image logic
src/lib/state/        editor state, commands, settings, keyboard handling
src/lib/components/   Svelte UI components
src/lib/ora/          OpenRaster load/save
src/lib/icons/        Fluent System Icons registry
src-tauri/            Tauri shell, native commands, bundle configuration
docs/                 release and maintenance notes
```

## Release Flow

PaintNode releases are driven by tags named like:

```text
paintnode-v0.1.1
```

The GitHub Actions release workflow builds signed macOS app bundles, uploads installer assets, uploads updater artifacts, and publishes `latest.json` for the in-app updater.

See [docs/release.md](docs/release.md) for the signing secrets and release checklist.

## Security

Please report security issues privately. See [SECURITY.md](SECURITY.md).

## License

PaintNode source code is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).

The PaintNode name, logo, icon, signing identity, release channels, website, and other brand assets are not licensed under the GPL. See [TRADEMARKS.md](TRADEMARKS.md) for the brand policy.
