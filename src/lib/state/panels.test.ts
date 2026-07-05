import { describe, expect, it } from 'vitest';
import {
  clampTasksPanelHeight,
  defaultPanelLayout,
  normalizePanelLayout,
  parsePanelLayoutJson,
  TASKS_PANEL_DEFAULT_HEIGHT,
  TASKS_PANEL_MAX_HEIGHT,
  TASKS_PANEL_MIN_HEIGHT,
} from './panels';

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

  it('keeps a valid saved tasks panel height and clamps out-of-range values', () => {
    expect(defaultPanelLayout().tasksPanelHeight).toBe(TASKS_PANEL_DEFAULT_HEIGHT);
    expect(normalizePanelLayout({ tasksPanelHeight: 320 }).tasksPanelHeight).toBe(320);
    expect(normalizePanelLayout({ tasksPanelHeight: 4 }).tasksPanelHeight).toBe(TASKS_PANEL_MIN_HEIGHT);
    expect(normalizePanelLayout({ tasksPanelHeight: 5000 }).tasksPanelHeight).toBe(TASKS_PANEL_MAX_HEIGHT);
    expect(normalizePanelLayout({ tasksPanelHeight: 'tall' }).tasksPanelHeight).toBe(TASKS_PANEL_DEFAULT_HEIGHT);
  });

  it('clamps live drag heights against the space available in the sidebar', () => {
    expect(clampTasksPanelHeight(500, 360)).toBe(360);
    expect(clampTasksPanelHeight(10, 360)).toBe(TASKS_PANEL_MIN_HEIGHT);
    expect(clampTasksPanelHeight(200.6, 360)).toBe(201);
    // A cramped sidebar never pushes the clamp below the minimum height.
    expect(clampTasksPanelHeight(500, 40)).toBe(TASKS_PANEL_MIN_HEIGHT);
    expect(clampTasksPanelHeight(Number.NaN)).toBe(TASKS_PANEL_DEFAULT_HEIGHT);
  });
});
