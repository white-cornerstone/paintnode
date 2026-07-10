import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Unit tests run in a plain Node environment. The Svelte plugin compiles rune-based store
// adapters for state tests, while framework-independent engine logic remains directly testable.
// DOM/canvas- and component-level tests still need a browser environment (a future addition).
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
