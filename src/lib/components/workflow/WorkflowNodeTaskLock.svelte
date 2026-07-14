<script lang="ts">
  import Icon from '../Icon.svelte';
  import { ArrowSync, LockClosed } from '../../icons';

  let {
    x,
    y,
    width,
    taskCount,
    onOpen,
  }: {
    x: number;
    y: number;
    width: number;
    taskCount: number;
    onOpen: () => void;
  } = $props();

  const taskLabel = $derived(taskCount === 1 ? '1 AI task running' : `${taskCount} AI tasks running`);
</script>

{#if taskCount > 0}
  <button
    type="button"
    class="node-task-lock"
    style={`transform:translate(${x + Math.max(8, width - 154)}px, ${y + 40}px)`}
    aria-label={`${taskLabel}. Node is read-only. Open task details.`}
    onclick={(event) => {
      event.stopPropagation();
      onOpen();
    }}
  >
    <span class="running-icon"><Icon svg={ArrowSync} size={12} /></span>
    <span>{taskCount > 1 ? `${taskCount} AI tasks` : 'AI task'} · read-only</span>
    <Icon svg={LockClosed} size={12} />
  </button>
{/if}

<style>
  .node-task-lock {
    position: absolute;
    z-index: 8;
    display: flex;
    align-items: center;
    gap: 5px;
    width: 146px;
    min-width: 0;
    height: 25px;
    padding: 0 7px;
    color: #fff2cf;
    background: color-mix(in srgb, #b77717 78%, #292a2e);
    border: 1px solid #e0a74b;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 35%);
    font-size: 10px;
    font-weight: 650;
    white-space: nowrap;
  }
  .node-task-lock:hover {
    background: color-mix(in srgb, #ce861c 82%, #292a2e);
  }
  .node-task-lock > span:nth-child(2) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .running-icon {
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
    animation: task-spin 1.2s linear infinite;
  }
  @keyframes task-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .running-icon { animation: none; }
  }
</style>
