import { describe, expect, it } from 'vitest';
import domainSource from './domain.ts?raw';
import executionSource from './execution.ts?raw';
import transformExecutorSource from './transformExecutor.ts?raw';

describe('workflow domain dependency boundary', () => {
  it('does not import UI frameworks, platform APIs, or rendering concerns', () => {
    expect(domainSource).not.toMatch(/from\s+['"][^'"]*(?:svelte|tauri|canvas|components|state)[^'"]*['"]/i);
    expect(domainSource).not.toMatch(/\b(?:document|window|HTMLCanvasElement|CanvasRenderingContext2D)\b/);
  });

  it('keeps execution planning independent from UI, platform, Node, and provider adapters', () => {
    expect(executionSource).not.toMatch(/from\s+['"][^'"]*(?:svelte|tauri|components|state|node:crypto)[^'"]*['"]/i);
    expect(executionSource).not.toMatch(/\b(?:document|window|HTMLCanvasElement|Date\.now|crypto\.subtle)\b/);
  });

  it('keeps Transform execution independent from UI, platform, editor, and provider adapters', () => {
    expect(transformExecutorSource).not.toMatch(
      /from\s+['"][^'"]*(?:svelte|tauri|components|state|integrations|desktop|editor|codex|antigravity)[^'"]*['"]/i,
    );
    expect(transformExecutorSource).not.toMatch(
      /\b(?:document|window|HTMLCanvasElement|CanvasRenderingContext2D|fetch|invoke|openDialog)\b/,
    );
  });
});
