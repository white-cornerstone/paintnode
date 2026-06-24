<script lang="ts">
  import ColorPicker from './ColorPicker.svelte';
  import { editor } from '../state/editor.svelte';
  import Icon from './Icon.svelte';
  import Panel from './Panel.svelte';
  import { tooltip } from '../actions/tooltip';
  import { ArrowSwap } from '../icons';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();
</script>

<Panel title="Color" bind:collapsed {onToggle}>
  <div class="content">
    <div class="row">
      <div class="swatches">
        <button
          class="big fg"
          style="background:{editor.foregroundCss}"
          use:tooltip={{ text: 'Foreground color', placement: 'left' }}
          aria-label="Foreground"
        ></button>
        <button
          class="big bg"
          style="background:{editor.backgroundCss}"
          use:tooltip={{ text: 'Background color (click to swap)', placement: 'left' }}
          aria-label="Background"
          onclick={() => editor.swapColors()}
        ></button>
      </div>
      <div class="ctl">
        <button
          use:tooltip={{ text: 'Swap foreground/background (X)', placement: 'left' }}
          onclick={() => editor.swapColors()}
        >
          <Icon svg={ArrowSwap} size={13} /> Swap
        </button>
        <button
          use:tooltip={{ text: 'Reset to black/white (D)', placement: 'left' }}
          onclick={() => editor.resetColors()}>Reset</button
        >
      </div>
    </div>
    <ColorPicker />
  </div>
</Panel>

<style>
  .content {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .swatches {
    position: relative;
    width: 52px;
    height: 44px;
    flex: none;
  }
  .big {
    position: absolute;
    width: 32px;
    height: 32px;
    border: 1px solid #000;
    border-radius: 3px;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18);
    padding: 0;
  }
  .fg {
    left: 0;
    top: 0;
    z-index: 2;
  }
  .bg {
    right: 0;
    bottom: 0;
    z-index: 1;
  }
  .ctl {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ctl button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 3px 8px;
    font-size: 11px;
  }
</style>
