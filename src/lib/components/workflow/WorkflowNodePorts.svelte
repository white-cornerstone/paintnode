<script lang="ts">
  import { tooltip } from '../../actions/tooltip';

  let {
    title,
    onStart,
    onFinish,
  }: {
    title: string;
    onStart: (event: PointerEvent) => void;
    onFinish: (event: PointerEvent) => void;
  } = $props();
</script>

<button
  class="node-port input"
  aria-label={`Input for ${title}`}
  use:tooltip={{ text: 'Input', placement: 'left' }}
  onpointerdown={(event) => event.stopPropagation()}
  onpointerup={onFinish}
></button>
<button
  class="node-port output"
  aria-label={`Output from ${title}`}
  use:tooltip={{ text: 'Output', placement: 'right' }}
  onpointerdown={onStart}
></button>

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
