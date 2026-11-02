import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGuardianLoop } from '../src/cli/fleet-guardian-loop.js';
import { repeatGuardianDrains, type GuardianRepeatDrain, type GuardianRepeatOptions, type GuardianRepeatPass } from '../src/core/fleet/guardian-repeat.js';
import type { GuardianDrainSummary } from '../src/core/fleet/guardian-retry-drain.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const temp = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), 'guardian-idle-')); dirs.push(d); return d; };
const base = (dir: string): GuardianRepeatOptions => ({ manifest: join(dir, 'manifest'), sourceState: join(dir, 'source'), outputDir: join(dir, 'out'), durationMs: 20000, intervalMs: 1000, maxRetries: 2, timeoutMs: 10000, apply: true });
const result = (termination: GuardianDrainSummary['termination'] = 'no-work', latestOutput: string | null = null): GuardianDrainSummary => ({ mode: 'apply', termination, attempts: latestOutput ? 1 : 0, verified: latestOutput ? 1 : 0, refused: 0, attempted: [], planned: [], latestOutput });
const clock = () => { let time = 0; return { now: () => time, sleep: vi.fn(async (ms: number) => { time += ms; }) }; };

it('doubles idle delays to the cap, resets after verified work, and never overlaps drains', async () => {
  const dir = await temp(), c = clock(), records: GuardianRepeatPass[] = [], starts: number[] = [], sources: string[] = [];
  let active = 0;
  const drain: GuardianRepeatDrain = async request => {
    expect(++active).toBe(1); starts.push(c.now()); sources.push(request.sourceState);
    await Promise.resolve(); active--;
    return { summary: starts.length === 4 ? result('drained', join(dir, 'verified')) : result(), session: null };
  };
  const out = await repeatGuardianDrains({ ...base(dir), durationMs: 16000, idleBackoffMaxMs: 4000 }, { drain, now: c.now, sleep: c.sleep, onPass: r => { records.push(r); } });
  expect(starts).toEqual([0, 2000, 6000, 10000, 11000, 13000]);
  expect(records.map(r => [r.consecutiveIdle, r.nextDelayMs])).toEqual([[1, 2000], [2, 4000], [3, 4000], [0, 1000], [1, 2000], [2, 4000]]);
  expect(sources[4]).toBe(join(dir, 'verified'));
  expect(out.termination).toBe('duration');
});

it('keeps default cadence and records unchanged, with deadlines bounded by remaining time', async () => {
  const dir = await temp(), c = clock(), records: GuardianRepeatPass[] = [], timeouts: number[] = [];
  const drain: GuardianRepeatDrain = async r => { timeouts.push(r.timeoutMs); return { summary: result(), session: null }; };
  const out = await repeatGuardianDrains({ ...base(dir), durationMs: 3500 }, { drain, now: c.now, sleep: c.sleep, onPass: r => { records.push(r); } });
  expect(timeouts).toEqual([3500, 2500, 1500, 500]);
  expect(c.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000, 1000]);
  expect(records.every(r => !('consecutiveIdle' in r) && !('nextDelayMs' in r))).toBe(true);
  expect(out.passes).toBe(4);
});

it.each(['stopped', 'cancelled'] as const)('interrupts a long backoff on %s', async kind => {
  const dir = await temp(), c = clock(), controller = new AbortController(), stopFile = join(dir, 'stop');
  const drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: result(), session: null }));
  const sleep = vi.fn(async (ms: number) => { await c.sleep(ms); if (kind === 'stopped') await writeFile(stopFile, ''); else controller.abort(); });
  const out = await repeatGuardianDrains({ ...base(dir), intervalMs: 5000, idleBackoffMaxMs: 20000, stopFile, signal: controller.signal }, { drain, now: c.now, sleep });
  expect(out.termination).toBe(kind); expect(drain).toHaveBeenCalledTimes(1); expect(c.now()).toBe(1000);
});

it.each(['refused', 'unsafe', 'cancelled'] as const)('does not wait after %s', async termination => {
  const dir = await temp(), c = clock();
  const out = await repeatGuardianDrains({ ...base(dir), idleBackoffMaxMs: 4000 }, { drain: async () => ({ summary: result(termination), session: null }), now: c.now, sleep: c.sleep });
  expect(out.termination).toBe(termination); expect(c.sleep).not.toHaveBeenCalled();
});

it('validates CLI cap before draining and streams opt-in progress', async () => {
  const dir = await temp(), c = clock(), lines: string[] = [];
  const args = ['--manifest', join(dir, 'manifest'), '--source-state', join(dir, 'source'), '--output-dir', join(dir, 'out'), '--duration-ms', '7000', '--interval-ms', '1000', '--max-retries', '2', '--timeout-ms', '5000', '--apply', '--stream'];
  const drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: result(), session: null }));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const cap of ['999', '86400001', '9007199254740992', '0', '1.5']) {
    expect(await cmdFleetGuardianLoop([...args, '--idle-backoff-max-ms', cap], { drain })).toBe(2);
  }
  expect(drain).not.toHaveBeenCalled();
  expect(await cmdFleetGuardianLoop([...args, '--idle-backoff-max-ms', '4000'], { drain, now: c.now, sleep: c.sleep, writeLine: line => { lines.push(line); } })).toBe(0);
  const records = lines.map(line => JSON.parse(line) as { record: string; consecutiveIdle?: number; nextDelayMs?: number });
  expect(records.filter(r => r.record === 'pass').map(r => [r.consecutiveIdle, r.nextDelayMs])).toEqual([[1, 2000], [2, 4000], [3, 4000]]);
  expect(records.at(-1)?.record).toBe('summary');
});

it('rejects an invalid core cap before draining', async () => {
  const dir = await temp(), drain = vi.fn<GuardianRepeatDrain>();
  await expect(repeatGuardianDrains({ ...base(dir), idleBackoffMaxMs: 999 }, { drain })).rejects.toThrow(RangeError);
  expect(drain).not.toHaveBeenCalled();
});
