import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianLoop } from '../src/cli/fleet-guardian-loop.js';
import { drainWithFreshSession, repeatGuardianDrains, type GuardianRepeatDrain, type GuardianRepeatOptions } from '../src/core/fleet/guardian-repeat.js';
import type { GuardianDrainSummary } from '../src/core/fleet/guardian-retry-drain.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

// Fake clock, injected drains, synthetic repos/SHAs; no network or workers.
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const tmp = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), 'guardian-repeat-')); dirs.push(d); return d; };

const summary = (over: Partial<GuardianDrainSummary> = {}): GuardianDrainSummary => ({
  mode: 'apply', termination: 'drained', attempts: 1, verified: 1, refused: 0, attempted: [], planned: [], latestOutput: null, ...over,
});
const base: GuardianRepeatOptions = {
  manifest: '/m.json', sourceState: '/orig.json', outputDir: '/out', durationMs: 100_000, intervalMs: 1000, maxRetries: 2, timeoutMs: 60_000, apply: true,
};
function clock() {
  let t = 0;
  return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms; }), advance: (ms: number) => { t += ms; } };
}

describe('repeatGuardianDrains', () => {
  it('carries the latest verified state into the next pass and keeps prior source on null', async () => {
    const c = clock();
    const sources: string[] = [];
    const outs = ['/out/s1/a.json', null, '/out/s3/a.json'];
    const drain: GuardianRepeatDrain = vi.fn(async r => {
      sources.push(r.sourceState);
      const i = sources.length - 1;
      return { summary: summary({ latestOutput: outs[i] ?? null }), session: `/out/s${i + 1}` };
    });
    const out = await repeatGuardianDrains({ ...base, durationMs: 2500 }, { drain, now: c.now, sleep: c.sleep });
    expect(sources).toEqual(['/orig.json', '/out/s1/a.json', '/out/s1/a.json']);
    expect(out).toMatchObject({ passes: 3, attempts: 3, verified: 3, latestOutput: '/out/s3/a.json', session: '/out/s3' });
    expect(out.termination).toBe('duration');
  });

  it('preview runs exactly one read-only drain', async () => {
    const drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: summary({ mode: 'preview', termination: 'planned', attempts: 0, verified: 0 }), session: null }));
    const c = clock();
    const out = await repeatGuardianDrains({ ...base, apply: false }, { drain, now: c.now, sleep: c.sleep });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain.mock.calls[0]![0].apply).toBe(false);
    expect(c.sleep).not.toHaveBeenCalled();
    expect(out).toMatchObject({ mode: 'preview', termination: 'planned', passes: 1 });
  });

  it.each(['refused', 'unsafe', 'collision', 'observer-error', 'cancelled'] as const)('%s ends admission', async termination => {
    const c = clock();
    const drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: summary({ termination, refused: termination === 'refused' ? 1 : 0, verified: 0 }), session: '/out/s' }));
    const out = await repeatGuardianDrains(base, { drain, now: c.now, sleep: c.sleep });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(out.termination).toBe(termination);
    expect(c.sleep).not.toHaveBeenCalled();
  });

  it('shrinks the verifier timeout by the remaining duration', async () => {
    const c = clock();
    const timeouts: number[] = [];
    const drain: GuardianRepeatDrain = async r => { timeouts.push(r.timeoutMs); return { summary: summary({ termination: 'no-work', attempts: 0, verified: 0 }), session: '/s' }; };
    await repeatGuardianDrains({ ...base, durationMs: 5000, intervalMs: 1000, timeoutMs: 4000 }, { drain, now: c.now, sleep: c.sleep });
    expect(timeouts).toEqual([4000, 4000, 3000, 2000, 1000]);
    expect(timeouts.at(-1)).toBeLessThan(4000);
  });

  it('a drain deadline caused by the shrunken budget reports duration', async () => {
    const c = clock();
    const drain: GuardianRepeatDrain = async () => ({ summary: summary({ termination: 'deadline' }), session: '/s' });
    const out = await repeatGuardianDrains({ ...base, durationMs: 500, timeoutMs: 60_000 }, { drain, now: c.now, sleep: c.sleep });
    expect(out.termination).toBe('duration');
  });

  it('cancellation during sleep starts no new pass', async () => {
    const controller = new AbortController();
    const drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: summary({ termination: 'no-work', attempts: 0, verified: 0 }), session: '/s' }));
    const sleep = vi.fn(async () => { controller.abort(); });
    const out = await repeatGuardianDrains({ ...base, signal: controller.signal }, { drain, now: () => 0, sleep });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(out.termination).toBe('cancelled');
  });

  it('a stop file created while waiting interrupts the interval', async () => {
    const dir = await tmp();
    const stop = join(dir, 'stop');
    const drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: summary({ termination: 'drained' }), session: '/s' }));
    const sleep = vi.fn(async () => { await writeFile(stop, ''); });
    const out = await repeatGuardianDrains({ ...base, stopFile: stop }, { drain, now: () => 0, sleep });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(out.termination).toBe('stopped');
  });
});

describe('cmdFleetGuardianLoop', () => {
  const argv = (dir: string, extra: string[] = []): string[] => ['--manifest', join(dir, 'm.json'), '--source-state', join(dir, 'state.json'),
    '--output-dir', join(dir, 'out'), '--duration-ms', '10000', '--interval-ms', '1000', '--max-retries', '2', '--timeout-ms', '5000', ...extra];

  it('preexisting stop file allocates nothing; no mkdir', async () => {
    const dir = await tmp();
    await mkdir(join(dir, 'out')); await writeFile(join(dir, 'stop'), '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const verify = vi.fn();
    expect(await cmdFleetGuardianLoop(argv(dir, ['--apply', '--stop-file', join(dir, 'stop'), '--json']), { verify })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ termination: 'stopped', attempts: 0 });
    expect(await readdir(join(dir, 'out'))).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects conflicting, duplicate, unknown and out-of-range args before work', async () => {
    const dir = await tmp();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const drain = vi.fn();
    for (const extra of [['--json', '--stream'], ['--bogus', 'x'], ['--interval-ms', '2000'], ['--apply', '--apply']]) {
      expect(await cmdFleetGuardianLoop(argv(dir, extra), { drain })).toBe(2);
    }
    expect(await cmdFleetGuardianLoop(argv(dir).map(a => a === '1000' ? '999' : a), { drain })).toBe(2);
    expect(await cmdFleetGuardianLoop(argv(dir).map(a => a === '10000' ? '86400001' : a), { drain })).toBe(2);
    expect(drain).not.toHaveBeenCalled();
  });

  it('stream emits sanitized per-pass records and one final summary', async () => {
    const dir = await tmp();
    const c = clock();
    const lines: string[] = [];
    const drain: GuardianRepeatDrain = async () => ({ summary: summary({ termination: 'no-work', attempts: 0, verified: 0 }), session: '/s' });
    expect(await cmdFleetGuardianLoop(argv(dir, ['--apply', '--stream']), { drain, now: c.now, sleep: c.sleep, writeLine: l => { lines.push(l); } })).toBe(0);
    const recs = lines.map(l => JSON.parse(l) as { record: string; passes?: number });
    expect(recs.filter(r => r.record === 'summary')).toHaveLength(1);
    expect(recs.at(-1)!.record).toBe('summary');
    expect(recs.filter(r => r.record === 'pass').length).toBe(recs.at(-1)!.passes);
  });

  it('real drain adapter: fresh sessions and carried-forward state', async () => {
    const dir = await tmp();
    const out = join(dir, 'out');
    await mkdir(out);
    const sources: string[] = [];
    let n = 0;
    const select = vi.fn(async (o: { sourceState: string; exclude?: unknown[] }) => {
      if (o.exclude && (o.exclude as unknown[]).length) return null;
      sources.push(o.sourceState);
      return n++ < 2 ? { repo: `/fake/repo-${n}`, sha: String(n).repeat(40) } : null;
    });
    const prepare = vi.fn(async (o: { outputState: string }) => {
      await writeFile(o.outputState, 'state', { flag: 'wx' });
      return { removed: 0, retained: 0, nextAction: 'x' };
    });
    const verify = vi.fn(async () => ({ state: 'ran', summary: { deadlineExceeded: false, cancelled: false } }) as unknown as GuardianVerifyExclusiveResult);
    const c = clock();
    const result = await repeatGuardianDrains(
      { ...base, manifest: join(dir, 'm.json'), sourceState: join(dir, 'state.json'), outputDir: out, maxRetries: 1, durationMs: 1500 },
      { drain: drainWithFreshSession({ select: select as never, prepare: prepare as never, verify }, c.now), now: c.now, sleep: c.sleep },
    );
    const sessions = (await readdir(out)).map(n => join(out, n));
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map(s => dirname(s))).size).toBe(1);
    expect(sources[0]).toBe(join(dir, 'state.json'));
    const second = sources.find(s => s.startsWith(out));
    expect(second).toBeDefined();
    expect(second).toMatch(/guardian-drain-attempt-1\.json$/);
    expect(result.passes).toBeGreaterThanOrEqual(2);
    expect((await lstat(sessions[0]!)).isDirectory()).toBe(true);
    expect(await readFile(second!, 'utf8')).toBe('state');
  });
});
