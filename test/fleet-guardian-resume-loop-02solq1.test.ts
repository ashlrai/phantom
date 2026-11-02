import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGuardianResume } from '../src/cli/fleet-guardian-resume.js';
import { writeGuardianDrainCheckpoint } from '../src/core/fleet/guardian-drain-checkpoint.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function setup() {
  const session = await mkdtemp(join(tmpdir(), 'resume-loop-source-')); dirs.push(session);
  const output = await mkdtemp(join(tmpdir(), 'resume-loop-output-')); dirs.push(output);
  const latest = join(session, 'guardian-drain-attempt-1.json');
  await writeFile(latest, 'source', { mode: 0o600 });
  writeGuardianDrainCheckpoint(session, { version: 1, latestOutput: latest, repo: '/fake/repo', sha: 'a'.repeat(40), completedAt: '2026-11-01T23:31:00.000Z' });
  const checkpoint = join(session, 'guardian-drain-latest.json');
  const args = ['--checkpoint-dir', session, '--manifest', join(session, 'manifest.json'), '--output-dir', output, '--max-retries', '1', '--timeout-ms', '5000'];
  const repeat = ['--duration-ms', '1500', '--interval-ms', '1000'];
  let n = 0, time = 0;
  const select = vi.fn(async (_o: { sourceState: string }) => ({ repo: `/fake/repo-${++n}`, sha: String(n).repeat(40) }));
  const prepare = vi.fn(async (o: { outputState: string }) => { await writeFile(o.outputState, 'verified', { flag: 'wx' }); return { removed: 0, retained: 0, nextAction: 'fake' }; });
  const verify = vi.fn(async () => ({ state: 'ran', summary: { deadlineExceeded: false, cancelled: false } }) as unknown as GuardianVerifyExclusiveResult);
  const now = () => time;
  const sleep = async (ms: number) => { time += ms; };
  return { session, output, latest, checkpoint, args, repeat, select, prepare, verify, now, sleep };
}
async function run(args: string[], deps: Parameters<typeof cmdFleetGuardianResume>[1]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { const code = await cmdFleetGuardianResume([...args, '--json'], deps); return { code, summary: JSON.parse(String(log.mock.calls[0]?.[0] ?? '{}')) }; }
  finally { log.mockRestore(); }
}

it('preserves one-shot delegation and leaves checkpoint inputs untouched', async () => {
  const o = await setup(); const before = await readFile(o.checkpoint);
  const result = await run([...o.args, '--apply'], o);
  expect(result).toMatchObject({ code: 0, summary: { termination: 'max-retries', attempts: 1 } });
  expect(o.select.mock.calls[0]![0].sourceState).toBe(o.latest);
  expect(o.verify).toHaveBeenCalledTimes(1);
  expect(await readFile(o.checkpoint)).toEqual(before);
  expect(await readFile(o.latest, 'utf8')).toBe('source');
});

it('runs two sequential fresh passes carrying the verified output forward', async () => {
  const o = await setup(); const before = await readFile(o.checkpoint);
  const result = await run([...o.args, ...o.repeat, '--apply'], o);
  expect(result).toMatchObject({ code: 0, summary: { termination: 'duration', passes: 2, verified: 2 } });
  const sources = o.select.mock.calls.map(([a]) => a.sourceState);
  expect(sources[0]).toBe(o.latest);
  expect(dirname(sources[1]!)).not.toBe(o.session);
  expect(await readFile(sources[1]!, 'utf8')).toBe('verified');
  expect(await readdir(o.output)).toHaveLength(2);
  expect(o.verify).toHaveBeenCalledTimes(2);
  expect(await readFile(o.checkpoint)).toEqual(before);
  expect(await readFile(o.latest, 'utf8')).toBe('source');
});

it('previews once without creating a session', async () => {
  const o = await setup(); const result = await run([...o.args, ...o.repeat], o);
  expect(result).toMatchObject({ code: 0, summary: { mode: 'preview', termination: 'planned', passes: 1 } });
  expect(o.select.mock.calls[0]![0].sourceState).toBe(o.latest);
  expect(o.verify).not.toHaveBeenCalled(); expect(await readdir(o.output)).toEqual([]);
});

it('rejects invalid repeat arguments before checkpoint or verifier work', async () => {
  const o = await setup(); await rm(o.checkpoint);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const flags of [ ['--duration-ms', '1'], ['--interval-ms', '1000'], ['--duration-ms', '0', '--interval-ms', '1000'],
    ['--duration-ms', '86400001', '--interval-ms', '1000'], ['--duration-ms', '1', '--interval-ms', '999'],
    ['--duration-ms', '1', '--interval-ms', '86400001'], [...o.repeat, '--duration-ms', '2'], [...o.repeat, '--json', '--stream'] ]) {
    expect(await cmdFleetGuardianResume([...o.args, ...flags, '--apply'], o)).toBe(2);
  }
  expect(err.mock.calls.every(([s]) => String(s).startsWith('error: '))).toBe(true);
  expect(o.select).not.toHaveBeenCalled(); expect(o.verify).not.toHaveBeenCalled(); expect(await readdir(o.output)).toEqual([]);
});

it('rejects an invalid checkpoint without verifier calls or sessions', async () => {
  const o = await setup(); await writeFile(o.checkpoint, '{');
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await cmdFleetGuardianResume([...o.args, ...o.repeat, '--apply'], o)).toBe(3);
  expect(err).toHaveBeenCalledWith('error: guardian-resume found no valid private checkpoint in --checkpoint-dir\n');
  expect(o.verify).not.toHaveBeenCalled(); expect(o.select).not.toHaveBeenCalled(); expect(await readdir(o.output)).toEqual([]);
});

it('propagates stop and verifier deadline through the real loop', async () => {
  const o = await setup(); const stop = join(o.session, 'stop'); await writeFile(stop, '');
  const stopped = await run([...o.args, ...o.repeat, '--apply', '--stop-file', stop], o);
  expect(stopped).toMatchObject({ code: 0, summary: { termination: 'stopped', passes: 0 } });
  expect(o.verify).not.toHaveBeenCalled(); expect(await readdir(o.output)).toEqual([]);
  await rm(stop);
  const verify = vi.fn(async () => ({ state: 'ran', summary: { deadlineExceeded: true, cancelled: false } }) as unknown as GuardianVerifyExclusiveResult);
  const deadline = await run([...o.args, '--duration-ms', '10000', '--interval-ms', '1000', '--apply'], { ...o, verify });
  expect(deadline).toMatchObject({ code: 4, summary: { termination: 'deadline', passes: 1 } });
  expect(verify).toHaveBeenCalledTimes(1);
});
