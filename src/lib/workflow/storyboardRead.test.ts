import { describe, expect, it, vi } from 'vitest';
import { resolveWorkflowStoryboardRead } from './storyboardRead';

describe('workflow storyboard material origin', () => {
  it('labels embedded pixels as embedded when a stale ORA path also exists', async () => {
    const embedded = new Uint8Array([1, 2, 3]);
    const savedOraComposite = new Uint8Array([9, 8, 7]);
    const readEmbedded = vi.fn(async () => embedded);
    const readOra = vi.fn(async () => savedOraComposite);

    const result = await resolveWorkflowStoryboardRead({
      dataUrl: 'data:image/png;base64,AQID',
      oraPath: 'storyboards/campaign.ora',
      width: 1440,
      height: 900,
      annotations: [],
      annotationItems: [],
      annotationsVisible: true,
    }, { readEmbedded, readOra });

    expect(result).toEqual({
      bytes: embedded,
      relativePath: 'storyboards/embedded-composition.png',
    });
    expect(readEmbedded).toHaveBeenCalledOnce();
    expect(readOra).not.toHaveBeenCalled();
  });

  it('keeps the ORA path only when the bytes were composited from that ORA', async () => {
    const oraComposite = new Uint8Array([4, 5, 6]);
    const result = await resolveWorkflowStoryboardRead({
      dataUrl: null,
      oraPath: 'storyboards/campaign.ora',
      width: 1440,
      height: 900,
      annotations: [],
      annotationItems: [],
      annotationsVisible: true,
    }, {
      readEmbedded: vi.fn(),
      readOra: async () => oraComposite,
    });
    expect(result).toEqual({ bytes: oraComposite, relativePath: 'storyboards/campaign.ora' });
  });
});
