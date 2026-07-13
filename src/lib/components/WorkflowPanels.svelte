<script lang="ts">
  import Icon from './Icon.svelte';
  import Panel from './Panel.svelte';
  import WorkflowMapPanel from './workflow/WorkflowMapPanel.svelte';
  import WorkflowPropertiesPanel from './workflow/WorkflowPropertiesPanel.svelte';
  import { tooltip } from '../actions/tooltip';
  import { Board, ChevronDoubleLeft, ChevronDoubleRight, Options } from '../icons';
  import { panels } from '../state/panels.svelte';
  import { workflow } from '../state/workflow.svelte';
  import type { WorkflowNodeV2 } from '../workflow/schema';

  type WorkflowPanelId = 'properties' | 'map';
  let peekedPanel = $state<WorkflowPanelId | null>(null);
  let propertiesCollapsed = $state(false);
  let mapCollapsed = $state(false);

  const propertiesNode = $derived.by((): WorkflowNodeV2 | null => {
    workflow.rev;
    const selection = workflow.selection;
    if (!selection) return null;
    const nodeId = selection.kind === 'composition'
      ? 'composition'
      : selection.kind === 'creator' || selection.kind === 'asset' || selection.kind === 'output'
        ? selection.id
        : null;
    return nodeId ? workflow.graphSnapshot().nodes.find((node) => node.id === nodeId) ?? null : null;
  });

  function collapseColumn(): void {
    peekedPanel = null;
    panels.setRightCollapsed(true);
  }

  function expandColumn(): void {
    peekedPanel = null;
    panels.setRightCollapsed(false);
  }

  function peekPanel(id: WorkflowPanelId): void {
    peekedPanel = peekedPanel === id ? null : id;
  }

  function requestDirectorAction(node: WorkflowNodeV2): void {
    window.dispatchEvent(new CustomEvent('paintnode:workflow-node-director-action', {
      detail: { nodeId: node.id },
    }));
  }
</script>

{#snippet panelContent(id: WorkflowPanelId)}
  {#if id === 'properties'}
    <WorkflowPropertiesPanel embedded node={propertiesNode} onDirectorAction={requestDirectorAction} />
  {:else}
    <WorkflowMapPanel />
  {/if}
{/snippet}

<aside class="workflow-side" class:collapsed={panels.value.rightCollapsed} aria-label="Workflow panels">
  {#if panels.value.rightCollapsed}
    <div class="dock-rail">
      <button
        class="panel-toggle expand"
        type="button"
        onclick={expandColumn}
        use:tooltip={{ text: 'Expand panels', placement: 'left' }}
        aria-label="Expand panels"
      ><Icon svg={ChevronDoubleLeft} size={16} /></button>
      <button
        type="button"
        class="rail-item"
        class:active={peekedPanel === 'properties'}
        onclick={() => peekPanel('properties')}
        aria-label="Properties"
        aria-pressed={peekedPanel === 'properties'}
      ><Icon svg={Options} size={18} /><span>Properties</span></button>
      <button
        type="button"
        class="rail-item"
        class:active={peekedPanel === 'map'}
        onclick={() => peekPanel('map')}
        aria-label="Map"
        aria-pressed={peekedPanel === 'map'}
      ><Icon svg={Board} size={18} /><span>Map</span></button>
    </div>
    {#if peekedPanel}
      <div class="peek-popover" class:map={peekedPanel === 'map'}>
        <div class="panel-tabs" role="tablist" aria-label="Workflow panel group">
          <button
            class="panel-tab"
            class:active={peekedPanel === 'properties'}
            role="tab"
            aria-selected={peekedPanel === 'properties'}
            onclick={() => (peekedPanel = 'properties')}
          >Properties</button>
          <button
            class="panel-tab"
            class:active={peekedPanel === 'map'}
            role="tab"
            aria-selected={peekedPanel === 'map'}
            onclick={() => (peekedPanel = 'map')}
          >Map</button>
          <button
            class="panel-close"
            type="button"
            onclick={() => (peekedPanel = null)}
            use:tooltip={{ text: 'Hide panel group', placement: 'left' }}
            aria-label="Hide panel group"
          ><Icon svg={ChevronDoubleRight} size={16} /></button>
        </div>
        <div class="peek-content">{@render panelContent(peekedPanel)}</div>
      </div>
    {/if}
  {:else}
    <div class="column-bar">
      <button
        class="panel-toggle"
        type="button"
        onclick={collapseColumn}
        use:tooltip={{ text: 'Collapse panels', placement: 'left' }}
        aria-label="Collapse panels"
      ><Icon svg={ChevronDoubleRight} size={16} /></button>
    </div>
    <Panel title="Properties" grow bind:collapsed={propertiesCollapsed}>
      {@render panelContent('properties')}
    </Panel>
    <Panel title="Map" bind:collapsed={mapCollapsed}>
      {@render panelContent('map')}
    </Panel>
  {/if}
</aside>

<style>
  .workflow-side {
    width: var(--rightpanel-w);
    flex: none;
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    border-left: 1px solid var(--border);
    background: var(--bg-panel);
  }
  .workflow-side.collapsed {
    width: 132px;
    overflow: visible;
    z-index: 20;
  }
  .column-bar {
    height: 26px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 6px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel-2);
  }
  .panel-toggle {
    display: grid;
    place-items: center;
    width: 22px;
    height: 20px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-dim);
  }
  .panel-toggle:hover { color: var(--text-bright); }
  .dock-rail { display: flex; flex-direction: column; }
  .dock-rail .panel-toggle.expand { align-self: flex-end; margin: 4px 5px 4px 0; }
  .rail-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
  }
  .rail-item:hover { background: var(--bg-elevated); }
  .rail-item.active { background: color-mix(in srgb, var(--bg-elevated) 72%, var(--accent) 28%); color: var(--text-bright); }
  .peek-popover {
    position: absolute;
    top: 0;
    right: 100%;
    width: var(--rightpanel-w);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    box-shadow: -8px 10px 22px rgba(0, 0, 0, 0.34);
  }
  .peek-popover.map { max-height: min(420px, 100%); }
  .panel-tabs {
    display: flex;
    flex: none;
    align-items: flex-end;
    min-height: 32px;
    overflow: hidden;
    padding-top: 2px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg-panel-2) 88%, #000 12%);
  }
  .panel-tab {
    position: relative;
    height: 30px;
    margin-bottom: -1px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-left: 0;
    border-radius: 0;
    background: color-mix(in srgb, var(--bg-panel-2) 86%, #000 14%);
    color: color-mix(in srgb, var(--text) 72%, #000 28%);
    font-size: 11px;
    font-weight: 700;
  }
  .panel-tab.active { height: 32px; background: var(--bg-panel); color: var(--text-bright); border-bottom-color: var(--bg-panel); }
  .panel-close {
    display: grid;
    flex: 0 0 26px;
    place-items: center;
    align-self: stretch;
    margin-left: auto;
    padding: 0;
    border: 0;
    border-left: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    color: var(--text-dim);
  }
  .panel-close:hover { color: var(--text-bright); background: var(--bg-elevated); }
  .peek-content { min-height: 0; display: flex; flex-direction: column; overflow: auto; }
  .workflow-side :global(.panel.grow) { flex: 1; }
  .workflow-side :global(.panel.grow .panel-body) { overflow: hidden; }
</style>
