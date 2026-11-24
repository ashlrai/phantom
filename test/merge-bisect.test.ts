import { describe, expect, it } from 'vitest';
import {
  bisectBatch, bisectFirstBad, etStamp, gateTimeRow, planRedMasterFix, redMasterRow, type RevProbe,
} from '../src/core/fleet/merge-bisect.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');

describe('bisectBatch', () => {
  it('clears an all-green group in one probe', async () => {
    const r = await bisectBatch([1, 2, 3, 4], async () => true);
    expect(r).toMatchObject({ culprits: [], interactions: [], probes: 1 });
    expect(r.cleared).toEqual([1, 2, 3, 4]);
  });

  it('isolates a single bad member and clears the rest', async () => {
    const bad = new Set([3]);
    const r = await bisectBatch([1, 2, 3, 4, 5, 6, 7, 8], async (s) => !s.some((m) => bad.has(m)));
    expect(r.culprits).toEqual([3]);
    expect([...r.cleared].sort()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(r.interactions).toEqual([]);
    expect(r.probes).toBeLessThanOrEqual(8);
  });

  it('isolates two bad members', async () => {
    const bad = new Set([1, 6]);
    const r = await bisectBatch([1, 2, 3, 4, 5, 6], async (s) => !s.some((m) => bad.has(m)));
    expect([...r.culprits].sort()).toEqual([1, 6]);
    expect([...r.cleared].sort()).toEqual([2, 3, 4, 5]);
  });

  it('reports a pairwise interaction instead of blaming a member', async () => {
    const r = await bisectBatch(['a', 'b'], async (s) => !(s.includes('a') && s.includes('b')));
    expect(r.culprits).toEqual([]);
    expect(r.interactions).toEqual([['a', 'b']]);
    expect(r.cleared).toEqual([]);
  });

  it('stops at the probe budget and reports the unresolved set', async () => {
    const r = await bisectBatch([1, 2, 3, 4, 5, 6, 7, 8], async () => false, { maxProbes: 2 });
    expect(r.probes).toBe(2);
    expect(r.interactions.length).toBeGreaterThan(0);
  });
});

describe('bisectFirstBad', () => {
  const run = (n: number, firstBad: number, skips = new Set<number>()) => {
    const window = Array.from({ length: n }, (_, i) => sha(i + 1));
    const seen: string[] = [];
    const probe = async (s: string): Promise<RevProbe> => {
      seen.push(s);
      const i = parseInt(s, 16);
      if (skips.has(i)) return 'skip';
      return i >= firstBad ? 'bad' : 'good';
    };
    return { window, probe, seen };
  };

  it('finds the first bad commit in logarithmic probes', async () => {
    const { window, probe } = run(32, 21);
    const r = await bisectFirstBad(window, probe);
    expect(r.culprit).toBe(sha(21));
    expect(r.probes).toBeLessThanOrEqual(7);
  });

  it('blames the only commit in a one-commit window', async () => {
    const { window, probe } = run(1, 1);
    expect((await bisectFirstBad(window, probe)).culprit).toBe(sha(1));
  });

  it('steps over unbuildable commits', async () => {
    const { window, probe } = run(10, 7, new Set([5, 6]));
    const r = await bisectFirstBad(window, probe);
    expect(r.culprit).toBe(sha(7));
    expect(r.skipped.length).toBeGreaterThan(0);
  });

  it('refuses a culprit when the newest commit probes good', async () => {
    const { window, probe } = run(4, 99);
    const r = await bisectFirstBad(window, probe);
    expect(r).toMatchObject({ culprit: null, reason: 'all-good' });
  });

  it('reports empty and all-skipped windows', async () => {
    expect(await bisectFirstBad([], async () => 'bad')).toMatchObject({ culprit: null, reason: 'window-empty' });
    expect(await bisectFirstBad([sha(1), sha(2)], async () => 'skip')).toMatchObject({ culprit: null, reason: 'all-skipped' });
  });
});

describe('planRedMasterFix', () => {
  const base = { masterRed: true, buildBroken: false, culpritSha: sha(9), culpritPr: 12, existingFixPr: null };
  it('does nothing on green master', () => {
    expect(planRedMasterFix({ ...base, masterRed: false })).toEqual({ kind: 'none', reason: 'master-green' });
  });
  it('waits on an open fix PR instead of opening a second', () => {
    expect(planRedMasterFix({ ...base, existingFixPr: 77 })).toEqual({ kind: 'wait', reason: 'fix-pr-open:77' });
  });
  it('opens a revert PR, pausing merges only when master does not build', () => {
    expect(planRedMasterFix(base)).toMatchObject({ kind: 'open-revert-pr', pauseMerges: false });
    expect(planRedMasterFix({ ...base, buildBroken: true })).toMatchObject({ kind: 'open-revert-pr', pauseMerges: true });
  });
  it('bisects first when the culprit is unknown or malformed', () => {
    expect(planRedMasterFix({ ...base, culpritSha: null })).toEqual({ kind: 'bisect', pauseMerges: false });
    expect(planRedMasterFix({ ...base, culpritSha: 'abc' })).toMatchObject({ kind: 'bisect' });
  });
});

describe('metrics rows', () => {
  const t = Date.UTC(2026, 10, 16, 6, 36, 0); // 01:36 EST
  it('stamps Eastern time', () => {
    expect(etStamp(t)).toBe('2026-11-16 01:36:00 EST');
    expect(etStamp(Date.UTC(2026, 6, 1, 16, 0, 0))).toBe('2026-07-01 12:00:00 EDT');
  });
  it('writes gate-time rows and rejects bad input', () => {
    expect(JSON.parse(gateTimeRow({ atMs: t, pr: 6259, seconds: 51.04 }))).toEqual({ et: '2026-11-16 01:36:00 EST', pr: 6259, seconds: 51 });
    expect(() => gateTimeRow({ atMs: t, pr: -1, seconds: 1 })).toThrow();
  });
  it('writes red-master rows with minutes to fix, nulls while open', () => {
    const fixed = JSON.parse(redMasterRow({ detectedMs: t, culpritSha: sha(1), culpritPr: 5, fixPr: 6, fixedMs: t + 12.5 * 60_000 }));
    expect(fixed).toMatchObject({ detected_et: '2026-11-16 01:36:00 EST', fix_pr: 6, minutes_to_fix: 12.5 });
    const open = JSON.parse(redMasterRow({ detectedMs: t, culpritSha: null, culpritPr: null, fixPr: null, fixedMs: null }));
    expect(open).toMatchObject({ fixed_et: null, minutes_to_fix: null });
  });
});
