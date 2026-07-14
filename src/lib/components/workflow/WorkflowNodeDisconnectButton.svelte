<script lang="ts">
  import { tooltip } from '../../actions/tooltip';
  import { LinkDismiss } from '../../icons';
  import Icon from '../Icon.svelte';

  let {
    count,
    nodeName,
    onDisconnect,
  }: {
    count: number;
    nodeName: string;
    onDisconnect: () => void;
  } = $props();
</script>

{#if count > 0}
  <button
    type="button"
    aria-label={`Disconnect links for ${nodeName}`}
    use:tooltip={{ text: count === 1 ? 'Disconnect link' : 'Choose links to disconnect', placement: 'top' }}
    onpointerdown={(event) => event.stopPropagation()}
    onclick={(event) => {
      event.stopPropagation();
      onDisconnect();
    }}
  ><Icon svg={LinkDismiss} size={13} /></button>
{/if}

<style>
  button {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
  }
</style>
