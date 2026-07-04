import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOADING_APPEAR_DELAY_MS, LoadingTracker } from './loading';

describe('LoadingTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function create() {
    let label: string | null = null;
    const tracker = new LoadingTracker((l) => (label = l));
    return { tracker, label: () => label };
  }

  it('never surfaces a wait shorter than the anti-flash delay', () => {
    const { tracker, label } = create();
    const done = tracker.begin('Opening a.ora…');
    vi.advanceTimersByTime(LOADING_APPEAR_DELAY_MS - 1);
    expect(label()).toBeNull();
    done();
    vi.runAllTimers();
    expect(label()).toBeNull();
  });

  it('surfaces the label once a wait outlives the delay and clears it on dispose', () => {
    const { tracker, label } = create();
    const done = tracker.begin('Opening a.ora…');
    vi.advanceTimersByTime(LOADING_APPEAR_DELAY_MS);
    expect(label()).toBe('Opening a.ora…');
    done();
    expect(label()).toBeNull();
  });

  it('can surface a user-initiated wait immediately', () => {
    const { tracker, label } = create();
    const done = tracker.begin('Saving example.ora…', { immediate: true });
    expect(label()).toBe('Saving example.ora…');
    done();
    expect(label()).toBeNull();
  });

  it('shows the most recent visible wait when waits overlap', () => {
    const { tracker, label } = create();
    const doneOuter = tracker.begin('Importing images…');
    vi.advanceTimersByTime(LOADING_APPEAR_DELAY_MS);
    const doneInner = tracker.begin('Loading project…');
    expect(label()).toBe('Importing images…');
    vi.advanceTimersByTime(LOADING_APPEAR_DELAY_MS);
    expect(label()).toBe('Loading project…');
    doneInner();
    expect(label()).toBe('Importing images…');
    doneOuter();
    expect(label()).toBeNull();
  });

  it('falls back to an older visible wait when the newest never becomes visible', () => {
    const { tracker, label } = create();
    const doneOuter = tracker.begin('Importing images…');
    vi.advanceTimersByTime(LOADING_APPEAR_DELAY_MS);
    const doneInner = tracker.begin('Loading project…');
    vi.advanceTimersByTime(LOADING_APPEAR_DELAY_MS - 1);
    doneInner();
    expect(label()).toBe('Importing images…');
    doneOuter();
    expect(label()).toBeNull();
  });

  it('ignores a disposer called twice', () => {
    const { tracker, label } = create();
    const doneFirst = tracker.begin('Opening a.ora…');
    vi.advanceTimersByTime(LOADING_APPEAR_DELAY_MS);
    tracker.begin('Opening b.ora…');
    vi.advanceTimersByTime(LOADING_APPEAR_DELAY_MS);
    doneFirst();
    doneFirst();
    expect(label()).toBe('Opening b.ora…');
  });
});
