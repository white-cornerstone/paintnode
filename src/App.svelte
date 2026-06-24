<script lang="ts">
  import { onMount } from 'svelte';
  import MenuBar from './lib/components/MenuBar.svelte';
  import Toolbar from './lib/components/Toolbar.svelte';
  import ToolOptions from './lib/components/ToolOptions.svelte';
  import CanvasView from './lib/components/CanvasView.svelte';
  import LayersPanel from './lib/components/LayersPanel.svelte';
  import ColorPanel from './lib/components/ColorPanel.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import NewDocumentDialog from './lib/components/NewDocumentDialog.svelte';
  import AboutDialog from './lib/components/AboutDialog.svelte';
  import ImageSizeDialog from './lib/components/ImageSizeDialog.svelte';
  import BrightnessContrastDialog from './lib/components/BrightnessContrastDialog.svelte';
  import HueSaturationDialog from './lib/components/HueSaturationDialog.svelte';
  import GaussianBlurDialog from './lib/components/GaussianBlurDialog.svelte';
  import TextDialog from './lib/components/TextDialog.svelte';
  import AiGenerateDialog from './lib/components/AiGenerateDialog.svelte';
  import Icon from './lib/components/Icon.svelte';
  import { tooltip } from './lib/actions/tooltip';
  import { ChevronDoubleLeft, ChevronDoubleRight, ColorPalette, Layers } from './lib/icons';
  import { installKeyboard } from './lib/state/keyboard';
  import { editor } from './lib/state/editor.svelte';
  import { ui } from './lib/state/ui.svelte';

  let rightCollapsed = $state(false);

  onMount(() => installKeyboard());
</script>

<div class="app">
  <MenuBar />
  <div class="middle">
    <Toolbar />
    <section class="center">
      <ToolOptions />
      <CanvasView />
    </section>
    <aside class="right" class:collapsed={rightCollapsed}>
      {#if rightCollapsed}
        <div class="dock-rail">
          <button
            class="panel-toggle expand"
            onclick={() => (rightCollapsed = false)}
            use:tooltip={{ text: 'Expand panels', placement: 'left' }}
            aria-label="Expand panels"
          ><Icon svg={ChevronDoubleLeft} size={16} /></button>
          <button class="rail-item" onclick={() => (rightCollapsed = false)} aria-label="Color">
            <Icon svg={ColorPalette} size={18} /><span>Color</span>
          </button>
          <button class="rail-item" onclick={() => (rightCollapsed = false)} aria-label="Layers">
            <Icon svg={Layers} size={18} /><span>Layers</span>
          </button>
        </div>
      {:else}
        <div class="right-bar">
          <button
            class="panel-toggle"
            onclick={() => (rightCollapsed = true)}
            use:tooltip={{ text: 'Collapse panels', placement: 'left' }}
            aria-label="Collapse panels"
          ><Icon svg={ChevronDoubleRight} size={16} /></button>
        </div>
        <ColorPanel />
        <LayersPanel />
      {/if}
    </aside>
  </div>
  <StatusBar />
</div>

{#if ui.dialog === 'new'}
  <NewDocumentDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'about'}
  <AboutDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'imageSize'}
  <ImageSizeDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'brightnessContrast'}
  <BrightnessContrastDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'hueSaturation'}
  <HueSaturationDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'gaussianBlur'}
  <GaussianBlurDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'aiGenerate'}
  <AiGenerateDialog onClose={() => ui.close()} />
{/if}

{#if editor.pendingText}
  <TextDialog onClose={() => (editor.pendingText = null)} />
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  .middle {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .right {
    width: var(--rightpanel-w);
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    min-height: 0;
  }
  .right.collapsed {
    width: 108px;
  }
  .right-bar {
    height: 26px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 6px;
    background: var(--bg-panel-2);
    border-bottom: 1px solid var(--border);
  }
  .panel-toggle {
    display: grid;
    place-items: center;
    width: 22px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--text-dim);
  }
  .panel-toggle:hover {
    color: var(--text-bright);
  }
  /* Edge-collapsed dock: keep panel labels (Photoshop icon+label rail) */
  .dock-rail {
    display: flex;
    flex-direction: column;
  }
  .dock-rail .panel-toggle.expand {
    align-self: flex-end;
    margin: 4px 5px 4px 0;
  }
  .rail-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .rail-item:hover {
    background: var(--bg-elevated);
  }
</style>
