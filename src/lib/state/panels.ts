export const PANELS_STORAGE_KEY = 'paintnode.panels';

/** Which panels live in which right-dock group. Single source of truth for panel/group ids. */
export const PANEL_GROUP_PANELS = {
  presets: ['color', 'swatches', 'gradients', 'patterns'],
  edits: ['properties', 'adjustments', 'libraries'],
  type: ['character', 'paragraph'],
  structure: ['layers', 'channels', 'paths'],
} as const;

export type PanelGroupId = keyof typeof PANEL_GROUP_PANELS;
export type PanelId = (typeof PANEL_GROUP_PANELS)[PanelGroupId][number];

export const PANEL_GROUP_IDS = Object.keys(PANEL_GROUP_PANELS) as PanelGroupId[];

export interface PanelLayout {
  rightCollapsed: boolean;
  projectCollapsed: boolean;
  activePanelByGroup: Record<PanelGroupId, PanelId>;
  collapsedGroups: Record<PanelGroupId, boolean>;
}

export function defaultPanelLayout(): PanelLayout {
  return {
    rightCollapsed: false,
    projectCollapsed: false,
    activePanelByGroup: {
      presets: 'color',
      edits: 'properties',
      type: 'character',
      structure: 'layers',
    },
    collapsedGroups: {
      presets: false,
      edits: false,
      type: false,
      structure: false,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizePanelLayout(raw: unknown): PanelLayout {
  const defaults = defaultPanelLayout();
  if (!isRecord(raw)) return defaults;

  const activeRaw = isRecord(raw.activePanelByGroup) ? raw.activePanelByGroup : {};
  const collapsedRaw = isRecord(raw.collapsedGroups) ? raw.collapsedGroups : {};
  const activePanelByGroup = { ...defaults.activePanelByGroup };
  const collapsedGroups = { ...defaults.collapsedGroups };
  for (const groupId of PANEL_GROUP_IDS) {
    const panels: readonly string[] = PANEL_GROUP_PANELS[groupId];
    const active = activeRaw[groupId];
    if (typeof active === 'string' && panels.includes(active)) {
      activePanelByGroup[groupId] = active as PanelId;
    }
    collapsedGroups[groupId] = booleanOrDefault(collapsedRaw[groupId], defaults.collapsedGroups[groupId]);
  }

  return {
    rightCollapsed: booleanOrDefault(raw.rightCollapsed, defaults.rightCollapsed),
    projectCollapsed: booleanOrDefault(raw.projectCollapsed, defaults.projectCollapsed),
    activePanelByGroup,
    collapsedGroups,
  };
}

export function parsePanelLayoutJson(json: string | null): PanelLayout {
  try {
    return normalizePanelLayout(JSON.parse(json || 'null'));
  } catch {
    return defaultPanelLayout();
  }
}
