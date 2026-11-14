/**
 * Censored reward: an assignment still unresolved past the horizon is a failed
 * attempt, a younger one stays pending, and merged scoring does not move.
 */
import { describe, expect, it } from 'vitest';
import {
  censorFromConfig,
  learnOutcomes,
  routeLearnedJob,
  type OutcomeCellView,
  type ResourceOffer,
} from '../src/core/routing/outcome-learning.js';

const NOW = Date.parse('2026-11-09T00:00:00.000Z');
const DAY = 24 * 60;

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function assign(job: string, resource: string, model: string, ageMinutes: number): string {
  return `${stamp(NOW - ageMinutes * 60_000)} ASSIGN job=${job} repo=phantom resource=${resource} model=${model} type=code`;
}

function merged(job: string, minutes: number, usage = 2): string {
  return `${stamp(NOW)} OUTCOME job=${job} state=merged usage=${usage} minutes=${minutes}`;
}

/** Lane `claude` opened ten PRs that never merged; lane `devin` merged three. */
function twoLanes(staleAge = 10 * DAY): string {
  const lines: string[] = [];
  for (let i = 0; i < 10; i += 1) lines.push(assign(`rot${i}`, 'claude', 'sonnet', staleAge));
  for (let i = 0; i < 3; i += 1) {
    lines.push(assign(`ship${i}`, 'devin', 'swe-2-max', 3 * DAY));
    lines.push(merged(`ship${i}`, 90));
  }
  return lines.join('\n');
}

function cell(text: string, resource: string, censor?: Parameters<typeof learnOutcomes>[1]): OutcomeCellView | undefined {
  return learnOutcomes(text, censor).cells.find((c) => c.resource === resource);
}

/** Mean of Beta(1 + good merges, 1 + failures), the success posterior routing samples. */
function successMean(c: OutcomeCellView | undefined): number {
  const good = c?.goodMerges ?? 0;
  const attempts = c?.attempts ?? 0;
  return (1 + good) / (2 + attempts);
}

describe('censored reward', () => {
  it('is blind to unmerged PRs without censoring', () => {
    const learning = learnOutcomes(twoLanes());
    expect(learning.cells.map((c) => c.resource)).toEqual(['devin']);
    expect(successMean(cell(twoLanes(), 'claude'))).toBe(0.5);
  });

  it('a lane with 10 stale unmerged PRs loses posterior mass to a lane with 3 merged', () => {
    const censor = { nowMs: NOW, horizonMinutes: 2 * DAY };
    const rot = cell(twoLanes(), 'claude', censor);
    const ship = cell(twoLanes(), 'devin', censor);
    expect(rot).toMatchObject({ attempts: 10, censored: 10, merges: 0, goodMerges: 0 });
    expect(successMean(rot)).toBeCloseTo(1 / 12, 10);
    expect(successMean(ship)).toBeCloseTo(4 / 5, 10);
    expect(successMean(rot)).toBeLessThan(successMean(undefined));
    expect(successMean(rot)).toBeLessThan(successMean(ship));

    const offers: ResourceOffer[] = [
      { resource: 'claude', model: 'sonnet', usageLeftPercent: null, resetAt: null, slots: 1 },
      { resource: 'devin', model: 'swe-2-max', usageLeftPercent: null, resetAt: null, slots: 1 },
    ];
    const job = { id: 'probe', repo: 'phantom', jobType: 'code', priority: 'normal' } as const;
    const route = routeLearnedJob(learnOutcomes(twoLanes(), censor), job, offers, { nowMs: NOW, explore: false });
    expect(route).toMatchObject({ action: 'dispatch', resource: 'devin' });
  });

  it('charges a censored attempt the cell mean usage, never zero', () => {
    const text = [assign('a', 'claude', 'sonnet', 5 * DAY), assign('b', 'claude', 'sonnet', 5 * DAY), assign('c', 'claude', 'sonnet', 5 * DAY),
      merged('c', 30, 6)].join('\n');
    const c = cell(text, 'claude', { nowMs: NOW, horizonMinutes: DAY })!;
    expect(c.attempts).toBe(3);
    expect(c.censored).toBe(2);
    expect(c.meanUsage).toBeCloseTo(6, 10);
  });

  it('uses the fleet mean usage for a cell that never finished a job', () => {
    const text = twoLanes();
    const rot = cell(text, 'claude', { nowMs: NOW, horizonMinutes: DAY })!;
    expect(rot.meanUsage).toBeCloseTo(2, 10);
  });

  it('keeps PRs younger than the horizon pending', () => {
    const text = twoLanes(DAY / 2);
    const learning = learnOutcomes(text, { nowMs: NOW, horizonMinutes: DAY });
    expect(learning.cells.map((c) => c.resource)).toEqual(['devin']);
    expect(learning.finished).toBe(3);
  });

  it('does not change how merged PRs score', () => {
    const plain = cell(twoLanes(), 'devin');
    const censored = cell(twoLanes(), 'devin', { nowMs: NOW, horizonMinutes: DAY });
    expect(censored).toEqual(plain);
    const onlyMerged = twoLanes().split('\n').filter((l) => !l.includes('resource=claude')).join('\n');
    expect(cell(onlyMerged, 'devin', { nowMs: NOW })).toEqual(plain);
  });

  it('lets a late outcome replace the censored attempt', () => {
    const text = `${assign('late', 'claude', 'sonnet', 5 * DAY)}\n${merged('late', 4 * DAY)}`;
    const c = cell(text, 'claude', { nowMs: NOW, horizonMinutes: DAY })!;
    expect(c).toMatchObject({ attempts: 1, censored: 0, merges: 1, goodMerges: 1 });
  });

  it('derives the horizon from twice the p95 time to merge, at least a day', () => {
    const slow = [
      ...Array.from({ length: 20 }, (_, i) => `${assign(`m${i}`, 'devin', 'swe-2-max', 1)}\n${merged(`m${i}`, 3 * DAY)}`),
      assign('pending', 'claude', 'sonnet', 5 * DAY),
      assign('stale', 'claude', 'sonnet', 7 * DAY),
    ].join('\n');
    // p95 is 3 days, so H is 6 days: the 5 day old PR is pending, the 7 day old one is censored.
    expect(cell(slow, 'claude', { nowMs: NOW })).toMatchObject({ attempts: 1, censored: 1 });
    const quick = `${assign('q', 'devin', 'swe-2-max', 1)}\n${merged('q', 10)}\n${assign('old', 'claude', 'sonnet', 1.5 * DAY)}`;
    expect(cell(quick, 'claude', { nowMs: NOW })).toMatchObject({ attempts: 1, censored: 1 });
    const fresh = `${assign('q', 'devin', 'swe-2-max', 1)}\n${merged('q', 10)}\n${assign('young', 'claude', 'sonnet', 0.9 * DAY)}`;
    expect(cell(fresh, 'claude', { nowMs: NOW })).toBeUndefined();
  });

  it('counts a JSON assignment by its ts', () => {
    const row = { event: 'assign', job: 'j1', repo: 'phantom', resource: 'claude', model: 'sonnet', type: 'code', ts: new Date(NOW - 9 * DAY * 60_000).toISOString() };
    expect(cell(JSON.stringify(row), 'claude', { nowMs: NOW, horizonMinutes: DAY })).toMatchObject({ attempts: 1, censored: 1 });
  });

  it('is off unless the router config turns it on', () => {
    expect(censorFromConfig(undefined, NOW)).toBeUndefined();
    expect(censorFromConfig({ censorHorizonHours: 12 }, NOW)).toBeUndefined();
    expect(censorFromConfig({ censorUnmerged: false }, NOW)).toBeUndefined();
    expect(censorFromConfig({ censorUnmerged: true }, NOW)).toEqual({ nowMs: NOW });
    expect(censorFromConfig({ censorUnmerged: true, censorHorizonHours: 12 }, NOW)).toEqual({ nowMs: NOW, horizonMinutes: 720 });
    expect(censorFromConfig({ censorUnmerged: true, censorHorizonHours: -1 }, NOW)).toEqual({ nowMs: NOW });
    expect(censorFromConfig({ censorUnmerged: true, censorHorizonHours: Number.NaN }, NOW)).toEqual({ nowMs: NOW });
  });
});
