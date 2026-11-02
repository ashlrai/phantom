import { describe, expect, it } from 'vitest';
import { deriveNeedsMasonNeedsYou } from './needs-mason-needs-you.js';
import type { NeedsMasonRead, NeedsMasonResult } from './needs-mason-query.js';

const read = (data: NeedsMasonRead): NeedsMasonResult => ({ kind: 'available', data });
const item = { id: 'abcdef012345', text: 'fake open step' };

describe('needs-mason needs you', () => {
  it('shows one attention row per open line', () => {
    expect(deriveNeedsMasonNeedsYou(read({ v: 1, state: 'ok', items: [item] }))).toEqual([{
      id: 'needs-mason-abcdef012345', severity: 'attention', target: 'fleet',
      title: 'fake open step', detail: 'Only you can do this step.',
      nextStep: 'Open ~/.ashlr-runs/NEEDS-MASON.md and tick the line when done',
    }]);
  });

  it('keeps every open line in file order', () => {
    const items = deriveNeedsMasonNeedsYou(read({ v: 1, state: 'ok', items: [item, { id: 'ffffeeeedddd', text: 'fake second' }] }));
    expect(items.map(row => row.id)).toEqual(['needs-mason-abcdef012345', 'needs-mason-ffffeeeedddd']);
  });

  it('returns nothing when the file is absent', () => {
    expect(deriveNeedsMasonNeedsYou(read({ v: 1, state: 'absent', items: [] }))).toEqual([]);
  });

  it('shows one row when the file cannot be read', () => {
    expect(deriveNeedsMasonNeedsYou(read({ v: 1, state: 'unreadable', items: [] }))).toMatchObject([
      { id: 'needs-mason-unreadable', severity: 'attention', title: 'NEEDS-MASON.md could not be read' },
    ]);
  });

  it('returns nothing on a notInBuild or missing read', () => {
    expect(deriveNeedsMasonNeedsYou({ kind: 'notInBuild' })).toEqual([]);
    expect(deriveNeedsMasonNeedsYou(undefined)).toEqual([]);
  });
});
