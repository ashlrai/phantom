import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGuardianLoop } from '../src/cli/fleet-guardian-loop.js';
import { repeatGuardianDrains, type GuardianRepeatDrain, type GuardianRepeatOptions } from '../src/core/fleet/guardian-repeat.js';
import type { GuardianDrainSummary } from '../src/core/fleet/guardian-retry-drain.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-exit-')); dirs.push(dir);
  const options: GuardianRepeatOptions = { manifest: join(dir, 'manifest'), sourceState: join(dir, 'source'), outputDir: join(dir, 'out'), durationMs: 9500, intervalMs: 1000, maxRetries: 2, timeoutMs: 5000, apply: true };
  const args = ['--manifest', options.manifest, '--source-state', options.sourceState, '--output-dir', options.outputDir, '--duration-ms', '9500', '--interval-ms', '1000', '--max-retries', '2', '--timeout-ms', '5000', '--stream'];
  let time = 0;
  const sleep = vi.fn(async (ms: number) => { time += ms; });
  return { dir, options, args, now: () => time, sleep, advance: (ms: number) => { time += ms; } };
};
const result = (changes: Partial<GuardianDrainSummary> = {}): GuardianDrainSummary => ({ mode: 'apply', termination: 'no-work', attempts: 0, verified: 0, refused: 0, attempted: [], planned: [], latestOutput: null, ...changes });

it('streams the last pass and summary at the idle threshold without another sleep or drain', async () => {
  const c = await setup(), lines: string[] = [];
  const drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: result(), session: null }));
  expect(await cmdFleetGuardianLoop([...c.args, '--apply', '--max-idle-passes', '3'], { ...c, drain, writeLine: l => { lines.push(l); } })).toBe(0);
  expect(drain).toHaveBeenCalledTimes(3); expect(c.sleep).toHaveBeenCalledTimes(2);
  const records = lines.map(l => JSON.parse(l));
  expect(records.map(r => r.record)).toEqual(['pass', 'pass', 'pass', 'summary']);
  expect(records.at(-1)).toMatchObject({ termination: 'idle-limit', passes: 3, attempts: 0, refused: 0 });
});

it('resets on work, attempted no-work and refused no-work, retaining the verified checkpoint', async () => {
  const c = await setup(), sources: string[] = []; let n = 0;
  const drain: GuardianRepeatDrain = async request => {
    sources.push(request.sourceState); n++;
    const summary = n === 2 ? result({ termination: 'drained', attempts: 1, verified: 1, latestOutput: '/verified' })
      : n === 4 ? result({ attempts: 1 }) : n === 6 ? result({ refused: 1 }) : result();
    return { summary, session: n === 2 ? '/session' : null, checkpoint: n === 2 ? '/checkpoint' : null };
  };
  const out = await repeatGuardianDrains({ ...c.options, maxIdlePasses: 2 }, { ...c, drain });
  expect(out).toMatchObject({ termination: 'idle-limit', passes: 8, attempts: 2, verified: 1, refused: 1, latestOutput: '/checkpoint', session: '/session' });
  expect(sources.slice(2)).toEqual(Array(6).fill('/verified'));
});

it('preserves disabled cadence and preview result', async () => {
  const c = await setup(), drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: result(), session: null }));
  expect(await repeatGuardianDrains({ ...c.options, durationMs: 2500 }, { ...c, drain })).toMatchObject({ termination: 'duration', passes: 3 });
  const lines: string[] = [];
  expect(await cmdFleetGuardianLoop([...c.args, '--max-idle-passes', '1'], { ...c, drain, writeLine: l => { lines.push(l); } })).toBe(0);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ mode: 'preview', termination: 'no-work', passes: 1 });
});

it('rejects malformed and duplicate options before draining, including core calls', async () => {
  const c = await setup(), drain = vi.fn<GuardianRepeatDrain>(); vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const flags of [['--max-idle-passes'], ...['0', '10001', '1.5', '1e2', '9007199254740992', 'abc'].map(v => ['--max-idle-passes', v]), ['--max-idle-passes', '1', '--max-idle-passes', '2']]) {
    expect(await cmdFleetGuardianLoop([...c.args, '--apply', ...flags], { drain })).toBe(2);
  }
  for (const n of [0, 10001, 1.5, NaN]) await expect(repeatGuardianDrains({ ...c.options, maxIdlePasses: n }, { drain })).rejects.toThrow(RangeError);
  expect(drain).not.toHaveBeenCalled();
});

it.each(['stopped', 'cancelled', 'duration', 'observer-error', 'unsafe', 'refused'] as const)('preserves %s precedence', async kind => {
  const c = await setup(), controller = new AbortController(), stopFile = join(c.dir, 'stop');
  const drain = vi.fn<GuardianRepeatDrain>(async () => {
    if (kind === 'stopped') await writeFile(stopFile, '');
    if (kind === 'cancelled') controller.abort();
    if (kind === 'duration') c.advance(c.options.durationMs);
    return { summary: result(kind === 'unsafe' || kind === 'refused' ? { termination: kind } : {}), session: null };
  });
  const out = await repeatGuardianDrains({ ...c.options, maxIdlePasses: 1, signal: controller.signal, stopFile }, { ...c, drain, onPass: () => { if (kind === 'observer-error') throw Error('observer'); } });
  expect(out.termination).toBe(kind); expect(c.sleep).not.toHaveBeenCalled(); expect(drain).toHaveBeenCalledTimes(1);
});
