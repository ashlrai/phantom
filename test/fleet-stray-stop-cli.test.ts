import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetStrayStop } from '../src/cli/fleet-stray-stop.js';
import type { StraySlotsReport } from '../src/core/fleet/stray-slots.js';

const report: StraySlotsReport = { lanes: [
  { lane: 'devin', slotsLost: 2, strays: [{ job: 'RQ-A', pid: 987601, ageSeconds: 60 }, { job: 'RQ-B', pid: 987602, ageSeconds: null }] },
  { lane: 'codex', slotsLost: 1, strays: [{ job: 'RQ-C', pid: 987603, ageSeconds: 5 }] },
] };
let dir: string;
let out: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stray-stop-cli-'));
  out = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(m); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const mk = (read: () => Promise<StraySlotsReport> = async () => report) => {
  const kill = vi.fn();
  return { kill, deps: { readStraySlots: read, kill, ledgerFile: join(dir, 'stray-stops.jsonl'), now: () => new Date('2026-11-03T00:00:00Z') } };
};
const json = () => JSON.parse(out.at(-1)!);

it('dry run kills nothing and lists the plan', async () => {
  const { kill, deps } = mk();
  expect(await cmdFleetStrayStop(['--json'], deps)).toBe(0);
  expect(kill).not.toHaveBeenCalled();
  const r = json();
  expect(r).toMatchObject({ v: 1, mode: 'dry-run', results: [], summary: { planned: 3, signalled: 0, capped: false } });
  expect(r.planned.map((p: { pid: number }) => p.pid)).toEqual([987601, 987602, 987603]);
});

it('--apply signals each stray once and writes one ledger line per stop', async () => {
  const { kill, deps } = mk();
  expect(await cmdFleetStrayStop(['--apply', '--json'], deps)).toBe(0);
  expect(kill.mock.calls).toEqual([[987601, 'SIGTERM'], [987602, 'SIGTERM'], [987603, 'SIGTERM']]);
  expect(json().summary).toMatchObject({ signalled: 3, refused: 0, failed: 0 });
  expect((await readFile(deps.ledgerFile, 'utf8')).trim().split('\n')).toHaveLength(3);
});

it('refuses a pid that vanishes from the re-read without killing it', async () => {
  let calls = 0;
  // Read 1 (verb) and 2 (stopStray #1) see both; later reads lose 987602.
  const read = async () => (++calls <= 2 ? report : { lanes: [{ lane: 'devin', slotsLost: 1, strays: [{ job: 'RQ-A', pid: 987601, ageSeconds: 1 }] }] });
  const { kill, deps } = mk(read);
  expect(await cmdFleetStrayStop(['--apply', '--json', '--lane', 'devin'], deps)).toBe(0);
  expect(kill.mock.calls).toEqual([[987601, 'SIGTERM']]);
  expect(json().results[1]).toMatchObject({ pid: 987602, result: 'refused', code: 'not-a-stray' });
});

it('maps ESRCH to already-gone', async () => {
  const { kill, deps } = mk();
  kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  expect(await cmdFleetStrayStop(['--apply', '--json', '--max', '1'], deps)).toBe(0);
  expect(json().results).toMatchObject([{ pid: 987601, result: 'already-gone' }]);
});

it('counts other kill errors as failed, continues, and exits 1', async () => {
  const { kill, deps } = mk();
  kill.mockImplementationOnce(() => { throw new Error('boom'); });
  expect(await cmdFleetStrayStop(['--apply', '--json'], deps)).toBe(1);
  expect(json().summary).toMatchObject({ failed: 1, signalled: 2 });
});

it('--max 1 stops one and reports capped', async () => {
  const { kill, deps } = mk();
  expect(await cmdFleetStrayStop(['--apply', '--json', '--max', '1'], deps)).toBe(0);
  expect(kill).toHaveBeenCalledTimes(1);
  expect(json().summary).toMatchObject({ planned: 1, signalled: 1, capped: true });
});

it('--lane filters', async () => {
  const { kill, deps } = mk();
  await cmdFleetStrayStop(['--apply', '--json', '--lane', 'codex'], deps);
  expect(kill.mock.calls).toEqual([[987603, 'SIGTERM']]);
});

it('never signals the parent process', async () => {
  const { kill, deps } = mk(async () => ({ lanes: [{ lane: 'devin', slotsLost: 1, strays: [{ job: 'RQ-P', pid: process.ppid, ageSeconds: 1 }] }] }));
  await cmdFleetStrayStop(['--apply', '--json'], deps);
  expect(kill).not.toHaveBeenCalled();
  expect(json().results[0]).toMatchObject({ result: 'refused', code: 'protected-pid' });
});

it('reports unreadable evidence as unavailable', async () => {
  const { deps } = mk(async () => { throw new Error('ps failed'); });
  expect(await cmdFleetStrayStop([], deps)).toBe(1);
  expect(process.stderr.write).toHaveBeenCalledWith('error: fleet stray-stop unavailable\n');
});

it('honours --runs-dir for the ledger', async () => {
  const { kill, deps } = mk();
  const { ledgerFile: _unused, ...rest } = deps;
  await cmdFleetStrayStop(['--apply', '--runs-dir', dir, '--lane', 'codex'], rest);
  expect(kill).toHaveBeenCalledTimes(1);
  expect((await readFile(join(dir, 'stray-stops.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
});

it('--help exits 0 and bad or duplicate flags exit 2', async () => {
  const { kill, deps } = mk();
  expect(await cmdFleetStrayStop(['--help'], deps)).toBe(0);
  for (const bad of [['--bogus'], ['--apply', '--apply'], ['--max', '0'], ['--max', '51'], ['--max', '1', '--max', '2'], ['--lane'], ['--lane', '../x'], ['--runs-dir']]) {
    expect(await cmdFleetStrayStop(bad, deps)).toBe(2);
  }
  expect(kill).not.toHaveBeenCalled();
});
