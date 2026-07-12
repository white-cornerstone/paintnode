export const PRODUCTION_RUNTIME_RELEASE_TAG = 'provider-runtimes-latest';
export const CREATIVE_BLUEPRINT_RUNTIME_RELEASE_TAG = 'provider-runtimes-creative-blueprint';

function manifestUrl(tag) {
  return `https://github.com/white-cornerstone/paintnode/releases/download/${tag}/runtime-manifest.json`;
}

export const PRODUCTION_RUNTIME_MANIFEST_URL = manifestUrl(PRODUCTION_RUNTIME_RELEASE_TAG);
export const CREATIVE_BLUEPRINT_RUNTIME_MANIFEST_URL = manifestUrl(CREATIVE_BLUEPRINT_RUNTIME_RELEASE_TAG);

export function runtimeManifestUrlForNativeQaMode(mode) {
  return mode === 'normal' ? CREATIVE_BLUEPRINT_RUNTIME_MANIFEST_URL : null;
}
