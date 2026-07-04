# PaintNode Release Notes

PaintNode uses GitHub Releases as the Tauri updater backend.

## Required Repository Secrets

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting the `.p12`
- `APPLE_SIGNING_IDENTITY`: `Developer ID Application: WHITE CORNERSTONE PTY LTD (6C9KQA6Z7A)`
- `APPLE_API_ISSUER`: App Store Connect issuer UUID
- `APPLE_API_KEY`: App Store Connect key ID
- `APPLE_API_KEY_P8`: full contents of the downloaded `AuthKey_*.p8`
- `TAURI_SIGNING_PRIVATE_KEY`: full contents of the Tauri updater private key
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password for the Tauri updater private key

## Release Flow

1. Update versions in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
2. Add release notes at `docs/release-notes/<version>.md`.
3. Commit the release.
4. Push a tag such as `paintnode-v0.1.1`.
5. GitHub Actions publishes `PaintNode v0.1.1` with app bundles, updater artifacts, and `latest.json`.

The release notes file becomes both the GitHub release body and the notes shown in
the in-app updater dialog. The workflow fails if the file is missing so placeholder
text does not ship to users.

The app checks:

```text
https://github.com/white-cornerstone/paintnode/releases/latest/download/latest.json
```
