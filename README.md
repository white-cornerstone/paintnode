# PaintNode

PaintNode is a backend-free raster image editor built for layered, local-first image work. It uses the open OpenRaster (`.ora`) format as its native document format, so projects stay portable across ORA-capable tools while keeping PaintNode's desktop workflow fast and self-contained.

![PaintNode icon](src-tauri/icons/icon.png)

## Highlights

- Layered raster editing with OpenRaster (`.ora`) load and save.
- Desktop app packaging with Tauri, Svelte 5, TypeScript, and Vite.
- Local-first file I/O, PNG/PSD export paths, and project asset management.
- Optional local AI CLI integrations for generation, retouching, extraction, and workflow composition.
- macOS Quick Look extensions for ORA thumbnail and preview support.
- Signed app updates through Tauri updater and GitHub Releases.

## Status

PaintNode is in early MVP development. Public releases are intended to be usable, but the editor surface, file compatibility, and packaging flow are still evolving.

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

No open-source license has been selected yet. Until a license is added, all rights are reserved by White Cornerstone Pty Ltd.
