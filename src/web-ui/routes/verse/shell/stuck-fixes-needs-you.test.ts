import { describe, expect, it } from 'vitest';
import { deriveStuckFixesNeedsYou } from './stuck-fixes-needs-you.js';
import type { StuckFix, StuckFixesRead } from './stuck-fixes-query.js';

const fix = (over: Partial<StuckFix> = {}): StuckFix => ({ job: 'FIXUP-MAIN-1', repo: 'phantom',
  prUrl: 'https://github.com/ashlrai/phantom/pull/42', publishedAt: '2026-11-04T10:00:00Z', ageMinutes: 30, ...over });
const read = (stuck: StuckFix[], known = true): StuckFixesRead => ({ kind: 'available',
  data: { v: 1, generatedAt: '2026-11-04T11:00:00Z', known, thresholdMinutes: 30, stuck } });

describe('deriveStuckFixesNeedsYou', () => {
  it('gives nothing without an available read', () => {
    expect(deriveStuckFixesNeedsYou(undefined)).toEqual([]);
    expect(deriveStuckFixesNeedsYou({ kind: 'notInBuild' })).toEqual([]);
  });
  it('gives nothing when known is false', () => {
    expect(deriveStuckFixesNeedsYou(read([fix()], false))).toEqual([]);
  });
  it('builds the row', () => {
    expect(deriveStuckFixesNeedsYou(read([fix({ ageMinutes: 45 })]))).toEqual([{
      id: 'stuck-fix-FIXUP-MAIN-1', severity: 'attention', target: 'fleet',
      title: 'phantom fix PR stuck 45 min', detail: 'FIXUP-MAIN-1 · #42',
      nextStep: 'Check why the guardian fix PR has not merged',
      open: { kind: 'terminal', command: 'ashlr fleet stuck-fixes' },
    }]);
  });
  it('turns urgent at 60 minutes, not 59', () => {
    expect(deriveStuckFixesNeedsYou(read([fix({ ageMinutes: 59 })]))[0]?.severity).toBe('attention');
    expect(deriveStuckFixesNeedsYou(read([fix({ ageMinutes: 60 })]))[0]?.severity).toBe('urgent');
  });
  it('names a missing repo', () => {
    expect(deriveStuckFixesNeedsYou(read([fix({ repo: null })]))[0]?.title).toBe('unknown repo fix PR stuck 30 min');
  });
  it('extracts the PR number from the url', () => {
    const [row] = deriveStuckFixesNeedsYou(read([fix({ prUrl: 'https://github.com/a/b/pull/1234?x=1' })]));
    expect(row?.detail).toBe('FIXUP-MAIN-1 · #1234');
  });
  it('caps at five rows keeping the oldest first', () => {
    const stuck = [10, 70, 20, 90, 30, 80, 40].map(ageMinutes => fix({ job: `J${ageMinutes}`, ageMinutes }));
    expect(deriveStuckFixesNeedsYou(read(stuck)).map(row => row.id))
      .toEqual(['stuck-fix-J90', 'stuck-fix-J80', 'stuck-fix-J70', 'stuck-fix-J40', 'stuck-fix-J30']);
  });
});
