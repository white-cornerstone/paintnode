import { defineConfig } from 'vitest/config';

// Unit tests run in a plain Node environment. We deliberately test the framework-agnostic
// engine logic (text model, color math, text layout) that has no DOM/canvas dependency —
// the renderer takes an injectable measure/draw surface so its math is testable with a fake.
// DOM/canvas- and component-level tests would need a browser environment (a future addition).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
