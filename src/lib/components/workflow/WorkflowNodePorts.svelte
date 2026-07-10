<script lang="ts">
  import { tooltip } from '../../actions/tooltip';
  import type { WorkflowNodePort } from '../../workflow';

  let {
    title,
    height,
    inputs,
    outputs,
    onStart,
    onFinish,
  }: {
    title: string;
    height: number;
    inputs: readonly WorkflowNodePort[];
    outputs: readonly WorkflowNodePort[];
    onStart: (event: PointerEvent, portId: string) => void;
    onFinish: (event: PointerEvent, portId: string) => void;
  } = $props();

  function portTop(index: number, count: number): string {
    return `${height * ((index + 1) / (count + 1))}px`;
  }
</script>

{#each inputs as port, index (port.id)}
  <button
    class="node-port input"
    style={`top:${portTop(index, inputs.length)}`}
    data-node-port-id={port.id}
    data-node-port-direction="input"
    aria-label={`${port.label} (${port.dataType}) for ${title}`}
    use:tooltip={{ text: `${port.label} · ${port.dataType}`, placement: 'left' }}
    onpointerdown={(event) => event.stopPropagation()}
    onpointerup={(event) => onFinish(event, port.id)}
  ></button>
{/each}
{#each outputs as port, index (port.id)}
  <button
    class="node-port output"
    style={`top:${portTop(index, outputs.length)}`}
    data-node-port-id={port.id}
    data-node-port-direction="output"
    aria-label={`${port.label} (${port.dataType}) from ${title}`}
    use:tooltip={{ text: `${port.label} · ${port.dataType}`, placement: 'right' }}
    onpointerdown={(event) => onStart(event, port.id)}
  ></button>
{/each}

<style>
  .node-port {
    position: absolute;
    z-index: 8;
    display: grid;
    place-items: center;
    width: 13px;
    height: 13px;
    padding: 0;
    border: 2px solid #a6aab2;
    border-radius: 50%;
    background: #202123;
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.36), 0 2px 8px rgba(0, 0, 0, 0.36);
    transform: translateY(-50%);
  }
  .input { left: -7px; cursor: default; }
  .output { right: -7px; cursor: crosshair; }
  .node-port:hover,
  .node-port:focus-visible {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 22%, #202123);
  }
</style>
