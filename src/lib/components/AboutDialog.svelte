<script lang="ts">
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
  import { PaintBrush } from '../icons';

  let { onClose }: { onClose: () => void } = $props();
</script>

<Modal title="About PaintNode" {onClose} width={420}>
  <div class="about">
    <h2><Icon svg={PaintBrush} size={18} /> PaintNode</h2>
    <p>A server-free, professional raster image editor.</p>
    <p>
      Documents use the open <strong>OpenRaster (.ora)</strong> format, so your layered files stay portable
      across Krita, GIMP, MyPaint and other ORA-capable apps.
    </p>
    <p>
      Core editing, file I/O, and export run on your device. Optional integrations can search Openverse
      online for open-license images or pass selected project data to your configured local AI CLI provider.
    </p>
    <ul>
      <li>Layers with blend modes &amp; opacity</li>
      <li>Brush, eraser, bucket fill, eyedropper, move</li>
      <li>Pan / zoom, non-destructive undo / redo</li>
      <li>Open &amp; save .ora, export PNG</li>
      <li>Openverse image search and local AI CLI workflows</li>
    </ul>
    <p class="tech">Built with Svelte 5 · TypeScript · Canvas2D · fflate — no PaintNode-hosted backend.</p>
    <div class="actions"><button class="primary" onclick={onClose}>Close</button></div>
  </div>
</Modal>

<style>
  .about h2 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    color: var(--accent);
  }
  .about p {
    margin: 0 0 10px;
    line-height: 1.5;
  }
  .about ul {
    margin: 0 0 10px;
    padding-left: 18px;
    line-height: 1.6;
    color: var(--text);
  }
  .tech {
    color: var(--text-dim);
    font-size: 11px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 6px;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
