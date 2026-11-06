import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { repeatGuardianDrains, type GuardianRepeatDrain, type GuardianRepeatOptions } from '../src/core/fleet/guardian-repeat.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-budget-')); dirs.push(dir);
  const options: GuardianRepeatOptions = { manifest: join(dir, 'manifest'), sourceState: join(dir, 'source'), outputDir: join(dir, 'out'), durationMs: 6000, intervalMs: 3000, maxRetries: 2, timeoutMs: 5000, apply: true };
  const drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: { mode: 'apply', termination: 'no-work', attempts: 0, verified: 0, refused: 0, attempted: [], planned: [], latestOutput: null }, session: null }));
  return { dir, options, drain };
};

it.each([6000, 7000])('stops at or beyond the deadline after one late wake (%i ms)', async wake => {
  const { options, drain } = await setup(); let time = 0;
  const sleep = vi.fn(async () => { time = wake; });
  const out = await repeatGuardianDrains(options, { drain, now: () => time, sleep });
  expect(out).toMatchObject({ termination: 'duration', passes: 1 });
  expect(drain).toHaveBeenCalledTimes(1); expect(sleep).toHaveBeenCalledTimes(1);
  expect(sleep.mock.calls[0]).toEqual([1000, undefined]);
});

it('keeps normal multi-slice intervals and bounds a slice by the remaining duration', async () => {
  const { options, drain } = await setup(); let time = 0;
  const sleep = vi.fn(async (ms: number) => { time += ms === 1000 && time === 0 ? 4500 : ms; });
  const out = await repeatGuardianDrains(options, { drain, now: () => time, sleep });
  expect(out.termination).toBe('duration'); expect(drain).toHaveBeenCalledTimes(1);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000, 500]);
});

it('completes a normal multi-slice interval before the next drain', async () => {
  const { options, drain } = await setup(); let time = 0;
  const sleep = vi.fn(async (ms: number) => { time += ms; });
  const out = await repeatGuardianDrains({ ...options, durationMs: 6500 }, { drain, now: () => time, sleep });
  expect(out).toMatchObject({ termination: 'duration', passes: 3 });
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000, 1000, 1000, 1000, 1000]);
});

it.each(['stopped', 'cancelled'] as const)('responds to %s during a slice', async kind => {
  const { dir, options, drain } = await setup(); const controller = new AbortController();
  const stopFile = join(dir, 'stop'); let time = 0;
  const sleep = vi.fn(async (ms: number) => { time += ms; if (kind === 'stopped') await writeFile(stopFile, ''); else controller.abort(); });
  const out = await repeatGuardianDrains({ ...options, stopFile, signal: controller.signal }, { drain, now: () => time, sleep });
  expect(out.termination).toBe(kind); expect(drain).toHaveBeenCalledTimes(1); expect(sleep).toHaveBeenCalledTimes(1);
});
