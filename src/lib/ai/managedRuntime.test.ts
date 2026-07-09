import { describe, expect, it } from 'vitest';
import { formatRuntimeBytes, runtimeProgressPercent, type ManagedRuntimeProgress } from './managedRuntime';

describe('managed runtime presentation', () => {
  it('formats download sizes compactly', () => {
    expect(formatRuntimeBytes(null)).toBeNull();
    expect(formatRuntimeBytes(55000000)).toBe('52 MB');
    expect(formatRuntimeBytes(1024)).toBe('1 KB');
  });

  it('clamps progress and handles unknown totals', () => {
    const progress: ManagedRuntimeProgress = {
      provider: 'codex',
      phase: 'downloading',
      downloadedBytes: 25,
      totalBytes: 100,
      message: 'Downloading',
    };
    expect(runtimeProgressPercent(progress)).toBe(25);
    expect(runtimeProgressPercent({ ...progress, downloadedBytes: 150 })).toBe(100);
    expect(runtimeProgressPercent({ ...progress, totalBytes: null })).toBeNull();
  });
});
