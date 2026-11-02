/** RQ-PHX-SELFTICKAWAIT02SOLE2 — `ashlr fleet self-tick-await`: bounded
 * read-only polling of queue/self-tick-last.json proving a newly completed
 * apply pass ran after --after. Exported CLI, real temp files, fake clock. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTickAwait } from '../src/cli/fleet-self-tick-await.js';
import {
  readSelfTickLast, SELF_TICK_LAST, writeSelfTickLast, type SelfTickLastView,
} from '../src/core/fleet/self-tick-last.js';
import type { SelfTickStepName } from '../src/core/fleet/self-tick.js';

const AFTER = '2026-11-01T18:00:00.000Z';
const AFTER_MS = Date.parse(AFTER);
const T0 = Date.parse('2026-11-01T18:05:00.000Z');
const STEPS: readonly SelfTickStepName[] = ['claude-quota', 'reset-release', 'lane-autohold', 'planner-tick'];
const iso = (ms: number) => new Date(ms).toISOString();

let runsDir: string, now: number, onSleep: (() => void) | null;
let out: string[], err: string[], sleeps: number[];
let reads: number, inflight: number, maxInflight: number;

const lastPath = () => join(runsDir, SELF_TICK_LAST);
const writeRecord = (at: string, mode: 'apply' | 'dry-run', state: 'ran' | 'busy', failed: readonly string[] = []) =>
  writeSelfTickLast(runsDir, {
    v: 1, at, mode, state,
    steps: state === 'busy' ? [] : STEPS.map((step) => ({
      step, state: (failed.includes(step) ? 'failed' : 'ok') as 'ok' | 'failed',
      exitCode: failed.includes(step) ? 1 : 0, report: null,
    })),
  });
/** Counting read seam over the real reader; proves serialized file reads. */
const read = async (dir: string, at: number): Promise<SelfTickLastView | null> => {
  reads += 1; inflight += 1; maxInflight = Math.max(maxInflight, inflight);
  await Promise.resolve();
  inflight -= 1;
  return readSelfTickLast(dir, at);
};
/** Fake sleep: records the capped duration, advances the clock, then the tick lands. */
const sleep = async (ms: number) => { sleeps.push(ms); now += ms; onSleep?.(); };
type Deps = NonNullable<Parameters<typeof cmdFleetSelfTickAwait>[1]>;
const args = (timeout = '1000', interval = '300') =>
  ['--runs-dir', runsDir, '--after', AFTER, '--timeout-ms', timeout, '--interval-ms', interval, '--json'];
const run = (argv: string[], deps: Deps = {}) =>
  cmdFleetSelfTickAwait(argv, { now: () => now, sleep, read,
    output: (t) => out.push(t), error: (t) => err.push(t), ...deps });
const report = () => JSON.parse(out.at(-1)!) as {
  outcome: string; polls: number; waitedMs: number; deadlineAt: string;
  lastObservation: { state: string; mode?: string; ranState?: string;
    newerThanAfter?: boolean; futureDated?: boolean; failedSteps?: string[] } | null;
};

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'self-tick-await-02-'));
  now = T0; out = []; err = []; sleeps = [];
  reads = 0; inflight = 0; maxInflight = 0; onSleep = null;
});
afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

describe('fleet self-tick-await', () => {
  it('ignores an old success, then succeeds on a new apply pass (default reader)', async () => {
    writeRecord(iso(AFTER_MS - 60_000), 'apply', 'ran');
    onSleep = () => writeRecord(iso(now), 'apply', 'ran');
    expect(await run(args(), { read: undefined })).toBe(0);
    expect(report()).toMatchObject({ outcome: 'succeeded', polls: 2,
      lastObservation: { state: 'seen', mode: 'apply', ranState: 'ran', failedSteps: [] } });
    expect(sleeps).toEqual([300]);
  });

  it('fails promptly on a new apply pass with failed steps, naming them', async () => {
    onSleep = () => writeRecord(iso(now), 'apply', 'ran', ['planner-tick']);
    expect(await run(args())).toBe(1);
    expect(report()).toMatchObject({ outcome: 'failed', polls: 2,
      lastObservation: { failedSteps: ['planner-tick'] } });
    expect(sleeps).toEqual([300]); // returned immediately after the failed record
    // The human surface carries the same verdict for a non-JSON caller.
    out = []; now = T0; onSleep = null;
    expect(await run(args().filter((a) => a !== '--json'))).toBe(1);
    expect(out[0]).toContain('FAILED');
    expect(out[0]).toContain('planner-tick');
    expect(err).toEqual([]);
  });

  it.each<[mode: 'apply' | 'dry-run', state: 'ran' | 'busy', failed: string[]]>([
    ['dry-run', 'ran', []],
    ['dry-run', 'ran', ['planner-tick']],
    ['apply', 'busy', []],
  ])('a new %s/%s record never satisfies', async (mode, state, failed) => {
    writeRecord(iso(now), mode, state, failed);
    expect(await run(args())).toBe(3);
    expect(report()).toMatchObject({ outcome: 'timed-out',
      lastObservation: { state: 'seen', mode, ranState: state, newerThanAfter: true, futureDated: false } });
  });

  it('an apply success at --after or future-dated never satisfies', async () => {
    writeRecord(iso(AFTER_MS), 'apply', 'ran'); // equal is not strictly newer
    expect(await run(args())).toBe(3);
    expect(report().lastObservation).toMatchObject({ state: 'seen', newerThanAfter: false });
    writeRecord(iso(now + 60_000), 'apply', 'ran'); // future-dated is not evidence
    out = [];
    expect(await run(args())).toBe(3);
    expect(report().lastObservation).toMatchObject({ state: 'seen', futureDated: true });
  });

  it('missing and corrupt records time out, reads never overlap', async () => {
    expect(await run(args())).toBe(3);
    expect(report().lastObservation).toMatchObject({ state: 'missing' });
    mkdirSync(dirname(lastPath()), { recursive: true });
    writeFileSync(lastPath(), '{not-json');
    out = [];
    expect(await run(args())).toBe(3);
    expect(report().lastObservation).toMatchObject({ state: 'unreadable' });
    expect(reads).toBeGreaterThan(1);
    expect(maxInflight).toBe(1);
  });

  it('interrupts promptly during a wait, with listeners attached only while waiting', async () => {
    const controller = new AbortController();
    const sigintBefore = process.listenerCount('SIGINT'), sigtermBefore = process.listenerCount('SIGTERM');
    let sigintDuring = 0;
    onSleep = () => { sigintDuring = process.listenerCount('SIGINT'); controller.abort(); };
    expect(await run(args(), { signal: controller.signal })).toBe(130);
    expect(report()).toMatchObject({ outcome: 'interrupted', lastObservation: { state: 'missing' } });
    expect(sigintDuring).toBe(sigintBefore + 1);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('caps each sleep at the remaining deadline and lands exactly on it', async () => {
    writeRecord(iso(now), 'dry-run', 'ran'); // new but never satisfying
    expect(await run(args('1000', '600'))).toBe(3);
    expect(report()).toMatchObject({ outcome: 'timed-out', polls: 2, waitedMs: 1000, deadlineAt: iso(T0 + 1000) });
    expect(sleeps).toEqual([600, 400]); // second sleep capped to remaining
  });

  it('--help prints usage and the exit-code contract with zero reads', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(reads).toBe(0);
    expect(out[0]).toMatch(/Usage: ashlr fleet self-tick-await[\s\S]*130 interrupted/);
  });

  it.each<[string[]]>([
    [[]],
    [['--runs-dir', 'relative', '--after', AFTER, '--timeout-ms', '1000']],
    [['--runs-dir']],
    [['--after', 'not-a-date', '--runs-dir', '/tmp/x', '--timeout-ms', '1000']],
    [['--after', AFTER, '--runs-dir', '/tmp/x', '--timeout-ms', '0']],
    [['--after', AFTER, '--runs-dir', '/tmp/x', '--timeout-ms', '1000', '--interval-ms', '60001']],
    [['--after', AFTER, '--runs-dir', '/tmp/x', '--timeout-ms', '1000', '--after', AFTER]],
    [['--after', AFTER, '--runs-dir', '/tmp/x', '--timeout-ms', '1000', '--json', '--json']],
    [['--after', AFTER, '--runs-dir', '/tmp/x', '--timeout-ms', '1000', '--bogus']],
    [['--after', AFTER, '--runs-dir', '/tmp/x']],
  ])('rejects invalid arguments %j before any record read', async (bad) => {
    expect(await run(bad)).toBe(2);
    expect(reads).toBe(0);
    expect(err.at(-1)).toContain('Usage: ashlr fleet self-tick-await');
  });
});
