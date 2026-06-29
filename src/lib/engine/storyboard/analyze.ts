export interface StoryboardImageLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

interface Component {
  pixels: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type MaskName = 'dark' | 'red' | 'blue' | 'green';

function pct(value: number, max: number): number {
  return Math.max(0, Math.min(100, Math.round((value / Math.max(1, max)) * 100)));
}

function region(cx: number): string {
  if (cx < 33) return 'left third';
  if (cx < 45) return 'left half';
  if (cx <= 55) return 'center band';
  if (cx <= 67) return 'right half';
  return 'right third';
}

function maskMatches(mask: MaskName, r: number, g: number, b: number, a: number): boolean {
  if (a < 32) return false;
  switch (mask) {
    case 'dark':
      return r < 95 && g < 95 && b < 95;
    case 'red':
      return r > 130 && r > g * 1.35 && r > b * 1.25;
    case 'blue':
      return b > 110 && b > r * 1.15 && b > g * 1.05;
    case 'green':
      return g > 120 && g > r * 1.25 && g > b * 1.2;
  }
}

function componentsForMask(image: StoryboardImageLike, mask: MaskName): Component[] {
  const { width, height, data } = image;
  const total = width * height;
  const matches = new Uint8Array(total);
  const visited = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const p = i * 4;
    matches[i] = maskMatches(mask, data[p], data[p + 1], data[p + 2], data[p + 3]) ? 1 : 0;
  }

  const minPixels = Math.max(10, Math.round(total * 0.00018));
  const components: Component[] = [];
  const stack: number[] = [];
  for (let i = 0; i < total; i += 1) {
    if (!matches[i] || visited[i]) continue;
    let pixels = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    visited[i] = 1;
    stack.push(i);
    while (stack.length) {
      const next = stack.pop()!;
      const x = next % width;
      const y = Math.floor(next / width);
      pixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [
        x > 0 ? next - 1 : -1,
        x + 1 < width ? next + 1 : -1,
        y > 0 ? next - width : -1,
        y + 1 < height ? next + width : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && matches[n] && !visited[n]) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    if (pixels >= minPixels) components.push({ pixels, minX, minY, maxX, maxY });
  }
  return components.sort((a, b) => b.pixels - a.pixels);
}

function lineForComponent(label: string, component: Component, image: StoryboardImageLike, index: number): string {
  const cx = pct((component.minX + component.maxX) / 2, image.width);
  const cy = pct((component.minY + component.maxY) / 2, image.height);
  const x0 = pct(component.minX, image.width);
  const x1 = pct(component.maxX, image.width);
  const y0 = pct(component.minY, image.height);
  const y1 = pct(component.maxY, image.height);
  return `${label} component ${index}: center ${cx}% x, ${cy}% y (${region(cx)}), bounds x ${x0}-${x1}%, y ${y0}-${y1}%`;
}

export function storyboardPlacementSummary(image: StoryboardImageLike): string[] {
  if (image.width <= 0 || image.height <= 0 || image.data.length < image.width * image.height * 4) {
    return [];
  }

  const lines: string[] = [];
  const dark = componentsForMask(image, 'dark').slice(0, 4);
  if (dark.length) {
    lines.push(...dark.map((component, index) => lineForComponent('dark ink / likely subject or note', component, image, index + 1)));
  }
  const red = componentsForMask(image, 'red').slice(0, 2);
  lines.push(...red.map((component, index) => lineForComponent('red mark / likely prop emphasis', component, image, index + 1)));
  const blue = componentsForMask(image, 'blue').slice(0, 2);
  lines.push(...blue.map((component, index) => lineForComponent('blue mark / likely environment zone', component, image, index + 1)));
  const green = componentsForMask(image, 'green').slice(0, 2);
  lines.push(...green.map((component, index) => lineForComponent('green mark / likely annotation guide', component, image, index + 1)));
  return lines.slice(0, 10);
}
