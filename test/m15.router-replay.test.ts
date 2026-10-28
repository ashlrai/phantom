/** Hermetic replay of the seat router, following M15's deterministic test style. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatReplaySummary, replayRouter, type ReplayJob, type ReplayStatus } from './helpers/router-replay.js';

function fixture() {
  const jobs: ReplayJob[] = readFileSync(new URL('./fixtures/router-replay/jobs.jsonl', import.meta.url), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line) as ReplayJob);
  const status: ReplayStatus = JSON.parse(readFileSync(new URL('./fixtures/router-replay/status.json', import.meta.url), 'utf8'));
  return { jobs, status };
}

// Throw on accidental writes to any nested replay input, including router inputs.
function freeze(value: object): void {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
}

describe('offline seat router replay', () => {
  it('replays every recorded lane and prints the measured outcome summary', () => {
    const { jobs, status } = fixture();
    freeze(jobs);
    freeze(status);
    const report = replayRouter(jobs, status);
    console.log(formatReplaySummary(report));
    expect(report.matches).toBe(11);
    expect(report.mismatches).toEqual([]);
    expect(report.decisions.map(d => [d.id, d.replayLane])).toEqual([
      ['free-first', 'local:fixture'], ['context-fit', 'codex-personal'],
      ['failed-attempt', 'local:fixture'], ['closed-pr', 'local:fixture'],
      ['spent', null], ['unknown', null], ['stale', null],
      ['stable-tie', 'local:second'], ['missing-usage', 'local:fixture'],
      ['unfinished', 'local:fixture'], ['interactive-reserve', 'codex-personal'],
    ]);
    expect(report.actual).toEqual({ jobs: 6, merged: 4, tokens: 20000, mergedPrPerToken: 0.0002 });
    expect(report.matched).toEqual(report.actual);
    expect(report.byActualLane).toEqual([
      { lane: 'local:fixture', jobs: 3, merged: 1, tokens: 7000, mergedPrPerToken: 1 / 7000 },
      { lane: 'codex-personal', jobs: 2, merged: 2, tokens: 11000, mergedPrPerToken: 2 / 11000 },
      { lane: null, jobs: 0, merged: 0, tokens: 0, mergedPrPerToken: null },
      { lane: 'local:second', jobs: 1, merged: 1, tokens: 2000, mergedPrPerToken: 0.0005 },
    ]);
    expect(replayRouter(jobs, status)).toEqual(report);
  });

  it('reports a changed lane without claiming its recorded success for the new lane', () => {
    const { jobs, status } = fixture();
    status.snapshots.normal!.capacities.find(s => s.free)!.reachable = false;
    const report = replayRouter(jobs, status);
    expect(report.matches).toBe(6);
    expect(report.mismatches.map(d => d.id)).toEqual([
      'free-first', 'failed-attempt', 'closed-pr', 'missing-usage', 'unfinished',
    ]);
    expect(report.actual.mergedPrPerToken).toBe(0.0002);
    expect(report.matched).toEqual({ jobs: 3, merged: 3, tokens: 13000, mergedPrPerToken: 3 / 13000 });
    expect(formatReplaySummary(report)).toContain('free-first: actual=local:fixture, replay=codex-personal');
    expect(formatReplaySummary(report)).toContain('Changed lanes have unknown outcomes');
  });

  it('detects a changed held decision', () => {
    const { jobs, status } = fixture();
    status.snapshots.spent!.capacities[0]!.windows[0]!.usedPercent = 10;
    expect(replayRouter(jobs, status).mismatches).toEqual([
      { id: 'spent', actualLane: null, replayLane: 'codex-personal', matches: false },
    ]);
  });

  it('keeps zero and absent denominators unknown and weights totals rather than averaging ratios', () => {
    const { jobs, status } = fixture();
    expect(replayRouter([], status).actual.mergedPrPerToken).toBeNull();
    const single = { ...jobs[0]!, tokens: 0 };
    expect(replayRouter([single], status).actual.mergedPrPerToken).toBeNull();
    single.tokens = 1000;
    expect(replayRouter([single, jobs[1]!], status).actual.mergedPrPerToken).toBe(2 / 4000);
    expect(formatReplaySummary(replayRouter([], status))).toContain('merged-PR-per-token=unknown');
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid measured tokens: %s', tokens => {
    const { jobs, status } = fixture();
    expect(() => replayRouter([{ ...jobs[0]!, tokens }], status)).toThrow('Invalid token count');
  });

  it('refuses ambiguous joins and inconsistent outcomes', () => {
    const { jobs, status } = fixture();
    expect(() => replayRouter([jobs[0]!, jobs[0]!], status)).toThrow('Duplicate or empty job id');
    expect(() => replayRouter([{ ...jobs[0]!, snapshotId: 'missing' }], status)).toThrow('Invalid snapshot');
    expect(() => replayRouter([{ ...jobs[0]!, snapshotId: '__proto__' }], status)).toThrow('Invalid snapshot');
    expect(() => replayRouter([{ ...jobs[0]!, actualLane: 'absent' }], status)).toThrow('Unknown actual lane');
    expect(() => replayRouter([{ ...jobs[0]!, actualLane: null }], status)).toThrow('Inconsistent held outcome');
    status.snapshots.normal!.capacities.push(status.snapshots.normal!.capacities[0]!);
    expect(() => replayRouter(jobs, status)).toThrow('Duplicate seat');
  });
});
