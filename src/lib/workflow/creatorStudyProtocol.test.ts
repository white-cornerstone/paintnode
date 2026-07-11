import { describe, expect, it } from 'vitest';
import protocol from '../../../docs/testing/creative-blueprint-creator-study.md?raw';

describe('Creative Blueprint creator study protocol', () => {
  it('reads access, de-identification, retention, and exceptions aloud before recording opt-in', () => {
    const consent = (/Read this before recording or screen sharing:\n\n([\s\S]*?)\n\nRecording is off by default\./
      .exec(protocol)?.[1] ?? '').replace(/^> ?/gm, '').replace(/\s+/g, ' ');

    expect(consent).toContain('Only the study owner and the named study observers may');
    expect(consent).toContain('We de-identify research notes');
    expect(consent).toContain('30 calendar days after the milestone decision');
    expect(consent).toContain('approved exception');
    expect(consent).toContain('before you choose');
    expect(consent).toContain('Do you separately consent to');
  });

  it('requires a recorded visible format checkpoint reset before Retry', () => {
    const setup = (/### Task 7 — Recover one format\n\n([\s\S]*?)\n\nPrompt:/
      .exec(protocol)?.[1] ?? '').replace(/\s+/g, ' ');

    expect(setup).toContain('Select `Format recovery checkpoint` and record the setup');
    expect(setup).toContain('regardless of its historical attempt number');
    expect(setup).toContain('visibly select');
    expect(setup).toContain('before the participant chooses');
    expect(setup).toContain('Retry succeeds because the visible scenario changed to Standard');
    expect(setup).toContain('not because of hidden attempt state');
  });
});
