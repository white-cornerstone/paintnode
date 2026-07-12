<script lang="ts">
  import type { WorkflowNodePreflight } from '../../workflow';

  let { entry }: { entry: Readonly<WorkflowNodePreflight> | null | undefined } = $props();
</script>

{#if entry}
  <div class="node-preflight {entry.state}" data-workflow-preflight-state={entry.state} role="status">
    <strong>{entry.state}</strong>
    <span>{entry.reason.message}</span>
  </div>
{/if}

<style>
  .node-preflight {
    display: grid;
    gap: 2px;
    padding: 5px 8px;
    border-bottom: 1px solid #4b4d52;
    background: color-mix(in srgb, var(--accent) 10%, #252629);
    color: var(--text-dim);
    font-size: 9px;
    line-height: 1.3;
  }
  .node-preflight strong {
    color: #a9d5ff;
    font-size: 9px;
    text-transform: uppercase;
  }
  .node-preflight.cached strong {
    color: #8fd4a6;
  }
  .node-preflight.blocked strong {
    color: #ffd38a;
  }
  .node-preflight.stale strong {
    color: #e5b5ff;
  }
</style>
