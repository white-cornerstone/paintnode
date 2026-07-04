import {
  defaultPanelLayout,
  PANELS_STORAGE_KEY,
  parsePanelLayoutJson,
  type PanelGroupId,
  type PanelId,
  type PanelLayout,
} from './panels';

function readStoredPanelLayout(): PanelLayout {
  if (typeof localStorage === 'undefined') return defaultPanelLayout();
  return parsePanelLayoutJson(localStorage.getItem(PANELS_STORAGE_KEY));
}

class PanelsStore {
  value = $state<PanelLayout>(readStoredPanelLayout());

  setRightCollapsed(collapsed: boolean): void {
    this.value.rightCollapsed = collapsed;
    this.persist();
  }

  setProjectCollapsed(collapsed: boolean): void {
    this.value.projectCollapsed = collapsed;
    this.persist();
  }

  setActivePanel(groupId: PanelGroupId, panelId: PanelId): void {
    this.value.activePanelByGroup[groupId] = panelId;
    this.persist();
  }

  setGroupCollapsed(groupId: PanelGroupId, collapsed: boolean): void {
    this.value.collapsedGroups[groupId] = collapsed;
    this.persist();
  }

  persist(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(this.value));
  }
}

export const panels = new PanelsStore();
