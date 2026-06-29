<script lang="ts">
  import { RoughGenerator } from 'roughjs/bin/generator';
  import type { PathInfo } from 'roughjs/bin/core';
  import type { AnnotationItem } from '../engine/annotations';

  let { item }: { item: AnnotationItem } = $props();

  const generator = new RoughGenerator();

  function seedFor(id: string): number {
    let seed = 2166136261;
    for (let i = 0; i < id.length; i++) {
      seed ^= id.charCodeAt(i);
      seed = Math.imul(seed, 16777619);
    }
    return Math.abs(seed) % 2147483647 || 1;
  }

  function options(fill: string | undefined = undefined) {
    return {
      seed: seedFor(item.id),
      roughness: 1.35,
      bowing: 1.1,
      maxRandomnessOffset: 2.1,
      stroke: item.color,
      strokeWidth: 2.4,
      fill,
      fillStyle: 'solid',
      disableMultiStrokeFill: true,
    };
  }

  function roundedRectPath(w: number, h: number, r: number): string {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    return [
      `M ${radius} 0`,
      `H ${w - radius}`,
      `Q ${w} 0 ${w} ${radius}`,
      `V ${h - radius}`,
      `Q ${w} ${h} ${w - radius} ${h}`,
      `H ${radius}`,
      `Q 0 ${h} 0 ${h - radius}`,
      `V ${radius}`,
      `Q 0 0 ${radius} 0`,
      'Z',
    ].join(' ');
  }

  function calloutPath(w: number, h: number): string {
    const r = Math.min(18, w / 4, h / 3);
    const tailX = Math.max(18, Math.min(w - 45, w * 0.22));
    const tailY = h;
    return [
      `M ${r} 0`,
      `H ${w - r}`,
      `Q ${w} 0 ${w} ${r}`,
      `V ${h - r}`,
      `Q ${w} ${h} ${w - r} ${h}`,
      `H ${tailX + 32}`,
      `L ${tailX + 18} ${tailY + 28}`,
      `L ${tailX + 8} ${h}`,
      `H ${r}`,
      `Q 0 ${h} 0 ${h - r}`,
      `V ${r}`,
      `Q 0 0 ${r} 0`,
      'Z',
    ].join(' ');
  }

  function notePath(w: number, h: number): string {
    const fold = Math.min(30, w * 0.25, h * 0.38);
    return [
      'M 0 0',
      `H ${w}`,
      `V ${h - fold}`,
      `L ${w - fold} ${h}`,
      'H 0',
      'Z',
    ].join(' ');
  }

  function badgePath(w: number, h: number): string {
    const notch = Math.min(26, w * 0.24);
    const r = Math.min(14, h / 2);
    return [
      `M ${notch} 0`,
      `H ${w - r}`,
      `Q ${w} 0 ${w} ${r}`,
      `V ${h - r}`,
      `Q ${w} ${h} ${w - r} ${h}`,
      `H ${notch}`,
      'L 0 ' + h / 2,
      'Z',
    ].join(' ');
  }

  function makePaths(): PathInfo[] {
    const w = Math.max(12, item.width);
    const h = Math.max(12, item.height);
    const y = h / 2;
    const stroke = options();

    if (item.kind === 'arrow') {
      return [
        ...generator.toPaths(generator.line(2, y, w - 16, y, stroke)),
        ...generator.toPaths(generator.polygon([[w - 18, y - 10], [w - 2, y], [w - 18, y + 10]], { ...stroke, fill: item.color })),
      ];
    }
    if (item.kind === 'divider') {
      return generator.toPaths(generator.line(2, y, w - 2, y, stroke));
    }
    if (item.kind === 'note') {
      const fold = Math.min(30, w * 0.25, h * 0.38);
      return [
        ...generator.toPaths(generator.path(notePath(w, h), options('#fff3a6'))),
        ...generator.toPaths(generator.linearPath([[w, h - fold], [w - fold, h], [w - fold, h - fold]], stroke)),
      ];
    }
    if (item.kind === 'badge') {
      return [
        ...generator.toPaths(generator.path(badgePath(w, h), options(item.color))),
        ...generator.toPaths(generator.circle(Math.min(18, w * 0.2), h / 2, Math.min(8, h * 0.22), { ...stroke, fill: '#ffffff', stroke: '#111111' })),
      ];
    }
    return generator.toPaths(generator.path(calloutPath(w, h), options('rgba(255,255,255,0.96)')));
  }

  const paths = $derived.by(() => {
    item.id;
    item.kind;
    item.width;
    item.height;
    item.color;
    return makePaths();
  });

  const viewBox = $derived(item.kind === 'callout'
    ? `0 0 ${Math.max(12, item.width)} ${Math.max(12, item.height) + 30}`
    : `0 0 ${Math.max(12, item.width)} ${Math.max(12, item.height)}`);
</script>

<svg class="rough-shape" viewBox={viewBox} preserveAspectRatio="none" aria-hidden="true">
  {#each paths as path, i (`${path.d}-${i}`)}
    <path d={path.d} stroke={path.stroke} stroke-width={path.strokeWidth} fill={path.fill ?? 'none'} />
  {/each}
</svg>

<style>
  .rough-shape {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
</style>
