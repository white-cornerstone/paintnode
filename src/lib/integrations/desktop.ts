import { invoke } from '@tauri-apps/api/core';

/** True when running inside the Tauri desktop shell (vs. a plain browser tab). */
export function isDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window ||
      '__TAURI__' in window ||
      (window as unknown as { isTauri?: boolean }).isTauri === true)
  );
}

export interface GeneratorConfig {
  /** The local binary to run, e.g. "codex" or an absolute path. */
  bin: string;
  /** Argument template; "{prompt}" and "{output}" are substituted by the Rust bridge. */
  args: string[];
}

/**
 * Run the configured local image-generator via the Tauri Rust bridge and return a PNG data URL.
 * Only works in the desktop app; throws in the browser.
 */
export async function generateImage(config: GeneratorConfig, prompt: string): Promise<string> {
  if (!isDesktop()) {
    throw new Error('Image generation is only available in the desktop app.');
  }
  return invoke<string>('generate_image', { bin: config.bin, args: config.args, prompt });
}
