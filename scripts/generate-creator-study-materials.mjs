import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'docs/testing/creator-study/materials');
const width = 512;
const height = 512;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), data.length + 8);
  return result;
}

function encodePng(pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function productPng(variant) {
  const pixels = Buffer.alloc(width * height * 4);
  const set = (x, y, r, g, b, a = 255) => {
    const offset = (y * width + x) * 4;
    pixels[offset] = r; pixels[offset + 1] = g; pixels[offset + 2] = b; pixels[offset + 3] = a;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const glow = Math.max(0, 1 - Math.hypot(x - 256, y - 238) / 370);
      set(x, y, 238 - Math.round(glow * 25), 242 - Math.round(glow * 18), 245 + Math.round(glow * 10));
    }
  }
  for (let y = 410; y < 447; y += 1) {
    for (let x = 104; x < 408; x += 1) {
      const distance = ((x - 256) / 152) ** 2 + ((y - 428) / 19) ** 2;
      if (distance <= 1) set(x, y, 86, 96, 112, Math.round(80 * (1 - distance)) + 20);
    }
  }
  for (let y = 113; y <= 415; y += 1) {
    for (let x = 154; x <= 358; x += 1) {
      const rounded = (y >= 145 && y <= 390) || ((x - 256) / 102) ** 2 + ((y - (y < 145 ? 145 : 390)) / 32) ** 2 <= 1;
      if (!rounded) continue;
      const edge = Math.min(x - 154, 358 - x);
      const shine = Math.max(0, 1 - Math.abs(x - 202) / 26);
      const base = variant === 'A' ? [26, 112, 138] : [32, 105, 133];
      set(x, y, base[0] + Math.round(shine * 58) + Math.min(edge, 14), base[1] + Math.round(shine * 55), base[2] + Math.round(shine * 45));
    }
  }
  for (let y = 78; y < 151; y += 1) {
    for (let x = 195; x < 317; x += 1) {
      const cap = y >= 93 || ((x - 256) / 61) ** 2 + ((y - 93) / 15) ** 2 <= 1;
      if (cap) set(x, y, 31 + (x % 7), 38 + (x % 7), 48 + (x % 7));
    }
  }
  const labelColor = variant === 'A' ? [246, 202, 78] : [238, 111, 83];
  for (let y = 230; y < 342; y += 1) for (let x = 176; x < 337; x += 1) set(x, y, 249, 247, 239);
  for (let y = 246; y < 263; y += 1) for (let x = 192; x < 321; x += 1) set(x, y, ...labelColor);
  for (let y = 282; y < 290; y += 1) for (let x = 206; x < 307; x += 1) set(x, y, 54, 63, 74);
  for (let y = 302; y < 307; y += 1) for (let x = 220; x < 293; x += 1) set(x, y, 116, 124, 132);
  return encodePng(pixels);
}

mkdirSync(output, { recursive: true });
const definitions = [
  { task: 1, label: 'Product A', relativePath: 'product-a.png', variant: 'A', purpose: 'Initial Product supplied for Task 1.' },
  { task: 6, label: 'Product B', relativePath: 'product-b.png', variant: 'B', purpose: 'Updated Product supplied only when Task 6 begins.' },
];
const materials = definitions.map(({ variant, ...definition }) => {
  const bytes = productPng(variant);
  writeFileSync(join(output, definition.relativePath), bytes);
  return {
    ...definition,
    width,
    height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mime: 'image/png',
    nonConfidential: true,
  };
});
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify({
  version: 1,
  license: 'CC0-1.0',
  provenance: 'Deterministically generated in this repository by scripts/generate-creator-study-materials.mjs; no external or client source material.',
  taskRule: 'Use Product A for Task 1. Do not reveal or import Product B until Task 6.',
  materials,
}, null, 2)}\n`);
