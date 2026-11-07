import { expect, it, describe } from 'vitest';
import { formatWindowTitle } from './window-title.js';

const fullBadge = { workers: 24, merges: 7, switchesOn: [] as string[], paused: false, heldLanes: [] as string[], lanes: [] as Array<{ lane: string; short: string; running: number; target: number; held: boolean }>, personalPct: null };

describe('formatWindowTitle personalPct', () => {
  it('appends personal 92% when personalPct is 92', () => {
    const title = formatWindowTitle({ badge: { ...fullBadge, personalPct: 92 } });
    expect(title).toMatch(/personal 92%$/);
  });

  it('does not append personal when personalPct is 89', () => {
    const title = formatWindowTitle({ badge: { ...fullBadge, personalPct: 89 } });
    expect(title).not.toMatch(/personal/);
  });

  it('does not append personal when personalPct is missing (null)', () => {
    const title = formatWindowTitle({ badge: { ...fullBadge, personalPct: null } });
    expect(title).not.toMatch(/personal/);
  });

  it('does not append personal when paused even if personalPct is 95', () => {
    const title = formatWindowTitle({ badge: { ...fullBadge, paused: true, workers: 0, personalPct: 95 } });
    expect(title).not.toMatch(/personal/);
  });
});
