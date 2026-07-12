import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREATIVE_BLUEPRINT_RUNTIME_MANIFEST_URL,
  CREATIVE_BLUEPRINT_RUNTIME_RELEASE_TAG,
  PRODUCTION_RUNTIME_MANIFEST_URL,
  runtimeManifestUrlForNativeQaMode,
} from './provider-runtime-channel.mjs';

test('normal repo QA uses an isolated Creative Blueprint runtime channel', () => {
  assert.equal(CREATIVE_BLUEPRINT_RUNTIME_RELEASE_TAG, 'provider-runtimes-creative-blueprint');
  assert.match(CREATIVE_BLUEPRINT_RUNTIME_MANIFEST_URL, /provider-runtimes-creative-blueprint\/runtime-manifest\.json$/);
  assert.notEqual(CREATIVE_BLUEPRINT_RUNTIME_MANIFEST_URL, PRODUCTION_RUNTIME_MANIFEST_URL);
  assert.equal(runtimeManifestUrlForNativeQaMode('normal'), CREATIVE_BLUEPRINT_RUNTIME_MANIFEST_URL);
});

test('provider fixture modes do not inherit the Creative Blueprint runtime channel', () => {
  assert.equal(runtimeManifestUrlForNativeQaMode('provider-free'), null);
  assert.equal(runtimeManifestUrlForNativeQaMode('provider-e2e'), null);
});
