import { describe, expect, it } from 'vitest';
import { fileDocumentSourceKey, nativePathDocumentSourceKey, projectDocumentSourceKey } from './documentSource';

describe('document source keys', () => {
  it('normalizes project document paths', () => {
    expect(projectDocumentSourceKey('documents\\example.ora')).toBe('project:documents/example.ora');
    expect(projectDocumentSourceKey('')).toBeNull();
  });

  it('uses the browser file identity for picked files', () => {
    expect(
      fileDocumentSourceKey({
        name: 'example.ora',
        size: 1024,
        lastModified: 12345,
      }),
    ).toBe('file:example.ora:1024:12345');
  });

  it('prefers relative paths when the browser provides them', () => {
    expect(
      fileDocumentSourceKey({
        name: 'example.ora',
        webkitRelativePath: 'folder\\example.ora',
        size: 1024,
        lastModified: 12345,
      }),
    ).toBe('file:folder/example.ora:1024:12345');
  });

  it('normalizes native dropped file paths', () => {
    expect(nativePathDocumentSourceKey('/Users/me/Pictures/example.ora')).toBe(
      'native:/Users/me/Pictures/example.ora',
    );
    expect(nativePathDocumentSourceKey('')).toBeNull();
  });
});
