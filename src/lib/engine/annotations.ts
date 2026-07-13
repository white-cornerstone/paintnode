import { uid } from './types';
import { createCanvas, ctx2d } from './types';

export type AnnotationKind = 'arrow' | 'note' | 'callout' | 'badge' | 'divider';

export interface AnnotationItem {
  id: string;
  kind: AnnotationKind;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  color: string;
  visible: boolean;
}

export interface AnnotationDragPoint {
  x: number;
  y: number;
}

const LINE_OBJECT_HEIGHT = 34;

export function newAnnotation(args: Omit<AnnotationItem, 'id' | 'visible' | 'rotation' | 'flipX' | 'flipY'> & {
  id?: string;
  visible?: boolean;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
}): AnnotationItem {
  let x = Math.round(args.x);
  let y = Math.round(args.y);
  let width = Math.round(args.width);
  let height = Math.round(args.height);
  let rotation = Number.isFinite(args.rotation) ? Number(args.rotation) : 0;

  if ((args.kind === 'arrow' || args.kind === 'divider') && !Number.isFinite(args.rotation)) {
    rotation = Math.atan2(height, width || 1);
    width = Math.round(Math.max(28, Math.hypot(width, height)));
    height = 34;
  } else {
    if (width < 0) {
      x += width;
      width = Math.abs(width);
    }
    if (height < 0) {
      y += height;
      height = Math.abs(height);
    }
  }

  return {
    id: args.id ?? uid('annotation'),
    kind: args.kind,
    text: args.text,
    x,
    y,
    width: Math.max(12, width),
    height: Math.max(12, height),
    rotation,
    flipX: args.flipX ?? false,
    flipY: args.flipY ?? false,
    color: args.color,
    visible: args.visible ?? true,
  };
}

export function annotationFromDrag(args: {
  kind: AnnotationKind;
  text: string;
  start: AnnotationDragPoint;
  end: AnnotationDragPoint;
  color: string;
  id?: string;
  visible?: boolean;
}): AnnotationItem {
  const dx = args.end.x - args.start.x;
  const dy = args.end.y - args.start.y;

  if (args.kind === 'arrow' || args.kind === 'divider') {
    const length = Math.max(28, Math.hypot(dx, dy));
    const rotation = Math.atan2(dy, dx || 1);
    const centerX = args.start.x + dx / 2;
    const centerY = args.start.y + dy / 2;
    return newAnnotation({
      id: args.id,
      kind: args.kind,
      text: args.text,
      x: centerX - length / 2,
      y: centerY - LINE_OBJECT_HEIGHT / 2,
      width: length,
      height: LINE_OBJECT_HEIGHT,
      rotation,
      color: args.color,
      visible: args.visible,
    });
  }

  const width = Math.abs(dx);
  const height = Math.abs(dy);
  return newAnnotation({
    id: args.id,
    kind: args.kind,
    text: args.text,
    x: Math.min(args.start.x, args.end.x),
    y: Math.min(args.start.y, args.end.y),
    width: Math.max(args.kind === 'badge' ? 64 : 92, width),
    height: Math.max(args.kind === 'badge' ? 36 : 48, height),
    color: args.color,
    visible: args.visible,
  });
}

export function coerceAnnotations(value: unknown): AnnotationItem[] {
  if (!Array.isArray(value)) return [];
  const result: AnnotationItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Partial<AnnotationItem>;
    if (!raw.kind || !['arrow', 'note', 'callout', 'badge', 'divider'].includes(raw.kind)) continue;
    result.push(newAnnotation({
      id: typeof raw.id === 'string' && raw.id ? raw.id : undefined,
      kind: raw.kind,
      text: typeof raw.text === 'string' ? raw.text : '',
      x: Number.isFinite(raw.x) ? Number(raw.x) : 0,
      y: Number.isFinite(raw.y) ? Number(raw.y) : 0,
      width: Number.isFinite(raw.width) ? Number(raw.width) : 120,
      height: Number.isFinite(raw.height) ? Number(raw.height) : 48,
      rotation: Number.isFinite(raw.rotation) ? Number(raw.rotation) : 0,
      flipX: raw.flipX === true,
      flipY: raw.flipY === true,
      color: typeof raw.color === 'string' && raw.color ? raw.color : '#2563eb',
      visible: raw.visible !== false,
    }));
  }
  return result;
}

export function visibleAnnotations(items: AnnotationItem[]): AnnotationItem[] {
  return items.filter((item) => item.visible);
}

export function annotationInstructionNotes(items: AnnotationItem[], width: number, height: number): string[] {
  return visibleAnnotations(items)
    .filter((item) => item.text.trim())
    .map((item, index) => {
      const cx = Math.round(((item.x + item.width / 2) / Math.max(1, width)) * 100);
      const cy = Math.round(((item.y + item.height / 2) / Math.max(1, height)) * 100);
      return `Annotation ${index + 1} at ${cx}% x, ${cy}% y (${item.kind}): ${item.text.trim()}`;
    });
}

export function renderAnnotatedCanvas(source: HTMLCanvasElement, annotations: readonly AnnotationItem[]): HTMLCanvasElement {
  const annotated = createCanvas(source.width, source.height);
  const ctx = ctx2d(annotated);
  ctx.drawImage(source, 0, 0);
  for (const item of annotations) drawAnnotationToContext(ctx, item);
  return annotated;
}

export function drawAnnotationToContext(ctx: CanvasRenderingContext2D, item: AnnotationItem): void {
  ctx.save();
  ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
  ctx.rotate(item.rotation);
  ctx.scale(item.flipX ? -1 : 1, item.flipY ? -1 : 1);
  ctx.strokeStyle = item.color;
  ctx.fillStyle = item.color;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const x0 = -item.width / 2;
  const x1 = item.width / 2;
  if (item.kind === 'arrow' || item.kind === 'divider') {
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x1, 0);
    ctx.stroke();
    if (item.kind === 'arrow') {
      const size = 18;
      ctx.beginPath();
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1 - Math.cos(-Math.PI / 6) * size, -Math.sin(-Math.PI / 6) * size);
      ctx.lineTo(x1 - Math.cos(Math.PI / 6) * size, -Math.sin(Math.PI / 6) * size);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    return;
  }
  const w = Math.max(34, item.width);
  const h = Math.max(26, item.height);
  const x = -w / 2;
  const y = -h / 2;
  if (item.kind === 'badge') {
    const radius = Math.min(Math.max(6, Math.min(16, h / 2)), w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#111111';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x + 14, 0, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `700 ${Math.max(13, Math.min(22, h * 0.42))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.text, 8, 0, Math.max(10, w - 30));
    ctx.restore();
    return;
  }
  if (item.kind === 'note') {
    ctx.fillStyle = '#fff5a8';
    ctx.strokeStyle = '#111111';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 5);
    ctx.fill();
    ctx.stroke();
    const fold = Math.min(28, w * 0.28, h * 0.42);
    ctx.fillStyle = '#eadc73';
    ctx.beginPath();
    ctx.moveTo(x + w - fold, y + h);
    ctx.lineTo(x + w, y + h - fold);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.strokeStyle = '#111111';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, item.kind === 'callout' ? 14 : 7);
    ctx.fill();
    ctx.stroke();
    if (item.kind === 'callout') {
      ctx.beginPath();
      ctx.moveTo(x + 18, y + h - 1);
      ctx.lineTo(x + 35, y + h + 18);
      ctx.lineTo(x + 45, y + h - 1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.fillStyle = '#111111';
  ctx.font = `${Math.max(13, Math.min(24, h * 0.38))}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(item.text, x + 10, y + h / 2, Math.max(10, w - 20));
  ctx.restore();
}
