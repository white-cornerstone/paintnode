import { describe, expect, it } from 'vitest';
import { annotationInstructionNotes, visibleAnnotations, type AnnotationItem } from './annotations';

function annotation(patch: Partial<AnnotationItem>): AnnotationItem {
  return {
    id: patch.id ?? 'a',
    kind: patch.kind ?? 'callout',
    text: patch.text ?? 'change to 123',
    x: patch.x ?? 10,
    y: patch.y ?? 20,
    width: patch.width ?? 40,
    height: patch.height ?? 20,
    rotation: patch.rotation ?? 0,
    flipX: patch.flipX ?? false,
    flipY: patch.flipY ?? false,
    color: patch.color ?? '#ff0000',
    visible: patch.visible ?? true,
  };
}

describe('annotation AI guidance helpers', () => {
  it('keeps only visible annotations for rendered guidance', () => {
    const items = [
      annotation({ id: 'visible', visible: true }),
      annotation({ id: 'hidden', visible: false }),
    ];

    expect(visibleAnnotations(items).map((item) => item.id)).toEqual(['visible']);
  });

  it('extracts visible text annotations with document-relative positions', () => {
    const notes = annotationInstructionNotes([
      annotation({ kind: 'callout', x: 30, y: 10, width: 20, height: 20, text: 'change to 123' }),
      annotation({ kind: 'badge', x: 80, y: 80, width: 10, height: 10, text: '  ' }),
      annotation({ kind: 'note', x: 90, y: 90, width: 10, height: 10, text: 'hidden', visible: false }),
    ], 100, 100);

    expect(notes).toEqual(['Annotation 1 at 40% x, 20% y (callout): change to 123']);
  });
});
