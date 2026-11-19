import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdRouter } from '../src/cli/router.js';
import { tuneRouterWeights } from '../src/core/router/tune.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

function runsDir(jobs?: string, market?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'router-tune-'));
  roots.push(root);
  mkdirSync(join(root, 'metrics'), { recursive: true });
  if (jobs !== undefined) writeFileSync(join(root, 'metrics', 'jobs.jsonl'), jobs);
  if (market !== undefined) writeFileSync(join(root, 'metrics', 'work-market.jsonl'), market);
  return root;
}

const NOW = new Date('2026-11-18T12:00:00.000Z');

function job(id: string, lane: string | null, merged: boolean | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    job: id, ...(lane === null ? {} : { lane }),
    phase: merged === null ? 'RUNNING' : merged ? 'MERGED' : 'CLOSED',
    ts: '2026-11-17T00:00:00Z', ...extra,
  });
}

function decision(jobId: string, workClass: string, chosenLane: string | null): string {
  return JSON.stringify({
    schema: 'work-market.v1', event: 'route_decision', job: jobId,
    chosen_lane: chosenLane, work_class: workClass,
    ts: '2026-11-16T00:00:00Z',
  });
}

/** n jobs on one lane, `merged` of them merged. */
function cohortJobs(prefix: string, lane: string, n: number, merged: number): string[] {
  return Array.from({ length: n }, (_, i) => job(`${prefix}${i}`, lane, i < merged));
}

describe('tuneRouterWeights', () => {
  it('proposes bounded weights from per-(work_class, lane) merge rates', async () => {
    // bulk: lane-a 8/10, lane-b 7/10, lane-c 6/10 -> pool 21/30 = 0.7
    const ids = [
      ...Array.from({ length: 10 }, (_, i) => `a${i}`),
      ...Array.from({ length: 10 }, (_, i) => `b${i}`),
      ...Array.from({ length: 10 }, (_, i) => `c${i}`),
    ];
    const jobs = [
      ...cohortJobs('a', 'lane-a', 10, 8),
      ...cohortJobs('b', 'lane-b', 10, 7),
      ...cohortJobs('c', 'lane-c', 10, 6),
    ].join('\n');
    const market = ids.map((j) => decision(j, 'bulk', null)).join('\n');
    const root = runsDir(jobs, market);
    const report = await tuneRouterWeights({ runsDir: root, minSample: 5, maxShift: 0.5, now: NOW });
    expect(report.schema).toBe('router.tune.report.v1');
    expect(report.advisory).toBe(true);
    expect(report.inputs.outcomes.state).toBe('read');
    expect(report.inputs.work_market.state).toBe('read');
    expect(report.inputs.work_market.route_decision_rows).toBe(30);
    const byLane = Object.fromEntries(report.cohorts.map((c) => [c.lane, c]));
    expect(byLane['lane-a']).toMatchObject({ work_class: 'bulk', attempts: 10, resolved: 10, merged: 8, merge_rate: 0.8, pool_merge_rate: 0.7, status: 'proposed' });
    expect(byLane['lane-a']!.weight).toBeCloseTo(0.8 / 0.7, 5);
    expect(byLane['lane-b']!.weight).toBeCloseTo(1, 5);
    expect(byLane['lane-c']!.weight).toBeCloseTo(0.6 / 0.7, 5);
    expect(report.weights).toHaveLength(3);
    expect(report.weights.every((w) => w.schema === 'router.weights.v1' && w.evidence_n === 10 && w.updated_at === NOW.toISOString())).toBe(true);
    expect(report.applied).toBeNull();
  });

  it('enriches work_class and lane from route_decision rows only as fallback', async () => {
    const jobs = [
      job('J1', null, true), job('J2', 'recorded-lane', false),
    ].join('\n');
    const market = [
      decision('J1', 'judgment', 'market-lane'),
      decision('J2', 'bulk', 'other-lane'),
      // A later decision without chosen_lane keeps the earlier non-null value.
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'J1', chosen_lane: null, work_class: 'standard' }),
    ].join('\n');
    const root = runsDir(jobs, market);
    const report = await tuneRouterWeights({ runsDir: root, minSample: 1, now: NOW });
    const j1 = report.cohorts.find((c) => c.lane === 'market-lane');
    const j2 = report.cohorts.find((c) => c.lane === 'recorded-lane');
    expect(j1).toMatchObject({ work_class: 'standard', merged: 1, resolved: 1 });
    expect(j2).toMatchObject({ work_class: 'bulk', merged: 0, resolved: 1 });
  });

  it('refuses cohorts below the minimum resolved sample and never emits a weight', async () => {
    const jobs = [...cohortJobs('a', 'lane-a', 6, 6), job('s', 'lane-s', false)].join('\n');
    const market = ['a0','a1','a2','a3','a4','a5','s'].map((j) => decision(j, 'bulk', null)).join('\n');
    const root = runsDir(jobs, market);
    const report = await tuneRouterWeights({ runsDir: root, minSample: 5, now: NOW });
    const small = report.cohorts.find((c) => c.lane === 'lane-s');
    expect(small).toMatchObject({ status: 'insufficient-evidence', weight: null, resolved: 1 });
    expect(report.weights.map((w) => w.lane)).toEqual(['lane-a']);
    // lane-a merged 6/6 vs pool 6/7 (lane-s resolved but failed): raw > 1, clamped.
    expect(report.weights[0]!.weight).toBe(1.1);
  });

  it('clamps extreme ratios to the max-shift bound', async () => {
    const jobs = [...cohortJobs('a', 'lane-a', 5, 5), ...cohortJobs('b', 'lane-b', 5, 0)].join('\n');
    const root = runsDir(jobs);
    const report = await tuneRouterWeights({ runsDir: root, minSample: 5, maxShift: 0.1, now: NOW });
    const byLane = Object.fromEntries(report.cohorts.map((c) => [c.lane, c]));
    expect(byLane['lane-a']!.weight).toBe(1.1);
    expect(byLane['lane-b']!.weight).toBe(0.9);
    expect(report.cohorts.every((c) => c.work_class === null)).toBe(true);
  });

  it('refuses weight proposals when the pool merge rate is zero', async () => {
    const jobs = [...cohortJobs('a', 'lane-a', 5, 0), ...cohortJobs('b', 'lane-b', 5, 0)].join('\n');
    const root = runsDir(jobs);
    const report = await tuneRouterWeights({ runsDir: root, minSample: 5, now: NOW });
    expect(report.cohorts.every((c) => c.status === 'zero-pool-merge-rate' && c.weight === null)).toBe(true);
    expect(report.weights).toHaveLength(0);
  });

  it('keeps pending outcomes out of the merge-rate evidence', async () => {
    const jobs = [
      ...cohortJobs('a', 'lane-a', 5, 3),
      job('p1', 'lane-a', null), job('p2', 'lane-a', null),
    ].join('\n');
    const root = runsDir(jobs);
    const report = await tuneRouterWeights({ runsDir: root, minSample: 3, now: NOW });
    const c = report.cohorts[0]!;
    expect(c).toMatchObject({ attempts: 7, resolved: 5, merged: 3, pending: 2, merge_rate: 0.6 });
    // Single lane: cohort IS the pool -> merge_rate == pool_merge_rate -> weight 1.0.
    expect(c.weight).toBe(1);
    expect(c.status).toBe('proposed');
  });

  it('counts outcomes with no attributable lane as unattributed, not zero', async () => {
    const jobs = [job('J1', null, true), job('J2', 'lane-a', true)].join('\n');
    const root = runsDir(jobs);
    const report = await tuneRouterWeights({ runsDir: root, minSample: 1, now: NOW });
    expect(report.unattributed_outcomes).toBe(1);
    expect(report.cohorts).toHaveLength(1);
    expect(report.cohorts[0]!.lane).toBe('lane-a');
  });

  it('reports degraded ledgers as unknown states with empty cohorts', async () => {
    const root = runsDir();
    const report = await tuneRouterWeights({ runsDir: root, now: NOW });
    expect(report.inputs.outcomes.state).toBe('missing');
    expect(report.inputs.work_market.state).toBe('missing');
    expect(report.cohorts).toHaveLength(0);
    expect(report.weights).toHaveLength(0);
    expect(report.unattributed_outcomes).toBe(0);
  });

  it('passes through fold diagnostics from the jobs ledger', async () => {
    const root = runsDir('not json\n' + job('J1', 'lane-a', true), undefined);
    const report = await tuneRouterWeights({ runsDir: root, minSample: 1, now: NOW });
    expect(report.inputs.outcomes).toMatchObject({ state: 'read', malformed_rows: 1, outcomes: 1 });
  });

  it('apply appends deduplicated router.weights.v1 rows and reruns append nothing', async () => {
    const jobs = [...cohortJobs('a', 'lane-a', 5, 5), ...cohortJobs('b', 'lane-b', 5, 0)].join('\n');
    const root = runsDir(jobs);
    const first = await tuneRouterWeights({ runsDir: root, minSample: 5, apply: true, now: NOW });
    expect(first.applied).toMatchObject({ appended: 2, deduplicated: 0, prior_state: 'missing' });
    const path = join(root, 'metrics', 'router-weights.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows.map((r) => r.schema)).toEqual(['router.weights.v1', 'router.weights.v1']);
    expect(rows.find((r) => r.lane === 'lane-a')).toMatchObject({ weight: 1.1, evidence_n: 5, work_class: null });

    const second = await tuneRouterWeights({ runsDir: root, minSample: 5, apply: true, now: new Date('2026-11-19T00:00:00Z') });
    expect(second.applied).toMatchObject({ appended: 0, deduplicated: 2, prior_state: 'read' });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('apply writes a fresh row when evidence grows', async () => {
    const jobs = [...cohortJobs('a', 'lane-a', 5, 5), ...cohortJobs('b', 'lane-b', 5, 0)].join('\n');
    const root = runsDir(jobs);
    await tuneRouterWeights({ runsDir: root, minSample: 5, apply: true, now: NOW });
    writeFileSync(join(root, 'metrics', 'jobs.jsonl'), jobs + '\n' + job('a5', 'lane-a', false));
    const second = await tuneRouterWeights({ runsDir: root, minSample: 5, apply: true, now: NOW });
    // lane-a still clamps to 1.1 but evidence_n grows 5 -> 6, a new row; lane-b is an exact duplicate.
    expect(second.applied).toMatchObject({ appended: 1, deduplicated: 1, prior_state: 'read' });
    expect(readFileSync(join(root, 'metrics', 'router-weights.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('rejects invalid parameters and relative roots', async () => {
    const root = runsDir();
    await expect(tuneRouterWeights({ runsDir: root, minSample: 0 })).rejects.toThrow(RangeError);
    await expect(tuneRouterWeights({ runsDir: root, maxShift: 0 })).rejects.toThrow(RangeError);
    await expect(tuneRouterWeights({ runsDir: root, maxShift: 1.5 })).rejects.toThrow(RangeError);
    await expect(tuneRouterWeights({ runsDir: 'relative/dir' })).rejects.toThrow(RangeError);
  });
});

describe('phm router tune', () => {
  it('prints the JSON report and exits 0', async () => {
    const root = runsDir([...cohortJobs('a', 'lane-a', 5, 5), ...cohortJobs('b', 'lane-b', 5, 0)].join('\n'));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdRouter(['tune', '--root', root, '--min-sample', '5', '--json']);
    expect(code).toBe(0);
    const out = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(out.schema).toBe('router.tune.report.v1');
    expect(out.weights).toHaveLength(2);
  });

  it('exits 2 on bad flags and relative roots', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdRouter(['tune', '--bogus'])).toBe(2);
    expect(await cmdRouter(['tune', '--root', 'relative'])).toBe(2);
    expect(err).toHaveBeenCalled();
  });

  it('help lists the tune usage under router --help', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdRouter(['--help'])).toBe(0);
    expect(spy.mock.calls[0]![0] as string).toContain('router tune');
  });
});
