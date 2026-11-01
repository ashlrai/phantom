import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetLaneReward } from '../src/cli/fleet-lane-reward.js';
import { defaultLaneRewardDeps, foldLaneRewardAttempts, readLaneReward, type LaneRewardDeps }
  from '../src/core/fleet/lane-reward.js';
import { inspectOneAskReward } from '../src/core/fleet/one-ask-reward.js';
import type { Proposal } from '../src/core/types.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
/** Plainly fake fixture ids and urls; none exist on any real host. */
const URL = (n: number) => `https://github.com/fake-org/fake-repo/pull/${n}`;
const rows = (...values: Record<string, unknown>[]): string => values.map(v => JSON.stringify(v)).join('\n') + '\n';
const read = (text: string | null) => async () => text;
const deps = (partial: Partial<LaneRewardDeps> = {}): Partial<LaneRewardDeps> =>
  ({ proposal: () => null, nowMs: () => NOW, ...partial });

async function run(args: string[], partial: Partial<LaneRewardDeps> = {}) {
  let out = '', err = '';
  const stdout = process.stdout.write, stderr = process.stderr.write;
  process.stdout.write = ((c: unknown) => { out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { err += String(c); return true; }) as typeof process.stderr.write;
  try { return { code: await cmdFleetLaneReward(args, deps(partial)), out, err }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

let home: string | undefined;
afterEach(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }); });

describe('fleet lane-reward', () => {
  it('folds lifecycle rows into per-lane scored and unscored attempts', async () => {
    const text = rows(
      { event: 'launch', job: 'RQ-FAKE-A1', lane: 'lane-a' },
      { event: 'finish', job: 'RQ-FAKE-A1', lane: 'lane-a', tokens_total: 1200 },
      { event: 'publish', job: 'RQ-FAKE-A1', lane: 'lane-a', url: URL(1) },
      { event: 'finish', job: 'RQ-FAKE-A2', lane: 'lane-a', tokens_total: 800 },
      { event: 'outcome', job: 'RQ-FAKE-A2', lane: 'lane-a', state: 'MERGED', ttm_s: 600, ts: '2026-10-31T04:00:00Z' },
      { event: 'launch', job: 'RQ-FAKE-A3', lane: 'lane-a' },
      { event: 'finish', job: 'RQ-FAKE-B1', lane: 'lane-b' },
      { event: 'publish', job: 'RQ-FAKE-B1', lane: 'lane-b', url: URL(2) },
      { event: 'finish', job: 'RQ-FAKE-B2', lane: 'lane-b', tokens_total: 500 },
      { event: 'publish', job: 'RQ-FAKE-B2', lane: 'lane-b', url: URL(3) },
      { event: 'precheck_skip', job: 'RQ-FAKE-B9', lane: 'lane-b' },
    );
    const report = await readLaneReward({ deps: deps({ jobsText: read(text) }) });
    expect(report).toMatchObject({ schema: 'fleet.lane-reward.v1', source: 'healthy', weight: 1,
      attempts: 5, scored: 2, unscored: 3, meanReward: 0 });
    expect(report.lanes.map(lane => lane.lane)).toEqual(['lane-a', 'lane-b']);
    expect(report.lanes[0]).toMatchObject({ attempts: 3, scored: 1, unscored: 2, meanReward: 0,
      outcomes: { published: 1, stable: 0, reverted: 0 },
      reasons: { 'proposal-unavailable': 1, unresolved: 1 } });
    expect(report.lanes[1]).toMatchObject({ attempts: 2, scored: 1, unscored: 1, meanReward: 0,
      reasons: { 'invalid-usage': 1 } });
  });

  it('scores merged attempts through the inspector using the trusted proposal', async () => {
    const proposal = { id: 'RQ-FAKE-M1', repo: '/fake/repo', status: 'applied' } as Proposal;
    const seen: unknown[] = [];
    const report = await readLaneReward({
      deps: deps({
        jobsText: read(rows(
          { event: 'finish', job: 'RQ-FAKE-M1', lane: 'lane-a', tokens_total: 2000 },
          { event: 'publish', job: 'RQ-FAKE-M1', lane: 'lane-a', url: URL(4) },
          { event: 'outcome', job: 'RQ-FAKE-M1', lane: 'lane-a', state: 'MERGED', ttm_s: 900, ts: '2026-10-31T05:00:00Z' },
        )),
        proposal: id => (id === 'RQ-FAKE-M1' ? proposal : null),
        score: input => {
          seen.push(input);
          return input.outcome.kind === 'merged' && input.outcome.proposal === proposal
            ? { state: 'scored', outcome: 'stable', rewardPerToken: 0.0025 }
            : { state: 'unknown', reason: 'no-authenticated-merge' };
        },
      }),
    });
    expect(seen).toHaveLength(1);
    expect(report.lanes[0]).toMatchObject({ attempts: 1, scored: 1, unscored: 0,
      meanReward: 0.0025, outcomes: { published: 0, stable: 1, reverted: 0 } });
  });

  it('joins url-keyed outcome rows, folds closed as published and lets the latest outcome win', () => {
    const fold = foldLaneRewardAttempts(rows(
      { event: 'finish', job: 'RQ-FAKE-U1', lane: 'lane-a', tokens_total: 100 },
      { event: 'publish', job: 'RQ-FAKE-U1', lane: 'lane-a', url: URL(5) },
      { event: 'outcome', url: URL(5), state: 'MERGED', ttm_s: 300, ts: '2026-10-31T07:00:00Z' },
      { event: 'finish', job: 'RQ-FAKE-T1', lane: 'lane-a', tokens_total: 100 },
      { event: 'outcome', job: 'RQ-FAKE-T1', state: 'MERGED', ts: '2026-10-31T07:00:00Z' },
      { event: 'outcome', job: 'RQ-FAKE-T1', state: 'CLOSED', ts: '2026-10-31T08:00:00Z' },
    ));
    expect(fold.attempts.get('RQ-FAKE-U1')).toMatchObject({ lane: 'lane-a', tokens: 100, outcome: 'merged' });
    expect(fold.attempts.get('RQ-FAKE-T1')?.outcome).toBe('closed');
  });

  it('wires the real inspector by default and reports degraded sources', async () => {
    expect(defaultLaneRewardDeps.score).toBe(inspectOneAskReward);
    expect(defaultLaneRewardDeps.score({ outcome: { kind: 'published' }, tokens: 10, weight: 1, nowMs: NOW }))
      .toEqual({ state: 'scored', outcome: 'published', rewardPerToken: 0 });
    const text = rows({ event: 'finish', job: 'RQ-FAKE-D1', lane: 'lane-a', tokens_total: 50 },
      { event: 'publish', job: 'RQ-FAKE-D1', lane: 'lane-a', url: URL(6) }) + 'not json\n[1]\n';
    const report = await readLaneReward({ deps: deps({ jobsText: read(text) }) });
    expect(report).toMatchObject({ source: 'degraded', attempts: 1, scored: 1 });
  });

  it('reads a ledger file through --jobs and prints one line per lane', async () => {
    home = mkdtempSync(join(tmpdir(), 'lane-reward-'));
    const file = join(home, 'jobs.jsonl');
    writeFileSync(file, rows(
      { event: 'finish', job: 'RQ-FAKE-F1', lane: 'lane-a', tokens_total: 640 },
      { event: 'publish', job: 'RQ-FAKE-F1', lane: 'lane-a', url: URL(7) },
      { event: 'finish', job: 'RQ-FAKE-F2', lane: 'lane-b', tokens_total: 320 },
      { event: 'outcome', job: 'RQ-FAKE-F2', lane: 'lane-b', state: 'CLOSED', ttm_s: 40, ts: '2026-10-31T09:00:00Z' },
    ));
    const human = await run(['--jobs', file]);
    expect(human).toMatchObject({ code: 0, err: '' });
    expect(human.out).toContain('fleet lane-reward: 2 attempts, 2 scored, 0 unscored, mean reward 0.000000');
    expect(human.out).toContain('lane-a: 1 attempts, 1 scored, 0 unscored, mean reward 0.000000');
    const json = await run(['--jobs', file, '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'fleet.lane-reward.v1',
      lanes: [{ lane: 'lane-a' }, { lane: 'lane-b' }] });
  });

  it('reports a missing ledger and rejects bad arguments', async () => {
    const json = await run(['--jobs', '/nonexistent/fake-jobs.jsonl', '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ source: 'missing', lanes: [] });
    const human = await run(['--jobs', '/nonexistent/fake-jobs.jsonl']);
    expect(human).toMatchObject({ code: 1, out: '', err: 'error: jobs ledger unavailable\n' });
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: phm fleet lane-reward');
    expect(help.out).toContain('Observation only');
    for (const args of [['--bogus'], ['--jobs'], ['--jobs', '--json'], ['--jobs', 'a', '--jobs', 'b']])
      expect((await run(args)).code).toBe(2);
  });
});
