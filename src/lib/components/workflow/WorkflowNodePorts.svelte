<script lang="ts">
  import { tooltip } from '../../actions/tooltip';

  let {
    title,
    onStart,
    onFinish,
    showInput = true,
    showOutput = true,
    inputLabel = 'Input',
    outputLabel = 'Output',
  }: {
    title: string;
    onStart: (event: PointerEvent) => void;
    onFinish: (event: PointerEvent) => void;
    showInput?: boolean;
    showOutput?: boolean;
    inputLabel?: string;
    outputLabel?: string;
  } = $props();
</script>

{#if showInput}
  <button
    class="node-port input"
    aria-label={`${inputLabel} for ${title}`}
    use:tooltip={{ text: inputLabel, placement: 'left' }}
    onpointerdown={(event) => event.stopPropagation()}
    onpointerup={onFinish}
  ></button>
{/if}
{#if showOutput}
  <button
    class="node-port output"
    aria-label={`${outputLabel} from ${title}`}
    use:tooltip={{ text: outputLabel, placement: 'right' }}
    onpointerdown={onStart}
  ></button>
{/if}

<style>
  .node-port {
    position: absolute;
    top: var(--port-y, 50%);
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
