import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readGuardianDrainCheckpoint } from '../src/core/fleet/guardian-drain-checkpoint.js';
import { drainWithFreshSession, repeatGuardianDrains, type GuardianRepeatDrain, type GuardianRepeatPass } from '../src/core/fleet/guardian-repeat.js';
import type { GuardianDrainSummary } from '../src/core/fleet/guardian-retry-drain.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const base = { manifest: '/fake/manifest', sourceState: '/fake/source', outputDir: '/fake/out', durationMs: 2500, intervalMs: 1000, maxRetries: 2, timeoutMs: 10000, apply: true };
const summary = (termination: GuardianDrainSummary['termination'], latestOutput: string | null = null): GuardianDrainSummary => ({
  mode: 'apply', termination, attempts: latestOutput ? 1 : 0, verified: latestOutput ? 1 : 0, refused: 0, attempted: [], planned: [], latestOutput,
});
function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

it('keeps the real checkpoint across a fresh idle session and attributes each pass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-pointer-')); dirs.push(dir);
  const outputDir = join(dir, 'out'); await mkdir(outputDir);
  const sources: string[] = [];
  const select = vi.fn(async (o: { sourceState: string }) => {
    sources.push(o.sourceState);
    return sources.length === 1 ? { repo: '/fake/repo', sha: 'a'.repeat(40) } : null;
  });
  const prepare = vi.fn(async ({ outputState }: { outputState: string }) => { await writeFile(outputState, 'prepared', { flag: 'wx' }); });
  const verify = vi.fn(async () => ({ state: 'ran', summary: { deadlineExceeded: false, cancelled: false } }) as unknown as GuardianVerifyExclusiveResult);
  const records: GuardianRepeatPass[] = [];
  const c = clock();
  const result = await repeatGuardianDrains({ ...base, outputDir, maxRetries: 1, durationMs: 1500 }, {
    drain: drainWithFreshSession({ select: select as never, prepare: prepare as never, verify }, c.now), ...c,
    onPass: record => { records.push(record); },
  });
  expect(result).toMatchObject({ passes: 2, termination: 'duration', verified: 1, session: records[0]!.session, latestOutput: records[0]!.latestOutput });
  expect(records[1]).toMatchObject({ termination: 'no-work', latestOutput: null });
  expect(records[1]!.session).not.toBe(records[0]!.session);
  expect(sources).toEqual([base.sourceState, result.latestOutput]);
  expect(readGuardianDrainCheckpoint(result.session!)?.latestOutput).toBe(result.latestOutput);
  expect(readGuardianDrainCheckpoint(records[1]!.session!)).toBeNull();
});

it('retains the prior pair after a terminal pass with no newer verified output', async () => {
  const c = clock(); const records: GuardianRepeatPass[] = []; const sources: string[] = [];
  const drain: GuardianRepeatDrain = async request => {
    sources.push(request.sourceState);
    return sources.length === 1 ? { summary: summary('drained', '/fake/s1/state'), session: '/fake/s1' }
      : { summary: summary('refused'), session: '/fake/s2' };
  };
  const result = await repeatGuardianDrains(base, { drain, ...c, onPass: r => { records.push(r); } });
  expect(result).toMatchObject({ termination: 'refused', passes: 2, latestOutput: '/fake/s1/state', session: '/fake/s1' });
  expect(sources).toEqual([base.sourceState, '/fake/s1/state']);
  expect(records.map(r => r.session)).toEqual(['/fake/s1', '/fake/s2']);
});

it('reports a terminal drain checkpoint without another pass', async () => {
  const c = clock(); let active = 0; let maxActive = 0; const sources: string[] = [];
  const drain: GuardianRepeatDrain = async request => {
    active++; maxActive = Math.max(active, maxActive); sources.push(request.sourceState);
    await Promise.resolve(); active--;
    return sources.length === 1 ? { summary: summary('drained', '/fake/s1/state'), session: '/fake/s1' }
      : { summary: summary('refused', '/fake/s2/state'), session: '/fake/s2' };
  };
  const result = await repeatGuardianDrains(base, { drain, ...c });
  expect(result).toMatchObject({ termination: 'refused', passes: 2, latestOutput: '/fake/s2/state', session: '/fake/s2' });
  expect(sources).toEqual([base.sourceState, '/fake/s1/state']);
  expect(maxActive).toBe(1);
});

it('does not advertise a pair for idle passes or preview', async () => {
  for (const apply of [true, false]) {
    const c = clock(); const records: GuardianRepeatPass[] = [];
    const drain: GuardianRepeatDrain = async () => ({ summary: summary(apply ? 'no-work' : 'planned'), session: apply ? '/fake/idle' : null });
    const result = await repeatGuardianDrains({ ...base, apply }, { drain, ...c, onPass: r => { records.push(r); } });
    expect(result).toMatchObject({ passes: apply ? 3 : 1, latestOutput: null, session: null, termination: apply ? 'duration' : 'planned' });
    expect(records.every(r => r.session === (apply ? '/fake/idle' : null))).toBe(true);
  }
});

it('does not promote a verified output whose checkpoint was not persisted', async () => {
  const c = clock();
  const drain: GuardianRepeatDrain = async () => ({ summary: summary('unsafe', '/fake/s1/state'), session: '/fake/s1', checkpoint: null });
  const result = await repeatGuardianDrains(base, { drain, ...c });
  expect(result).toMatchObject({ termination: 'unsafe', latestOutput: null, session: null });
});

it('reports the real persisted checkpoint when a later attempt is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-terminal-pointer-')); dirs.push(dir);
  const outputDir = join(dir, 'out'); await mkdir(outputDir);
  let selected = 0; let verified = 0;
  const select = vi.fn(async () => ({ repo: `/fake/repo-${++selected}`, sha: String(selected).repeat(40) }));
  const prepare = vi.fn(async ({ outputState }: { outputState: string }) => { await writeFile(outputState, 'prepared', { flag: 'wx' }); });
  const verify = vi.fn(async () => ++verified === 1
    ? ({ state: 'ran', summary: { deadlineExceeded: false, cancelled: false } } as unknown as GuardianVerifyExclusiveResult)
    : ({ state: 'refused', reason: 'busy' } as GuardianVerifyExclusiveResult));
  const c = clock();
  const result = await repeatGuardianDrains({ ...base, outputDir }, {
    drain: drainWithFreshSession({ select: select as never, prepare: prepare as never, verify }, c.now), ...c,
  });
  expect(result).toMatchObject({ termination: 'refused', passes: 1, verified: 1, refused: 1 });
  expect(result.session).not.toBeNull();
  expect(result.latestOutput).toBe(join(result.session!, 'guardian-drain-attempt-1.json'));
  expect(readGuardianDrainCheckpoint(result.session!)?.latestOutput).toBe(result.latestOutput);
});
