<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';

  let { onClose }: { onClose: () => void } = $props();

  const ratio = (editor.doc?.width ?? 1) / (editor.doc?.height ?? 1);
  let w = $state(editor.doc?.width ?? 1280);
  let h = $state(editor.doc?.height ?? 800);
  let linked = $state(true);

  function onW(v: number) {
    w = v;
    if (linked) h = Math.max(1, Math.round(v / ratio));
  }
  function onH(v: number) {
    h = v;
    if (linked) w = Math.max(1, Math.round(v * ratio));
  }
  function apply() {
    editor.resizeImage(w, h);
    onClose();
  }
</script>

<Modal title="Image Size" {onClose} width={380}>
  <div class="dlg-form">
    <div class="dlg-row">
      <label class="dlg-field"><span>Width (px)</span>
        <input type="number" min="1" max="8192" value={w} oninput={(e) => onW(+e.currentTarget.value)} />
      </label>
      <label class="dlg-field"><span>Height (px)</span>
        <input type="number" min="1" max="8192" value={h} oninput={(e) => onH(+e.currentTarget.value)} />
      </label>
    </div>
    <label class="chk"><input type="checkbox" bind:checked={linked} /> Constrain proportions</label>
    <div class="dlg-actions">
      <button onclick={onClose}>Cancel</button>
      <button class="dlg-primary" onclick={apply}>Resize</button>
    </div>
  </div>
</Modal>

<style>
  .chk {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
  }
</style>
