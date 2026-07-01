import { describe, expect, it } from 'vitest';
import { filesFromDataTransfer, hasFileDrag } from './io';

describe('drag-and-drop file helpers', () => {
  it('detects file drags from the transfer type list', () => {
    const dataTransfer = {
      types: ['Files'],
      items: [],
      files: [],
    } as unknown as DataTransfer;

    expect(hasFileDrag(dataTransfer)).toBe(true);
  });

  it('extracts files from data transfer items', () => {
    const file = { name: 'example.png' } as File;
    const dataTransfer = {
      types: [],
      items: [{ kind: 'file', getAsFile: () => file }],
      files: [],
    } as unknown as DataTransfer;

    expect(filesFromDataTransfer(dataTransfer)).toEqual([file]);
  });

  it('falls back to the file list when item files are unavailable', () => {
    const file = { name: 'example.ora' } as File;
    const dataTransfer = {
      types: [],
      items: [],
      files: [file],
    } as unknown as DataTransfer;

    expect(filesFromDataTransfer(dataTransfer)).toEqual([file]);
  });
});
