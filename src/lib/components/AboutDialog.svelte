<script lang="ts">
  import Modal from './Modal.svelte';
  import appIcon from '../../../src-tauri/icons/icon.png?url';
  import packageInfo from '../../../package.json';

  let { onClose }: { onClose: () => void } = $props();
</script>

<Modal title="About PaintNode" {onClose} width={460}>
  <div class="about">
    <section class="identity" aria-label="PaintNode">
      <img class="app-icon" src={appIcon} alt="" aria-hidden="true" />
      <h2>PaintNode</h2>
      <p class="version">Version {packageInfo.version}</p>
    </section>

    <section class="summary">
      <p>Use Codex CLI and Antigravity to generate and edit image layers.</p>
      <p>
        PaintNode keeps AI results in the editor as layers, masks, project assets, and OpenRaster documents
        instead of leaving you with loose output files.
      </p>
      <p>
        It uses your existing local CLI login and avoids a PaintNode-hosted model backend or extra API billing
        layer.
      </p>
    </section>

    <p class="tech">
      Built with Svelte 5 · TypeScript · Canvas2D · fflate
      <span>no PaintNode-hosted backend.</span>
    </p>
  </div>
</Modal>

<style>
  .about {
    padding: 26px 14px 10px;
  }
  .identity {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin-bottom: 24px;
  }
  .app-icon {
    width: 76px;
    height: 76px;
    display: block;
    flex: 0 0 auto;
    border-radius: 22.5%;
    overflow: hidden;
  }
  .identity h2 {
    margin: 4px 0 0;
    color: var(--text-bright);
    font-size: 22px;
    line-height: 1.1;
    font-weight: 700;
  }
  .version {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
  }
  .summary {
    max-width: 374px;
    margin: 0 auto;
  }
  .summary p {
    margin: 0 0 11px;
    line-height: 1.52;
    color: var(--text);
  }
  .tech {
    max-width: 374px;
    margin: 16px auto 0;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.45;
    text-align: center;
  }
  .tech span {
    display: block;
  }
</style>
