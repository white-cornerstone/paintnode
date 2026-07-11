import { describe, expect, it } from 'vitest';
import protocol from '../../../docs/testing/creative-blueprint-creator-study.md?raw';
import decisionTemplate from '../../../docs/testing/creator-study/templates/de-identified-study-decision.md?raw';
import privacyFields from '../../../docs/testing/creator-study/privacy-fields.json';
import materialManifest from '../../../docs/testing/creator-study/materials/manifest.json';

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

  it('makes real sessions and the private copy-outside-repository boundary non-negotiable', () => {
    expect(protocol).toMatch(/real sessions remain required/i);
    expect(protocol).toMatch(/Never complete private\s+templates inside the repository/);
    expect(protocol).toContain('npm run qa:creator-study:setup');
    expect(protocol).toContain('npm run qa:creator-study:synthesize');
    expect(protocol).toContain('Product A');
    expect(protocol).toContain('Product B');
  });

  it('protects both visible recovery interventions and the exact task order', () => {
    const branchSetup = (/### Task 2 — Create alternatives and recover one\n\n([\s\S]*?)\n\nPrompt:/
      .exec(protocol)?.[1] ?? '').replace(/\s+/g, ' ');
    expect(branchSetup).toContain('Branch recovery checkpoint');
    expect(branchSetup).toContain('select `Standard checkpoint`');

    const taskHeadings = [...protocol.matchAll(/### Task (\d) —/g)].map((match) => Number(match[1]));
    expect(taskHeadings).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('ships only blank, de-identified decision fields and an explicit privacy allow/deny contract', () => {
    expect(decisionTemplate).toContain('DE-IDENTIFIED REPOSITORY EVIDENCE ONLY');
    expect(decisionTemplate).not.toContain('Facilitators/observers:');
    expect(decisionTemplate).not.toContain('approved private storage reference');
    expect(privacyFields.repositoryAllowed).toContain('aggregate task metrics with counts and denominators');
    expect(privacyFields.privateOnly).toContain('participant code mapping to identity');
  });

  it('pins two non-confidential, differently hashed Product materials to Tasks 1 and 6', () => {
    expect(materialManifest.license).toBe('CC0-1.0');
    expect(materialManifest.materials.map((material) => material.task)).toEqual([1, 6]);
    expect(new Set(materialManifest.materials.map((material) => material.sha256)).size).toBe(2);
    expect(materialManifest.materials.every((material) => material.nonConfidential)).toBe(true);
  });
});
