import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGuardianLoop } from '../src/cli/fleet-guardian-loop.js';
import { repeatGuardianDrains, type GuardianRepeatDrain, type GuardianRepeatOptions } from '../src/core/fleet/guardian-repeat.js';
import type { GuardianDrainSummary } from '../src/core/fleet/guardian-retry-drain.js';

const base: GuardianRepeatOptions = { manifest: '/manifest', sourceState: '/source', outputDir: '/out', durationMs: 3500, intervalMs: 1000, maxRetries: 2, timeoutMs: 5000, apply: true };
const result = (termination: GuardianDrainSummary['termination'] = 'drained', latestOutput: string | null = '/verified'): GuardianDrainSummary => ({ mode: 'apply', termination, attempts: 1, verified: 1, refused: 0, attempted: [], planned: [], latestOutput });
const clock = () => { let time = 0; return { now: () => time, sleep: vi.fn(async (ms: number) => { time += ms; }), advance: (ms: number) => { time += ms; } }; };
afterEach(() => vi.restoreAllMocks());

it('stops after one completed pass without sleeping and retains the checkpoint', async () => {
  const c = clock(), drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: result(), session: '/session', checkpoint: '/checkpoint' }));
  const out = await repeatGuardianDrains({ ...base, maxPasses: 1, idleBackoffMaxMs: 4000 }, { drain, ...c });
  expect(out).toMatchObject({ termination: 'max-passes', passes: 1, attempts: 1, verified: 1, latestOutput: '/checkpoint', session: '/session' });
  expect(drain).toHaveBeenCalledTimes(1); expect(c.sleep).not.toHaveBeenCalled();
});

it('passes the verified source to pass two and stops without a further wait', async () => {
  const c = clock(), sources: string[] = [];
  const drain: GuardianRepeatDrain = async request => { sources.push(request.sourceState); return { summary: result(), session: '/session' }; };
  const out = await repeatGuardianDrains({ ...base, maxPasses: 2 }, { drain, ...c });
  expect(sources).toEqual(['/source', '/verified']); expect(out.passes).toBe(2);
  expect(out.termination).toBe('max-passes'); expect(c.sleep).toHaveBeenCalledTimes(1);
});

it.each(['stopped', 'refused', 'unsafe', 'deadline', 'cancelled'] as const)('preserves %s over the cap', async termination => {
  const c = clock();
  const out = await repeatGuardianDrains({ ...base, durationMs: 10000, maxPasses: 1 }, { ...c, drain: async () => ({ summary: result(termination), session: null }) });
  expect(out.termination).toBe(termination); expect(c.sleep).not.toHaveBeenCalled();
});

it('preserves observer errors and elapsed duration over the cap', async () => {
  const c = clock(), drain: GuardianRepeatDrain = async () => ({ summary: result(), session: null });
  expect((await repeatGuardianDrains({ ...base, maxPasses: 1 }, { ...c, drain, onPass: () => { throw new Error(); } })).termination).toBe('observer-error');
  expect((await repeatGuardianDrains({ ...base, maxPasses: 1 }, { ...c, drain: async () => { c.advance(3500); return drain({ manifest: '', sourceState: '', outputDir: '', maxRetries: 1, timeoutMs: 1, apply: true }); } })).termination).toBe('duration');
});

it('keeps duration-only and preview behavior when appropriate', async () => {
  const c = clock(), drain = vi.fn<GuardianRepeatDrain>(async () => ({ summary: result(), session: null }));
  expect((await repeatGuardianDrains(base, { ...c, drain })).passes).toBe(4);
  const preview = await repeatGuardianDrains({ ...base, apply: false, maxPasses: 1 }, { ...clock(), drain });
  expect(preview).toMatchObject({ passes: 1, termination: 'drained' });
});

it('rejects invalid core and CLI caps before a drain', async () => {
  const drain = vi.fn<GuardianRepeatDrain>(); vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const maxPasses of [0, 1001, 1.5, NaN, Infinity]) await expect(repeatGuardianDrains({ ...base, maxPasses }, { drain })).rejects.toThrow(RangeError);
  const args = ['--manifest', '/manifest', '--source-state', '/source', '--output-dir', '/out', '--duration-ms', '3500', '--interval-ms', '1000', '--max-retries', '2', '--timeout-ms', '5000', '--apply'];
  for (const suffix of [['--max-passes'], ...['0', '1001', '1.5', '-1', 'abc', '01', '9007199254740992'].map(v => ['--max-passes', v]), ['--max-passes', '1', '--max-passes', '2']]) {
    expect(await cmdFleetGuardianLoop([...args, ...suffix], { drain })).toBe(2);
  }
  expect(drain).not.toHaveBeenCalled();
});

it('streams one pass and one summary with the resume pointer', async () => {
  const lines: string[] = [], c = clock();
  const args = ['--manifest', '/manifest', '--source-state', '/source', '--output-dir', '/out', '--duration-ms', '3500', '--interval-ms', '1000', '--max-retries', '2', '--timeout-ms', '5000', '--apply', '--stream', '--max-passes', '1'];
  const code = await cmdFleetGuardianLoop(args, { ...c, drain: async () => ({ summary: result(), session: '/session', checkpoint: '/checkpoint' }), writeLine: line => { lines.push(line); } });
  const records = lines.map(line => JSON.parse(line) as Record<string, unknown>);
  expect(code).toBe(0); expect(records.map(r => r.record)).toEqual(['pass', 'summary']);
  expect(records[1]).toMatchObject({ termination: 'max-passes', passes: 1, latestOutput: '/checkpoint', session: '/session' });
});
