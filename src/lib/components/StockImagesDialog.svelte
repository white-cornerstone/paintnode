<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { ChevronDown, Delete, Eye, Info, Search } from '../icons';
  import { placeImageBlob } from '../state/commands';
  import { editor } from '../state/editor.svelte';
  import {
    fetchOpenverseImageBlob,
    openverseImageLabel,
    openverseLicenseLabel,
    searchOpenverseImages,
    type OpenverseImage,
    type OpenverseLicense,
    type OpenverseOrientation,
  } from '../integrations/openverse';

  interface CategoryRow {
    title: string;
    query: string;
    images: OpenverseImage[];
    loading: boolean;
    error: string;
  }

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  const categories = [
    { title: 'Nature', query: 'nature landscape' },
    { title: 'Architecture', query: 'architecture' },
    { title: 'Textures', query: 'texture background' },
  ];

  let query = $state('');
  let orientation = $state<OpenverseOrientation>('any');
  let license = $state<OpenverseLicense>('all');
  let rows = $state<CategoryRow[]>(categories.map((item) => ({ ...item, images: [], loading: false, error: '' })));
  let results = $state<OpenverseImage[]>([]);
  let resultTotal = $state(0);
  let resultPage = $state(1);
  let searchActive = $state(false);
  let loadingSearch = $state(false);
  let loadingMore = $state(false);
  let error = $state('');
  let selected = $state<OpenverseImage[]>([]);
  let selectionDrawerOpen = $state(false);
  let infoOpen = $state(false);
  let adding = $state(false);

  const selectedIds = $derived(new Set(selected.map((image) => image.id)));
  const canAdd = $derived(selected.length > 0 && !adding);

  function closeInfoOnOutsidePointer(event: PointerEvent): void {
    if (!infoOpen) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.intro-help')) return;
    infoOpen = false;
  }

  $effect(() => {
    if (!infoOpen) return;
    document.addEventListener('pointerdown', closeInfoOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeInfoOnOutsidePointer, true);
  });

  onMount(() => {
    void loadRows();
  });

  async function loadRows(): Promise<void> {
    rows = rows.map((row) => ({ ...row, loading: true, error: '' }));
    await Promise.all(
      rows.map(async (row, index) => {
        try {
          const result = await searchOpenverseImages(row.query, { pageSize: 8, orientation, license });
          rows = rows.map((item, i) =>
            i === index ? { ...item, images: result.images, loading: false, error: '' } : item,
          );
        } catch (e) {
          rows = rows.map((item, i) =>
            i === index
              ? { ...item, images: [], loading: false, error: (e as Error).message }
              : item,
          );
        }
      }),
    );
  }

  async function runSearch(nextQuery = query, page = 1, append = false): Promise<void> {
    const trimmed = nextQuery.trim();
    if (!trimmed) {
      searchActive = false;
      results = [];
      resultTotal = 0;
      resultPage = 1;
      error = '';
      loadingMore = false;
      return;
    }
    query = trimmed;
    searchActive = true;
    if (append) loadingMore = true;
    else {
      resultPage = page;
      loadingSearch = true;
      results = [];
    }
    error = '';
    try {
      const result = await searchOpenverseImages(trimmed, { page, pageSize: 20, orientation, license });
      results = append ? appendUniqueImages(results, result.images) : result.images;
      resultTotal = result.total;
      resultPage = page;
    } catch (e) {
      if (!append) results = [];
      resultTotal = 0;
      error = (e as Error).message;
    } finally {
      loadingSearch = false;
      loadingMore = false;
    }
  }

  function appendUniqueImages(current: OpenverseImage[], next: OpenverseImage[]): OpenverseImage[] {
    const ids = new Set(current.map((image) => image.id));
    return [...current, ...next.filter((image) => !ids.has(image.id))];
  }

  function viewAll(row: CategoryRow): void {
    void runSearch(row.query, 1);
  }

  function toggle(image: OpenverseImage): void {
    selected = selectedIds.has(image.id)
      ? selected.filter((item) => item.id !== image.id)
      : [...selected, image];
  }

  function removeSelected(image: OpenverseImage): void {
    selected = selected.filter((item) => item.id !== image.id);
    if (selected.length === 0) selectionDrawerOpen = false;
  }

  function loadMore(): void {
    if (loadingMore || loadingSearch || results.length >= resultTotal) return;
    void runSearch(query, resultPage + 1, true);
  }

  async function addSelected(): Promise<void> {
    if (!canAdd) return;
    adding = true;
    try {
      for (const image of selected) {
        const fetched = await fetchOpenverseImageBlob(image);
        await placeImageBlob(fetched.blob, `openverse-${image.id}.jpg`, {
          path: image.landingUrl,
          attribution: `${image.provider} / ${image.creator ?? 'Unknown creator'} / ${openverseLicenseLabel(image)}`,
        });
        if (fetched.source === 'thumbnail') {
          editor.flash(`Placed ${image.title} preview; full-size source blocked browser download`);
        }
      }
      onClose();
    } catch (e) {
      editor.flash('Add open-license image failed: ' + (e as Error).message);
    } finally {
      adding = false;
    }
  }

  function onSearchSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void runSearch(query, 1);
  }

  function onOrientationChange(event: Event): void {
    orientation = event.currentTarget instanceof HTMLSelectElement
      ? (event.currentTarget.value as OpenverseOrientation)
      : 'any';
    if (searchActive) void runSearch(query, 1);
    else void loadRows();
  }

  function onLicenseChange(event: Event): void {
    license = event.currentTarget instanceof HTMLSelectElement
      ? (event.currentTarget.value as OpenverseLicense)
      : 'all';
    if (searchActive) void runSearch(query, 1);
    else void loadRows();
  }
</script>

<Modal title="Add Open-License Images" {onClose} width={1120}>
  <div class="stock-dialog">
    <header class="intro">
      <div class="intro-title">
        <h2>Start with open-license images from Openverse</h2>
        <div class="intro-help">
          <button
            class="info-button"
            aria-label="About open-license images"
            aria-expanded={infoOpen}
            use:tooltip={{ text: 'About open-license images', placement: 'bottom' }}
            onclick={() => (infoOpen = !infoOpen)}
          >
            <Icon svg={Info} size={16} />
          </button>
          {#if infoOpen}
            <p class="info-popover" role="status">
              Browse Creative Commons and public-domain media. Verify the source license before
              publishing, then add selected images as regular PaintNode layers.
            </p>
          {/if}
        </div>
      </div>
      <form class="search" onsubmit={onSearchSubmit}>
        <label class="search-box">
          <Icon svg={Search} size={18} />
          <input bind:value={query} placeholder="Search open-license images" />
        </label>
        <label class="filter">
          <span>Orientation</span>
          <span class="select-wrap">
            <select value={orientation} onchange={onOrientationChange}>
              <option value="any">Any</option>
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait</option>
              <option value="square">Square</option>
            </select>
            <span class="select-arrow"><Icon svg={ChevronDown} size={15} /></span>
          </span>
        </label>
        <label class="filter">
          <span>License</span>
          <span class="select-wrap">
            <select value={license} onchange={onLicenseChange}>
              <option value="all">Any</option>
              <option value="commercial">Commercial use</option>
              <option value="modification">Can modify</option>
            </select>
            <span class="select-arrow"><Icon svg={ChevronDown} size={15} /></span>
          </span>
        </label>
        <button type="submit">Search</button>
      </form>
    </header>

    <div class="content-shell" class:with-drawer={selectionDrawerOpen}>
      <div class="browser">
        {#if searchActive}
          <section class="search-results" aria-label="Search results">
            <div class="section-head">
              <h3>{loadingSearch ? 'Searching...' : `${resultTotal} results for "${query}"`}</h3>
              <button onclick={() => runSearch('', 1)}>Browse categories</button>
            </div>
            {#if error}
              <p class="error">{error}</p>
            {:else if loadingSearch}
              <div class="grid skeleton" aria-label="Loading search results">
                {#each Array(12) as _}
                  <div></div>
                {/each}
              </div>
            {:else}
              <div class="grid">
                {#each results as image (image.id)}
                  {@render imageTile(image)}
                {/each}
              </div>
              {#if results.length === 0}
                <p class="empty">No images found.</p>
              {/if}
              {#if resultTotal > results.length}
                <div class="load-more">
                  <button disabled={loadingMore} onclick={loadMore}>
                    {loadingMore ? 'Loading...' : `Load more images (${results.length}/${resultTotal})`}
                  </button>
                </div>
              {/if}
            {/if}
          </section>
        {:else}
          {#each rows as row (row.title)}
            <section class="category" aria-label={row.title}>
              <div class="section-head">
                <h3>{row.title}</h3>
                <button onclick={() => viewAll(row)}>View all</button>
              </div>
              {#if row.error}
                <p class="error">{row.error}</p>
              {:else if row.loading}
                <div class="row skeleton" aria-label={`Loading ${row.title}`}>
                  {#each Array(5) as _}
                    <div></div>
                  {/each}
                </div>
              {:else}
                <div class="row">
                  {#each row.images as image (image.id)}
                    {@render imageTile(image)}
                  {/each}
                </div>
              {/if}
            </section>
          {/each}
        {/if}
      </div>

      {#if selectionDrawerOpen}
        <aside class="selection-drawer" aria-label="Selected images">
          <div class="drawer-head">
            <h3>Selected</h3>
            <button
              class="icon-button"
              aria-label="Hide selected images"
              use:tooltip={{ text: 'Hide selected images', placement: 'left' }}
              onclick={() => (selectionDrawerOpen = false)}
            >
              <Icon svg={Eye} size={15} />
            </button>
          </div>
          {#if selected.length === 0}
            <p class="empty compact">No selected images.</p>
          {:else}
            <div class="selected-list">
              {#each selected as image (image.id)}
                <article class="selected-item">
                  <img src={image.thumbnailUrl} alt={openverseImageLabel(image)} />
                  <div>
                    <strong>{image.title}</strong>
                    <span>{image.creator ?? image.provider}</span>
                    <span>{openverseLicenseLabel(image)}</span>
                  </div>
                  <button
                    class="icon-button remove"
                    aria-label={`Remove ${openverseImageLabel(image)}`}
                    use:tooltip={{ text: 'Remove from selection', placement: 'left' }}
                    onclick={() => removeSelected(image)}
                  >
                    <Icon svg={Delete} size={15} />
                  </button>
                </article>
              {/each}
            </div>
          {/if}
        </aside>
      {/if}
    </div>

    <footer>
      <div class="selection">
        <div class="selection-count">
          <strong>{selected.length ? `${selected.length} selected` : 'Select images to add'}</strong>
          <button
            class="peek-button"
            disabled={selected.length === 0}
            aria-label="Show selected images"
            aria-expanded={selectionDrawerOpen}
            use:tooltip={{ text: 'Show selected images', placement: 'top' }}
            onclick={() => (selectionDrawerOpen = !selectionDrawerOpen)}
          >
            <Icon svg={Eye} size={15} />
          </button>
        </div>
        <a href="https://openverse.org/" target="_blank" rel="noreferrer">
          Explore Openverse and verify image licenses
        </a>
      </div>
      <div class="actions">
        <button onclick={onClose}>Close</button>
        <button class="primary" disabled={!canAdd} onclick={addSelected}>
          {adding ? 'Adding...' : 'Add'}
        </button>
      </div>
    </footer>
  </div>
</Modal>

{#snippet imageTile(image: OpenverseImage)}
  <article class="photo-card" class:selected={selectedIds.has(image.id)}>
    <button
      type="button"
      aria-label={`Select ${openverseImageLabel(image)}`}
      aria-pressed={selectedIds.has(image.id)}
      onclick={() => toggle(image)}
      use:tooltip={{ text: `${openverseImageLabel(image)} · ${openverseLicenseLabel(image)}`, placement: 'top' }}
    >
      <img src={image.thumbnailUrl} alt={openverseImageLabel(image)} loading="lazy" />
      <span class="check">{selectedIds.has(image.id) ? 'Selected' : 'Select'}</span>
    </button>
    <div class="credit">
      <a href={image.creatorUrl ?? image.landingUrl} target="_blank" rel="noreferrer">
        {image.creator ?? image.provider}
      </a>
      <a href={image.licenseUrl ?? image.landingUrl} target="_blank" rel="noreferrer">
        {openverseLicenseLabel(image)}
      </a>
    </div>
  </article>
{/snippet}

<style>
  .stock-dialog {
    --stock-tile-min: 160px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: min(650px, calc(100vh - 130px));
  }

  .intro {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 22px;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    color: var(--text-bright);
    font-size: 18px;
    font-weight: 650;
  }

  .intro-title {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 520px;
  }

  .intro-title h2 {
    max-width: 500px;
  }

  .intro-help {
    position: relative;
    flex: 0 0 auto;
  }

  .info-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 26px;
    padding: 0;
    border-radius: 4px;
  }

  .info-popover {
    position: absolute;
    top: calc(100% + 8px);
    left: 50%;
    z-index: 10;
    width: 360px;
    max-width: min(360px, 70vw);
    padding: 8px 10px;
    border: 1px solid var(--border-soft);
    border-radius: 3px;
    background: var(--bg-elevated);
    box-shadow: 0 10px 22px rgb(0 0 0 / 35%);
    color: var(--text);
    font-size: 12px;
    line-height: 1.35;
    transform: translateX(-50%);
  }

  h3 {
    color: var(--text-bright);
    font-size: 14px;
    font-weight: 650;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  .search-box,
  .filter {
    display: inline-flex;
    align-items: center;
    height: 32px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-dim);
  }

  .search-box {
    gap: 7px;
    width: 300px;
    padding: 0 9px;
  }

  .search-box input {
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--text);
    outline: none;
  }

  .filter {
    overflow: hidden;
  }

  .filter:focus-within {
    border-color: var(--border-strong);
    box-shadow: 0 0 0 1px rgb(255 255 255 / 8%);
  }

  .filter span {
    padding: 0 10px;
    font-size: 12px;
  }

  .select-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    align-self: stretch;
    border-radius: 0;
    box-shadow: inset 1px 0 0 var(--border-soft);
    background: rgb(255 255 255 / 5%);
  }

  .filter select {
    appearance: none;
    -webkit-appearance: none;
    height: auto;
    min-width: 116px;
    padding: 0 16px 0 10px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text);
    outline: none;
  }

  .select-arrow {
    position: absolute;
    right: 1px;
    pointer-events: none;
    color: var(--text-dim);
    line-height: 0;
  }

  .content-shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    flex: 1 1 auto;
    min-height: 0;
  }

  .content-shell.with-drawer {
    grid-template-columns: minmax(0, 1fr) 280px;
  }

  .browser {
    flex: 1 1 auto;
    min-height: 0;
    max-height: 500px;
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--border-soft);
    border-radius: 5px;
    background: rgb(255 255 255 / 4%);
  }

  .selection-drawer {
    min-height: 0;
    max-height: 500px;
    overflow: auto;
    padding: 10px;
    border-left: 1px solid var(--border-soft);
    background: rgb(255 255 255 / 3%);
  }

  .drawer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 26px;
    padding: 0;
  }

  .selected-list {
    display: grid;
    gap: 8px;
  }

  .selected-item {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr) 28px;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 6px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: rgb(0 0 0 / 12%);
  }

  .selected-item img {
    width: 64px;
    height: 48px;
    border-radius: 3px;
    object-fit: cover;
    background: #171717;
  }

  .selected-item div {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .selected-item strong,
  .selected-item span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selected-item strong {
    color: var(--text-bright);
    font-size: 12px;
  }

  .selected-item span {
    color: var(--text-dim);
    font-size: 11px;
  }

  .selected-item .remove {
    color: var(--text-dim);
  }

  .category + .category {
    margin-top: 16px;
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .section-head button {
    padding: 4px 8px;
    border: 0;
    background: transparent;
    color: var(--accent);
  }

  .row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--stock-tile-min), 1fr));
    gap: 10px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--stock-tile-min), 1fr));
    gap: 12px;
  }

  .photo-card {
    min-width: 0;
  }

  .photo-card button {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 4 / 3;
    padding: 0;
    overflow: hidden;
    border: 2px solid transparent;
    border-radius: 4px;
    background: #171717;
  }

  .photo-card.selected button {
    border-color: var(--accent);
  }

  .photo-card img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
  }

  .check {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 3px 7px;
    border-radius: 3px;
    background: rgb(0 0 0 / 68%);
    color: #fff;
    font-size: 11px;
    opacity: 0;
  }

  .photo-card:hover .check,
  .photo-card.selected .check {
    opacity: 1;
  }

  .credit {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 4px;
    min-width: 0;
  }

  .credit a {
    min-width: 0;
    overflow: hidden;
    color: var(--text-dim);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skeleton div {
    aspect-ratio: 4 / 3;
    border-radius: 4px;
    background: linear-gradient(90deg, rgb(255 255 255 / 6%), rgb(255 255 255 / 13%), rgb(255 255 255 / 6%));
  }

  .error,
  .empty {
    padding: 16px;
    color: var(--text-dim);
  }

  .load-more {
    display: flex;
    justify-content: center;
    margin-top: 12px;
  }

  .load-more button {
    min-width: 210px;
  }

  footer {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
  }

  .selection {
    display: grid;
    gap: 8px;
    color: var(--text);
  }

  .selection-count {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .peek-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 24px;
    padding: 0;
  }

  .selection a {
    color: var(--accent);
  }

  .actions {
    display: flex;
    gap: 10px;
  }

  .actions button {
    min-width: 112px;
  }

  .actions .primary {
    background: var(--accent);
    color: #fff;
  }

  @media (max-width: 900px) {
    .stock-dialog {
      --stock-tile-min: 150px;
    }

    .intro {
      display: grid;
    }

    .search {
      flex-wrap: wrap;
    }

    .search-box {
      width: min(100%, 360px);
    }

    .content-shell.with-drawer {
      grid-template-columns: minmax(0, 1fr);
    }

    .selection-drawer {
      max-height: 210px;
      border-left: 0;
      border-top: 1px solid var(--border-soft);
    }
  }
</style>
