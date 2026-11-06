import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGuardianLoop } from '../src/cli/fleet-guardian-loop.js';
import type { GuardianDrainDeps } from '../src/core/fleet/guardian-retry-drain.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-attempts-')); dirs.push(dir);
  await mkdir(join(dir, 'out'), { mode: 0o700 });
  let time = 0;
  const args = ['--manifest', join(dir, 'manifest'), '--source-state', join(dir, 'state'), '--output-dir', join(dir, 'out'),
    '--duration-ms', '1500', '--interval-ms', '1000', '--max-retries', '2', '--timeout-ms', '5000'];
  const records: Array<Record<string, unknown>> = [];
  let selected = 0;
  const select = vi.fn(async () => ({ repo: `/fake/repo-${++selected}`, sha: 'a'.repeat(40) }));
  const prepare = vi.fn(async (o: { outputState: string }) => { await writeFile(o.outputState, 'private state', { flag: 'wx', mode: 0o600 }); });
  const verify = vi.fn(async () => ({ state: 'ran', summary: { deadlineExceeded: false, cancelled: false } }) as unknown as GuardianVerifyExclusiveResult);
  const onAttempt = vi.fn(async () => {});
  const deps = { select: select as unknown as GuardianDrainDeps['select'], prepare: prepare as unknown as GuardianDrainDeps['prepare'], verify, onAttempt,
    now: () => time, sleep: async (ms: number) => { time += ms; }, writeLine: (line: string) => { records.push(JSON.parse(line) as Record<string, unknown>); } };
  return { args, deps, records, verify, onAttempt };
}

it('streams every attempt before the next verifier and preserves pass order and the observer', async () => {
  const { args, deps, records, verify, onAttempt } = await setup();
  verify.mockImplementation(async () => {
    expect(records.filter(r => r.record === 'attempt')).toHaveLength(verify.mock.calls.length - 1);
    return { state: 'ran', summary: { deadlineExceeded: false, cancelled: false } } as unknown as GuardianVerifyExclusiveResult;
  });
  expect(await cmdFleetGuardianLoop([...args, '--apply', '--stream'], deps)).toBe(0);
  expect(records.map(r => r.record)).toEqual(['attempt', 'attempt', 'pass', 'attempt', 'attempt', 'pass', 'summary']);
  expect(onAttempt).toHaveBeenCalledTimes(4);
  expect(records[0]).toMatchObject({ attempt: 1, repo: '/fake/repo-1', sha: 'a'.repeat(40), outcome: 'verified', refusal: null });
  expect(JSON.stringify(records)).not.toContain('private state');
});

it('awaits a delayed write before admitting the next retry', async () => {
  const { args, deps, verify } = await setup();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writeLine = vi.fn(async (line: string) => { if (JSON.parse(line).record === 'attempt' && verify.mock.calls.length === 1) { started(); await gate; } });
  const run = cmdFleetGuardianLoop([...args, '--apply', '--stream'], { ...deps, writeLine });
  await entered;
  expect(verify).toHaveBeenCalledTimes(1);
  release();
  expect(await run).toBe(0);
  expect(verify).toHaveBeenCalledTimes(4);
});

it('stops on a rejected attempt write and cleans up signal handlers', async () => {
  const { args, deps, records, verify, onAttempt } = await setup();
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const writeLine = async (line: string) => { const record = JSON.parse(line) as Record<string, unknown>; if (record.record === 'attempt') throw new Error('write failed'); records.push(record); };
  expect(await cmdFleetGuardianLoop([...args, '--apply', '--stream'], { ...deps, writeLine })).toBe(3);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(onAttempt).toHaveBeenCalledTimes(1);
  expect(records.map(r => r.record)).toEqual(['pass', 'summary']);
  expect(records[0]).toMatchObject({ termination: 'observer-error' });
  expect(records[1]).toMatchObject({ termination: 'observer-error' });
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
});

it('keeps nonstream and preview behavior', async () => {
  const { args, deps, records, verify, onAttempt } = await setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetGuardianLoop([...args, '--apply', '--json'], deps)).toBe(0);
  expect(records).toHaveLength(0);
  expect(onAttempt).toHaveBeenCalledTimes(4);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ passes: 2, attempts: 4 });
  verify.mockClear(); onAttempt.mockClear();
  expect(await cmdFleetGuardianLoop([...args, '--stream'], deps)).toBe(0);
  expect(records.map(r => r.record)).toEqual(['pass', 'summary']);
  expect(verify).not.toHaveBeenCalled();
  expect(onAttempt).not.toHaveBeenCalled();
});
