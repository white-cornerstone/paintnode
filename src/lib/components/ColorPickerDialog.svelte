<script lang="ts">
  import { onMount } from 'svelte';
  import { untrack } from 'svelte';
  import type { RGB } from '../engine/types';
  import { clamp } from '../engine/types';
  import { hexToRgb, hsvToRgb, rgbToCss, rgbToHex, rgbToHsv } from '../engine/color';
  import { editor } from '../state/editor.svelte';
  import { tooltip } from '../actions/tooltip';

  type ColorComponent = 'h' | 's' | 'v' | 'r' | 'g' | 'blue' | 'l' | 'a' | 'labB';

  const FIELD_SIZE = 236;
  const SLIDER_WIDTH = 24;
  const SLIDER_HEIGHT = 236;
  const DIALOG_WIDTH = 580;

  let {
    target,
    initialColor,
    currentColor,
    onApply,
    onClose,
  }: {
    target: 'foreground' | 'background';
    initialColor: RGB;
    currentColor: RGB;
    onApply: (rgb: RGB) => void;
    onClose: () => void;
  } = $props();

  let h = $state(0);
  let s = $state(0);
  let v = $state(0);
  let draft = $state<RGB>({ r: 0, g: 0, b: 0 });
  let hexDraft = $state('000000');
  let activeComponent = $state<ColorComponent>('h');
  let webSafeOnly = $state(false);
  let sampling = $state(false);
  let dialogEl = $state<HTMLDivElement>();
  let fieldCanvas = $state<HTMLCanvasElement>();
  let sliderCanvas = $state<HTMLCanvasElement>();
  let initialized = false;
  let dialogX = $state(120);
  let dialogY = $state(160);
  let drag:
    | {
        startX: number;
        startY: number;
        dialogX: number;
        dialogY: number;
      }
    | null = null;

  const title = $derived(`Color Picker (${target === 'foreground' ? 'Foreground' : 'Background'} Color)`);
  const cmyk = $derived(rgbToCmyk(draft));
  const lab = $derived(rgbToLab(draft));
  const webSafeSuggestion = $derived(nearestWebSafe(draft));
  const isWebSafe = $derived(sameRgb(draft, webSafeSuggestion));
  const showWebSafeWarning = $derived(!webSafeOnly && !isWebSafe);
  const fieldPosition = $derived(getFieldPosition());
  const sliderPosition = $derived(getSliderPosition());

  $effect(() => {
    if (initialized) return;
    initialized = true;
    untrack(() => setDraft(initialColor));
  });

  onMount(() => {
    const w = Math.min(DIALOG_WIDTH, window.innerWidth - 32);
    dialogX = Math.max(16, Math.round((window.innerWidth - w) / 2));
    dialogY = Math.max(48, Math.round(window.innerHeight * 0.18));
  });

  $effect(() => {
    activeComponent;
    draft;
    h;
    s;
    v;
    lab;
    webSafeOnly;
    untrack(drawPickerCanvases);
  });

  function setDraft(rgb: RGB): void {
    const next = webSafeOnly ? nearestWebSafe(rgb) : rgb;
    draft = {
      r: clamp(Math.round(next.r), 0, 255),
      g: clamp(Math.round(next.g), 0, 255),
      b: clamp(Math.round(next.b), 0, 255),
    };
    hexDraft = rgbToHex(draft).slice(1);
    const hsv = rgbToHsv(draft);
    if (hsv.s > 0.001) h = hsv.h;
    s = hsv.s;
    v = hsv.v;
  }

  function setDraftFromHsv(next: { h: number; s: number; v: number }): void {
    h = normalizeHue(next.h);
    s = clamp(next.s, 0, 100);
    v = clamp(next.v, 0, 100);
    setDraft(hsvToRgb({ h, s, v }));
  }

  function setHsv(field: 'h' | 's' | 'v', value: number): void {
    if (!Number.isFinite(value)) return;
    setDraftFromHsv({
      h: field === 'h' ? value : h,
      s: field === 's' ? value : s,
      v: field === 'v' ? value : v,
    });
  }

  function setRgb(field: keyof RGB, value: number): void {
    if (!Number.isFinite(value)) return;
    setDraft({ ...draft, [field]: clamp(Math.round(value), 0, 255) });
  }

  function setLab(field: 'l' | 'a' | 'b', value: number): void {
    if (!Number.isFinite(value)) return;
    setDraft(
      labToRgb({
        l: field === 'l' ? clamp(value, 0, 100) : lab.l,
        a: field === 'a' ? clamp(value, -128, 127) : lab.a,
        b: field === 'b' ? clamp(value, -128, 127) : lab.b,
      }),
    );
  }

  function setHex(value: string): void {
    hexDraft = value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
    const rgb = hexToRgb(hexDraft);
    if (rgb) setDraft(rgb);
  }

  function setWebSafeOnly(checked: boolean): void {
    webSafeOnly = checked;
    if (checked) setDraft(webSafeSuggestion);
  }

  function selectWebSafeSuggestion(): void {
    setDraft(webSafeSuggestion);
  }

  function dragField(node: HTMLElement) {
    const onMove = (e: PointerEvent) => {
      const r = node.getBoundingClientRect();
      setFromField(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
    };
    const onUp = (e: PointerEvent) => {
      node.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    node.addEventListener('pointerdown', (e: PointerEvent) => {
      sampling = false;
      node.setPointerCapture(e.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      onMove(e);
    });
  }

  function dragSlider(node: HTMLElement) {
    const onMove = (e: PointerEvent) => {
      const r = node.getBoundingClientRect();
      setFromSlider(clamp((e.clientY - r.top) / r.height, 0, 1));
    };
    const onUp = (e: PointerEvent) => {
      node.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    node.addEventListener('pointerdown', (e: PointerEvent) => {
      sampling = false;
      node.setPointerCapture(e.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      onMove(e);
    });
  }

  function onWindowPointerDown(e: PointerEvent): void {
    if (dialogEl?.contains(e.target as Node)) return;
    const rgb = editor.sampleCompositeColorAtClient(e.clientX, e.clientY);
    if (!rgb) return;
    e.preventDefault();
    e.stopPropagation();
    setDraft(rgb);
  }

  function onWindowPointerMove(e: PointerEvent): void {
    const rect = dialogEl?.getBoundingClientRect();
    if (!rect) return;
    sampling = e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter') onApply(draft);
  }

  function startDialogDrag(clientX: number, clientY: number): void {
    drag = {
      startX: clientX,
      startY: clientY,
      dialogX,
      dialogY,
    };
  }

  function updateDialogDrag(clientX: number, clientY: number): void {
    if (!drag) return;
    const nextX = drag.dialogX + clientX - drag.startX;
    const nextY = drag.dialogY + clientY - drag.startY;
    const rect = dialogEl?.getBoundingClientRect();
    const width = rect?.width ?? DIALOG_WIDTH;
    const height = rect?.height ?? 430;
    dialogX = clamp(Math.round(nextX), 8, Math.max(8, window.innerWidth - width - 8));
    dialogY = clamp(Math.round(nextY), 8, Math.max(8, window.innerHeight - height - 8));
  }

  function clearDialogDrag(): void {
    drag = null;
  }

  function onDragPointerMove(e: PointerEvent): void {
    updateDialogDrag(e.clientX, e.clientY);
  }

  function onDragPointerUp(): void {
    window.removeEventListener('pointermove', onDragPointerMove);
    window.removeEventListener('pointerup', onDragPointerUp);
    clearDialogDrag();
  }

  function onDragMouseMove(e: MouseEvent): void {
    updateDialogDrag(e.clientX, e.clientY);
  }

  function onDragMouseUp(): void {
    window.removeEventListener('mousemove', onDragMouseMove);
    window.removeEventListener('mouseup', onDragMouseUp);
    clearDialogDrag();
  }

  function beginDialogPointerDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    startDialogDrag(e.clientX, e.clientY);
    window.addEventListener('pointermove', onDragPointerMove);
    window.addEventListener('pointerup', onDragPointerUp);
  }

  function beginDialogMouseDrag(e: MouseEvent): void {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    startDialogDrag(e.clientX, e.clientY);
    window.addEventListener('mousemove', onDragMouseMove);
    window.addEventListener('mouseup', onDragMouseUp);
  }

  function normalizeHue(value: number): number {
    return ((value % 360) + 360) % 360;
  }

  function sameRgb(a: RGB, b: RGB): boolean {
    return a.r === b.r && a.g === b.g && a.b === b.b;
  }

  function nearestWebSafe(rgb: RGB): RGB {
    const snap = (value: number) => clamp(Math.round(value / 51) * 51, 0, 255);
    return {
      r: snap(rgb.r),
      g: snap(rgb.g),
      b: snap(rgb.b),
    };
  }

  function setFromField(x: number, y: number): void {
    if (activeComponent === 'h') setDraftFromHsv({ h, s: x * 100, v: (1 - y) * 100 });
    else if (activeComponent === 's') setDraftFromHsv({ h: x * 360, s, v: (1 - y) * 100 });
    else if (activeComponent === 'v') setDraftFromHsv({ h: x * 360, s: (1 - y) * 100, v });
    else if (activeComponent === 'r') setDraft({ r: draft.r, g: x * 255, b: (1 - y) * 255 });
    else if (activeComponent === 'g') setDraft({ r: x * 255, g: draft.g, b: (1 - y) * 255 });
    else if (activeComponent === 'blue') setDraft({ r: x * 255, g: (1 - y) * 255, b: draft.b });
    else if (activeComponent === 'l') setDraft(labToRgb({ l: lab.l, a: x * 255 - 128, b: (1 - y) * 255 - 128 }));
    else if (activeComponent === 'a') setDraft(labToRgb({ l: x * 100, a: lab.a, b: (1 - y) * 255 - 128 }));
    else setDraft(labToRgb({ l: x * 100, a: (1 - y) * 255 - 128, b: lab.b }));
  }

  function setFromSlider(y: number): void {
    if (activeComponent === 'h') setHsv('h', y * 360);
    else if (activeComponent === 's') setHsv('s', (1 - y) * 100);
    else if (activeComponent === 'v') setHsv('v', (1 - y) * 100);
    else if (activeComponent === 'r') setRgb('r', (1 - y) * 255);
    else if (activeComponent === 'g') setRgb('g', (1 - y) * 255);
    else if (activeComponent === 'blue') setRgb('b', (1 - y) * 255);
    else if (activeComponent === 'l') setLab('l', (1 - y) * 100);
    else if (activeComponent === 'a') setLab('a', (1 - y) * 255 - 128);
    else setLab('b', (1 - y) * 255 - 128);
  }

  function getFieldPosition(): { x: number; y: number } {
    if (activeComponent === 'h') return { x: s / 100, y: 1 - v / 100 };
    if (activeComponent === 's') return { x: h / 360, y: 1 - v / 100 };
    if (activeComponent === 'v') return { x: h / 360, y: 1 - s / 100 };
    if (activeComponent === 'r') return { x: draft.g / 255, y: 1 - draft.b / 255 };
    if (activeComponent === 'g') return { x: draft.r / 255, y: 1 - draft.b / 255 };
    if (activeComponent === 'blue') return { x: draft.r / 255, y: 1 - draft.g / 255 };
    if (activeComponent === 'l') return { x: (lab.a + 128) / 255, y: 1 - (lab.b + 128) / 255 };
    if (activeComponent === 'a') return { x: lab.l / 100, y: 1 - (lab.b + 128) / 255 };
    return { x: lab.l / 100, y: 1 - (lab.a + 128) / 255 };
  }

  function getSliderPosition(): number {
    if (activeComponent === 'h') return h / 360;
    if (activeComponent === 's') return 1 - s / 100;
    if (activeComponent === 'v') return 1 - v / 100;
    if (activeComponent === 'r') return 1 - draft.r / 255;
    if (activeComponent === 'g') return 1 - draft.g / 255;
    if (activeComponent === 'blue') return 1 - draft.b / 255;
    if (activeComponent === 'l') return 1 - lab.l / 100;
    if (activeComponent === 'a') return 1 - (lab.a + 128) / 255;
    return 1 - (lab.b + 128) / 255;
  }

  function colorFromField(x: number, y: number): RGB {
    if (activeComponent === 'h') return hsvToRgb({ h, s: x * 100, v: (1 - y) * 100 });
    if (activeComponent === 's') return hsvToRgb({ h: x * 360, s, v: (1 - y) * 100 });
    if (activeComponent === 'v') return hsvToRgb({ h: x * 360, s: (1 - y) * 100, v });
    if (activeComponent === 'r') return { r: draft.r, g: x * 255, b: (1 - y) * 255 };
    if (activeComponent === 'g') return { r: x * 255, g: draft.g, b: (1 - y) * 255 };
    if (activeComponent === 'blue') return { r: x * 255, g: (1 - y) * 255, b: draft.b };
    if (activeComponent === 'l') return labToRgb({ l: lab.l, a: x * 255 - 128, b: (1 - y) * 255 - 128 });
    if (activeComponent === 'a') return labToRgb({ l: x * 100, a: lab.a, b: (1 - y) * 255 - 128 });
    return labToRgb({ l: x * 100, a: (1 - y) * 255 - 128, b: lab.b });
  }

  function colorFromSlider(y: number): RGB {
    if (activeComponent === 'h') return hsvToRgb({ h: y * 360, s: 100, v: 100 });
    if (activeComponent === 's') return hsvToRgb({ h, s: (1 - y) * 100, v });
    if (activeComponent === 'v') return hsvToRgb({ h, s, v: (1 - y) * 100 });
    if (activeComponent === 'r') return { ...draft, r: (1 - y) * 255 };
    if (activeComponent === 'g') return { ...draft, g: (1 - y) * 255 };
    if (activeComponent === 'blue') return { ...draft, b: (1 - y) * 255 };
    if (activeComponent === 'l') return labToRgb({ ...lab, l: (1 - y) * 100 });
    if (activeComponent === 'a') return labToRgb({ ...lab, a: (1 - y) * 255 - 128 });
    return labToRgb({ ...lab, b: (1 - y) * 255 - 128 });
  }

  function pickerDisplayColor(rgb: RGB): RGB {
    return webSafeOnly ? nearestWebSafe(rgb) : rgb;
  }

  function drawPickerCanvases(): void {
    drawColorField();
    drawColorSlider();
  }

  function drawColorField(): void {
    const ctx = fieldCanvas?.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(FIELD_SIZE, FIELD_SIZE);
    for (let yIndex = 0; yIndex < FIELD_SIZE; yIndex += 1) {
      const yValue = yIndex / (FIELD_SIZE - 1);
      for (let xIndex = 0; xIndex < FIELD_SIZE; xIndex += 1) {
        const xValue = xIndex / (FIELD_SIZE - 1);
        const rgb = pickerDisplayColor(colorFromField(xValue, yValue));
        const index = (yIndex * FIELD_SIZE + xIndex) * 4;
        image.data[index] = clamp(Math.round(rgb.r), 0, 255);
        image.data[index + 1] = clamp(Math.round(rgb.g), 0, 255);
        image.data[index + 2] = clamp(Math.round(rgb.b), 0, 255);
        image.data[index + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  function drawColorSlider(): void {
    const ctx = sliderCanvas?.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(SLIDER_WIDTH, SLIDER_HEIGHT);
    for (let yIndex = 0; yIndex < SLIDER_HEIGHT; yIndex += 1) {
      const rgb = pickerDisplayColor(colorFromSlider(yIndex / (SLIDER_HEIGHT - 1)));
      for (let xIndex = 0; xIndex < SLIDER_WIDTH; xIndex += 1) {
        const index = (yIndex * SLIDER_WIDTH + xIndex) * 4;
        image.data[index] = clamp(Math.round(rgb.r), 0, 255);
        image.data[index + 1] = clamp(Math.round(rgb.g), 0, 255);
        image.data[index + 2] = clamp(Math.round(rgb.b), 0, 255);
        image.data[index + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  function rgbToCmyk(rgb: RGB): { c: number; m: number; y: number; k: number } {
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    const k = 1 - Math.max(r, g, b);
    if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
    return {
      c: Math.round(((1 - r - k) / (1 - k)) * 100),
      m: Math.round(((1 - g - k) / (1 - k)) * 100),
      y: Math.round(((1 - b - k) / (1 - k)) * 100),
      k: Math.round(k * 100),
    };
  }

  function rgbToLab(rgb: RGB): { l: number; a: number; b: number } {
    const linear = (channel: number) => {
      const value = channel / 255;
      return value > 0.04045 ? ((value + 0.055) / 1.055) ** 2.4 : value / 12.92;
    };
    const r = linear(rgb.r);
    const g = linear(rgb.g);
    const b = linear(rgb.b);
    const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
    const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
    const pivot = (value: number) => (value > 0.008856 ? value ** (1 / 3) : 7.787 * value + 16 / 116);
    const fx = pivot(x);
    const fy = pivot(y);
    const fz = pivot(z);
    return {
      l: Math.round(116 * fy - 16),
      a: Math.round(500 * (fx - fy)),
      b: Math.round(200 * (fy - fz)),
    };
  }

  function labToRgb(labValue: { l: number; a: number; b: number }): RGB {
    const fy = (labValue.l + 16) / 116;
    const fx = labValue.a / 500 + fy;
    const fz = fy - labValue.b / 200;
    const pivot = (value: number) => {
      const cubed = value ** 3;
      return cubed > 0.008856 ? cubed : (value - 16 / 116) / 7.787;
    };
    const x = 0.95047 * pivot(fx);
    const y = pivot(fy);
    const z = 1.08883 * pivot(fz);
    const r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
    const g = x * -0.969266 + y * 1.8760108 + z * 0.041556;
    const b = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
    const encode = (value: number) => {
      const clamped = clamp(value, 0, 1);
      return Math.round((clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055) * 255);
    };
    return {
      r: encode(r),
      g: encode(g),
      b: encode(b),
    };
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onpointermove={onWindowPointerMove} onkeydown={onKeydown} />
<svelte:body class:color-sampling={sampling} />

<div
  class="picker-dialog"
  bind:this={dialogEl}
  style={`left:${dialogX}px; top:${dialogY}px`}
  role="dialog"
  aria-modal="true"
  aria-label={title}
  tabindex="-1"
  onpointerenter={() => (sampling = false)}
  onpointerleave={() => (sampling = true)}
>
  <header
    role="button"
    tabindex="0"
    aria-label="Drag color picker"
    onpointerdown={beginDialogPointerDrag}
    onmousedown={beginDialogMouseDrag}
  >
    {title}
  </header>
  <div class="dialog-body">
    <div class="sv-cube" use:dragField>
      <canvas bind:this={fieldCanvas} width={FIELD_SIZE} height={FIELD_SIZE} aria-label="Color field"></canvas>
      <span class="sv-ring" style={`left:${fieldPosition.x * 100}%; top:${fieldPosition.y * 100}%`}></span>
    </div>

    <div class="hue-strip" use:dragSlider>
      <canvas bind:this={sliderCanvas} width={SLIDER_WIDTH} height={SLIDER_HEIGHT} aria-label="Color component slider"></canvas>
      <span class="hue-marker" style={`top:${sliderPosition * 100}%`}></span>
    </div>

    <div class="preview">
      <span>new</span>
      <div class="preview-chip" style={`background:${rgbToCss(draft)}`}></div>
      <div class="preview-chip current" style={`background:${rgbToCss(currentColor)}`}></div>
      <span>current</span>
      {#if showWebSafeWarning}
        <div class="color-warnings">
          <span class="cube-mark" aria-hidden="true"></span>
          <button
            class="web-safe-swatch"
            type="button"
            style={`background:${rgbToCss(webSafeSuggestion)}`}
            aria-label={`Select nearest web safe color ${rgbToHex(webSafeSuggestion)}`}
            use:tooltip={{ text: 'Click to select web safe color', placement: 'right' }}
            onclick={selectWebSafeSuggestion}
          ></button>
        </div>
      {/if}
    </div>

    <div class="actions">
      <button class="primary" onclick={() => onApply(draft)}>OK</button>
      <button onclick={onClose}>Cancel</button>
      <button onclick={() => editor.flash('Swatches panel stores project colors next')}>Add to Swatches</button>
      <button onclick={() => editor.flash('Libraries use project assets')}>Color Libraries</button>
    </div>

    <div class="fields hsb-rgb">
      <div class="color-row"><button class="radio" class:on={activeComponent === 'h'} aria-label="Use Hue as slider" onclick={() => (activeComponent = 'h')}></button><b>H:</b><input type="number" min="0" max="360" value={Math.round(h)} oninput={(e) => setHsv('h', e.currentTarget.valueAsNumber)} /><em>°</em></div>
      <div class="color-row"><button class="radio" class:on={activeComponent === 's'} aria-label="Use Saturation as slider" onclick={() => (activeComponent = 's')}></button><b>S:</b><input type="number" min="0" max="100" value={Math.round(s)} oninput={(e) => setHsv('s', e.currentTarget.valueAsNumber)} /><em>%</em></div>
      <div class="color-row"><button class="radio" class:on={activeComponent === 'v'} aria-label="Use Brightness as slider" onclick={() => (activeComponent = 'v')}></button><b>B:</b><input type="number" min="0" max="100" value={Math.round(v)} oninput={(e) => setHsv('v', e.currentTarget.valueAsNumber)} /><em>%</em></div>
      <div class="color-row"><button class="radio" class:on={activeComponent === 'r'} aria-label="Use Red as slider" onclick={() => (activeComponent = 'r')}></button><b>R:</b><input type="number" min="0" max="255" value={draft.r} oninput={(e) => setRgb('r', e.currentTarget.valueAsNumber)} /></div>
      <div class="color-row"><button class="radio" class:on={activeComponent === 'g'} aria-label="Use Green as slider" onclick={() => (activeComponent = 'g')}></button><b>G:</b><input type="number" min="0" max="255" value={draft.g} oninput={(e) => setRgb('g', e.currentTarget.valueAsNumber)} /></div>
      <div class="color-row"><button class="radio" class:on={activeComponent === 'blue'} aria-label="Use Blue as slider" onclick={() => (activeComponent = 'blue')}></button><b>B:</b><input type="number" min="0" max="255" value={draft.b} oninput={(e) => setRgb('b', e.currentTarget.valueAsNumber)} /></div>
      <label class="hex"><b>#</b><input value={hexDraft} maxlength="6" spellcheck="false" oninput={(e) => setHex(e.currentTarget.value)} /></label>
    </div>

    <div class="field-stack">
      <div class="fields lab">
        <div class="color-row"><button class="radio" class:on={activeComponent === 'l'} aria-label="Use Lab Lightness as slider" onclick={() => (activeComponent = 'l')}></button><b>L:</b><input type="number" min="0" max="100" value={lab.l} oninput={(e) => setLab('l', e.currentTarget.valueAsNumber)} /></div>
        <div class="color-row"><button class="radio" class:on={activeComponent === 'a'} aria-label="Use Lab a as slider" onclick={() => (activeComponent = 'a')}></button><b>a:</b><input type="number" min="-128" max="127" value={lab.a} oninput={(e) => setLab('a', e.currentTarget.valueAsNumber)} /></div>
        <div class="color-row"><button class="radio" class:on={activeComponent === 'labB'} aria-label="Use Lab b as slider" onclick={() => (activeComponent = 'labB')}></button><b>b:</b><input type="number" min="-128" max="127" value={lab.b} oninput={(e) => setLab('b', e.currentTarget.valueAsNumber)} /></div>
      </div>

      <div class="cmyk">
        <label><b>C:</b><input value={cmyk.c} readonly /><em>%</em></label>
        <label><b>M:</b><input value={cmyk.m} readonly /><em>%</em></label>
        <label><b>Y:</b><input value={cmyk.y} readonly /><em>%</em></label>
        <label><b>K:</b><input value={cmyk.k} readonly /><em>%</em></label>
      </div>
    </div>

    <label class="web-only"><input type="checkbox" checked={webSafeOnly} onchange={(e) => setWebSafeOnly(e.currentTarget.checked)} />Only Web Colors</label>
  </div>
</div>

<style>
  :global(body.color-sampling),
  :global(body.color-sampling *) {
    cursor: crosshair !important;
  }
  .picker-dialog {
    position: fixed;
    width: 580px;
    max-width: calc(100vw - 34px);
    z-index: 140;
    overflow: hidden;
    border: 1px solid #242424;
    border-radius: 10px;
    background: #565656;
    box-shadow:
      0 14px 34px rgba(0, 0, 0, 0.44),
      inset 0 1px 0 rgba(255, 255, 255, 0.1);
    color: #eee;
    font-size: 12px;
    line-height: 1.35;
  }
  header {
    height: 34px;
    display: grid;
    place-items: center;
    border-bottom: 1px solid #1f1f1f;
    background: #484b4c;
    color: #d6d6d6;
    cursor: move;
    font-size: 12px;
    font-weight: 600;
    user-select: none;
  }
  .dialog-body {
    display: grid;
    grid-template-columns: 236px 24px 118px 6px 132px;
    grid-template-rows: 150px 77px 92px;
    grid-template-areas:
      'cube hue preview . actions'
      'cube hue hsb fieldstack fieldstack'
      'web  hue hsb fieldstack fieldstack';
    column-gap: 8px;
    row-gap: 9px;
    padding: 26px 12px 15px;
    align-items: start;
  }
  .sv-cube {
    grid-area: cube;
    position: relative;
    width: 236px;
    height: 236px;
    cursor: crosshair;
    touch-action: none;
  }
  .sv-cube canvas,
  .hue-strip canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .sv-ring {
    position: absolute;
    width: 13px;
    height: 13px;
    border: 2px solid #fff;
    border-radius: 50%;
    box-shadow: 0 0 0 1px #333;
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
  .hue-strip {
    grid-area: hue;
    position: relative;
    width: 24px;
    height: 236px;
    cursor: ns-resize;
    touch-action: none;
    background: linear-gradient(to bottom, #f00 0%, #f0f 17%, #00f 33%, #0ff 50%, #0f0 67%, #ff0 83%, #f00 100%);
  }
  .hue-marker {
    position: absolute;
    left: -7px;
    width: 0;
    height: 0;
    border-top: 6px solid transparent;
    border-bottom: 6px solid transparent;
    border-left: 9px solid #f2f2f2;
    filter: drop-shadow(0 0 1px #111);
    transform: translateY(-50%);
    pointer-events: none;
  }
  .preview {
    grid-area: preview;
    position: relative;
    display: grid;
    grid-template-columns: 64px;
    justify-content: start;
    justify-items: center;
    padding-left: 14px;
    align-self: start;
    color: #d6d6d6;
    font-size: 12px;
    font-weight: 400;
  }
  .preview-chip {
    width: 64px;
    height: 47px;
    border: 1px solid #303030;
  }
  .preview-chip.current {
    margin-top: -1px;
  }
  .color-warnings {
    position: absolute;
    top: 62px;
    left: 86px;
    display: grid;
    gap: 7px;
  }
  .cube-mark,
  .web-safe-swatch {
    width: 14px;
    height: 14px;
    border: 2px solid #dedede;
  }
  .cube-mark {
    transform: rotate(45deg) scale(0.82);
  }
  .web-safe-swatch {
    padding: 0;
    border-radius: 0;
  }
  .web-safe-swatch:hover {
    border-color: #fff;
  }
  .actions {
    grid-area: actions;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .actions button {
    width: 132px;
    min-height: 28px;
    padding: 2px 8px;
    border: 2px solid rgba(255, 255, 255, 0.26);
    border-radius: 16px;
    background: transparent;
    color: #f1f1f1;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.15;
  }
  .actions .primary {
    border-color: #e0e0e0;
  }
  .fields,
  .cmyk {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .hsb-rgb {
    grid-area: hsb;
    margin-left: 14px;
  }
  .lab {
    grid-area: lab;
  }
  .cmyk {
    margin-top: 4px;
  }
  .field-stack {
    grid-area: fieldstack;
  }
  .color-row,
  .hex,
  .web-only {
    display: grid;
    grid-template-columns: 13px 17px 50px 9px;
    align-items: center;
    gap: 4px;
    color: #d6d6d6;
    font-size: 12px;
    font-weight: 400;
  }
  .lab .color-row {
    grid-template-columns: 13px 17px 50px;
  }
  .cmyk label {
    display: grid;
    grid-template-columns: 13px 17px 50px 12px;
    align-items: center;
    gap: 4px;
    color: #d6d6d6;
    font-size: 12px;
    font-weight: 400;
  }
  .cmyk b {
    grid-column: 2;
  }
  .cmyk input {
    grid-column: 3;
  }
  .cmyk em {
    grid-column: 4;
  }
  .color-row b,
  .hex b,
  .cmyk b {
    color: #dddddd;
    font-weight: 400;
  }
  .hex {
    grid-template-columns: 16px 84px;
    align-self: end;
  }
  .radio {
    width: 13px;
    height: 13px;
    padding: 0;
    border: 2px solid #969696;
    border-radius: 50%;
    background: transparent;
  }
  .radio:hover {
    background: transparent;
    border-color: #c0c0c0;
  }
  .radio:active {
    background: transparent;
  }
  .radio.on {
    border: 5px solid #e4e4e4;
  }
  input {
    min-width: 0;
    height: 22px;
    padding: 0 5px;
    border: 1px solid #6f6f6f;
    border-radius: 0;
    background: #4c4c4c;
    color: #fff;
    font: inherit;
    font-weight: 400;
  }
  .hex input:focus {
    outline: 1px solid #1686ff;
    border-color: #1686ff;
  }
  em {
    color: #d6d6d6;
    font-style: normal;
    font-weight: 400;
  }
  .web-only {
    grid-area: web;
    grid-column: 1 / 3;
    grid-template-columns: 22px auto;
    width: max-content;
    align-self: start;
    margin: 4px 0 0;
  }
  .web-only input {
    width: 14px;
    height: 14px;
    padding: 0;
    border-radius: 4px;
  }
</style>
