import { describe, expect, it } from 'vitest';
import { defaultPanelLayout, normalizePanelLayout, parsePanelLayoutJson } from './panels';

describe('panel layout normalization', () => {
  it('defaults to expanded columns and groups with the first panel of each group active', () => {
    const defaults = defaultPanelLayout();
    expect(defaults.rightCollapsed).toBe(false);
    expect(defaults.projectCollapsed).toBe(false);
    expect(defaults.activePanelByGroup).toEqual({
      presets: 'color',
      edits: 'properties',
      type: 'character',
      structure: 'layers',
    });
    expect(defaults.collapsedGroups).toEqual({
      presets: false,
      edits: false,
      type: false,
      structure: false,
    });
  });

  it('keeps a valid saved layout', () => {
    const normalized = normalizePanelLayout({
      rightCollapsed: true,
      projectCollapsed: true,
      activePanelByGroup: { presets: 'swatches', edits: 'adjustments', type: 'paragraph', structure: 'channels' },
      collapsedGroups: { presets: true, edits: false, type: true, structure: false },
    });

    expect(normalized.rightCollapsed).toBe(true);
    expect(normalized.projectCollapsed).toBe(true);
    expect(normalized.activePanelByGroup.presets).toBe('swatches');
    expect(normalized.activePanelByGroup.edits).toBe('adjustments');
    expect(normalized.activePanelByGroup.type).toBe('paragraph');
    expect(normalized.activePanelByGroup.structure).toBe('channels');
    expect(normalized.collapsedGroups.presets).toBe(true);
    expect(normalized.collapsedGroups.type).toBe(true);
  });

  it('falls back to the group default when the saved active panel is not in that group', () => {
    const normalized = normalizePanelLayout({
      activePanelByGroup: { presets: 'layers', structure: 'no-such-panel' },
    });

    expect(normalized.activePanelByGroup.presets).toBe('color');
    expect(normalized.activePanelByGroup.structure).toBe('layers');
  });

  it('ignores non-boolean collapse flags and unknown group ids', () => {
    const normalized = normalizePanelLayout({
      rightCollapsed: 'yes',
      collapsedGroups: { presets: 1, ghosts: true },
    });

    expect(normalized.rightCollapsed).toBe(false);
    expect(normalized.collapsedGroups.presets).toBe(false);
    expect('ghosts' in normalized.collapsedGroups).toBe(false);
  });

  it('returns defaults for missing or partial saved layouts', () => {
    const normalized = normalizePanelLayout({ projectCollapsed: true });
    expect(normalized.projectCollapsed).toBe(true);
    expect(normalized.rightCollapsed).toBe(false);
    expect(normalized.activePanelByGroup.edits).toBe('properties');
  });

  it('recovers from malformed or absent JSON', () => {
    expect(parsePanelLayoutJson('{not json').activePanelByGroup.presets).toBe('color');
    expect(parsePanelLayoutJson(null)).toEqual(defaultPanelLayout());
  });
});
