import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGuardianContinue } from '../src/cli/fleet-guardian-continue.js';
import { cmdFleetGuardianResume } from '../src/cli/fleet-guardian-resume.js';
import { writeGuardianDrainCheckpoint } from '../src/core/fleet/guardian-drain-checkpoint.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const repeat = ['--duration-ms', '10000', '--interval-ms', '1000'];
const summary = { mode: 'apply', termination: 'drained', attempts: 1, verified: 1, refused: 0,
  attempted: [], planned: [], latestOutput: '/untrusted', session: '/private/session' };

it('continue forwards boundaries and omitted limit once without inferring apply', async () => {
  const resume = vi.fn(async () => 0);
  for (const cap of [[], ['--max-passes', '1'], ['--max-passes', '1000']]) {
    const flags = [...repeat, ...cap];
    expect(await cmdFleetGuardianContinue(['--stdin', ...flags], { readInput: async () => JSON.stringify(summary), resume })).toBe(0);
    expect(resume.mock.calls.at(-1)![0]).toEqual(['--checkpoint-dir', summary.session, ...flags]);
  }
  expect(await cmdFleetGuardianContinue(['--stdin', ...repeat, '--max-passes', '1'], { readInput: async () => '{}', resume })).toBe(2);
  expect(resume).toHaveBeenCalledTimes(3);
});

it('rejects malformed limits before input, checkpoint or delegation', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const readInput = vi.fn(async () => JSON.stringify(summary));
  const resume = vi.fn(async () => 0);
  const bad = [['--max-passes'], ...['0', '1.5', '1001', '01', '-1', '9007199254740992'].map(v => ['--max-passes', v]), ['--max-passes', '1', '--max-passes', '2']];
  for (const flags of [...bad.map(f => [...repeat, ...f]), ['--max-passes', '1'], ['--duration-ms', '10000', '--max-passes', '1']]) {
    expect(await cmdFleetGuardianContinue(['--stdin', ...flags], { readInput, resume })).toBe(2);
    expect(await cmdFleetGuardianResume(['--checkpoint-dir', '/missing', ...flags])).toBe(2);
  }
  expect(readInput).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
});

it('resumes a private checkpoint through the real loop and stops at the cap', async () => {
  const session = await mkdtemp(join(tmpdir(), 'pass-bound-src-')); dirs.push(session);
  const output = await mkdtemp(join(tmpdir(), 'pass-bound-out-')); dirs.push(output);
  const latest = join(session, 'guardian-drain-attempt-1.json');
  await writeFile(latest, 'source', { mode: 0o600 });
  writeGuardianDrainCheckpoint(session, { version: 1, latestOutput: latest, repo: '/fake/repo', sha: 'a'.repeat(40), completedAt: '2026-11-01T23:31:00.000Z' });
  const checkpoint = join(session, 'guardian-drain-latest.json');
  const before = await readFile(checkpoint);
  let time = 0, n = 0;
  const sleep = vi.fn(async (ms: number) => { time += ms; });
  const select = vi.fn(async () => ({ repo: `/fake/repo-${++n}`, sha: String(n).repeat(40) }));
  const prepare = vi.fn(async (o: { outputState: string }) => { await writeFile(o.outputState, 'verified', { flag: 'wx' }); return { removed: 0, retained: 0, nextAction: 'fake' }; });
  const verify = vi.fn(async () => ({ state: 'ran', summary: { deadlineExceeded: false, cancelled: false } }) as unknown as GuardianVerifyExclusiveResult);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const args = ['--checkpoint-dir', session, '--manifest', '/fake/manifest', '--output-dir', output, '--max-retries', '1', '--timeout-ms', '5000', ...repeat, '--max-passes', '2', '--apply', '--json'];
  expect(await cmdFleetGuardianResume(args, { now: () => time, sleep, select, prepare, verify })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ termination: 'max-passes', passes: 2, verified: 2 });
  expect(select.mock.calls[0]![0].sourceState).toBe(latest);
  expect(verify).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledTimes(1);
  expect(await readFile(checkpoint)).toEqual(before); expect(await readFile(latest, 'utf8')).toBe('source');
});

it.each(['1', '1000', undefined])('accepts resume limit %s with the existing loop', async cap => {
  const session = await mkdtemp(join(tmpdir(), 'pass-bound-preview-')); dirs.push(session);
  const latest = join(session, 'guardian-drain-attempt-1.json'); await writeFile(latest, 'source', { mode: 0o600 });
  writeGuardianDrainCheckpoint(session, { version: 1, latestOutput: latest, repo: '/fake/repo', sha: 'a'.repeat(40), completedAt: '2026-11-01T23:31:00.000Z' });
  const select = vi.fn(async () => ({ repo: '/fake/repo', sha: 'b'.repeat(40) }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags = cap === undefined ? [] : ['--max-passes', cap];
  expect(await cmdFleetGuardianResume(['--checkpoint-dir', session, '--manifest', '/fake/manifest', '--output-dir', session, '--max-retries', '1', '--timeout-ms', '5000', ...repeat, ...flags, '--json'], { select })).toBe(0);
  expect(select).toHaveBeenCalledOnce();
});
