import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Client-side SPA. Runs as a plain web app, or wrapped by Tauri for desktop/native access.
export default defineConfig({
  plugins: [svelte()],
  base: './',
  // Tauri prefers errors not be cleared from the terminal.
  clearScreen: false,
  server: {
    // Default 5173 for plain `npm run dev`; `npm run tauri:dev` injects a free port via
    // TAURI_DEV_PORT (see scripts/tauri-dev.mjs). strictPort makes the port deterministic so
    // it always matches Tauri's devUrl.
    port: Number(process.env.TAURI_DEV_PORT) || 5173,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    rolldownOptions: {
      output: {
        codeSplitting: true,
      },
    },
  },
});
