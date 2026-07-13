<script lang="ts">
  let {
    name,
    typeLabel,
    fallback = 'Untitled',
  }: {
    name: string;
    typeLabel: string;
    fallback?: string;
  } = $props();
</script>

<span class="title-display">
  <span class="name">{name || fallback}</span>
  <small>{typeLabel}</small>
</span>

<style>
  .title-display {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small {
    flex: none;
    margin-left: 7px;
    color: var(--text-dim);
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
  }
</style>
