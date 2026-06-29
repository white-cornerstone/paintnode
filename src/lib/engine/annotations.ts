import { uid } from './types';

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
