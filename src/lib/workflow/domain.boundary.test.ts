import { describe, expect, it } from 'vitest';
import domainSource from './domain.ts?raw';

describe('workflow domain dependency boundary', () => {
  it('does not import UI frameworks, platform APIs, or rendering concerns', () => {
    expect(domainSource).not.toMatch(/from\s+['"][^'"]*(?:svelte|tauri|canvas|components|state)[^'"]*['"]/i);
    expect(domainSource).not.toMatch(/\b(?:document|window|HTMLCanvasElement|CanvasRenderingContext2D)\b/);
  });
});
