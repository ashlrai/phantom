import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGuardianResume } from '../src/cli/fleet-guardian-resume.js';
import { writeGuardianDrainCheckpoint } from '../src/core/fleet/guardian-drain-checkpoint.js';
import type { GuardianRepeatDrain } from '../src/core/fleet/guardian-repeat.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function setup() {
  const session = await mkdtemp(join(tmpdir(), 'resume-backoff-source-')); dirs.push(session);
  const output = await mkdtemp(join(tmpdir(), 'resume-backoff-output-')); dirs.push(output);
  const latest = join(session, 'guardian-drain-attempt-1.json');
  await writeFile(latest, 'source', { mode: 0o600 });
  writeGuardianDrainCheckpoint(session, { version: 1, latestOutput: latest, repo: '/fake/repo', sha: 'a'.repeat(40), completedAt: '2026-11-01T23:31:00.000Z' });
  const args = ['--checkpoint-dir', session, '--manifest', join(session, 'manifest.json'), '--output-dir', output, '--max-retries', '1', '--timeout-ms', '5000'];
  return { session, output, latest, args };
}

it.each([
  { flags: ['--idle-backoff-max-ms', '4000'], times: [0, 2000, 6000, 10000] },
  { flags: [], times: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000] },
])('resumes no-work passes with expected delays: $flags', async ({ flags, times }) => {
  const o = await setup(); let time = 0;
  const calls: number[] = [];
  const drain: GuardianRepeatDrain = async request => {
    expect(request.sourceState).toBe(o.latest);
    calls.push(time);
    return { session: null, summary: { mode: 'apply', termination: 'no-work', attempts: 0, verified: 0, refused: 0, attempted: [], planned: [], latestOutput: null } };
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetGuardianResume([...o.args, '--duration-ms', '11000', '--interval-ms', '1000', ...flags, '--apply', '--json'], {
    drain, now: () => time, sleep: async ms => { time += ms; },
  });
  expect(code).toBe(0);
  expect(calls).toEqual(times);
  expect(await readdir(o.output)).toEqual([]);
});

it('rejects invalid backoff before checkpoint access or session allocation', async () => {
  const o = await setup();
  await rm(join(o.session, 'guardian-drain-latest.json'));
  const drain = vi.fn<GuardianRepeatDrain>();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const repeat = ['--duration-ms', '11000', '--interval-ms', '1000'];
  for (const flags of [
    ['--idle-backoff-max-ms', '1000'],
    ['--duration-ms', '11000', '--idle-backoff-max-ms', '1000'],
    ['--interval-ms', '1000', '--idle-backoff-max-ms', '1000'],
    ...['0', '999', '86400001', '9007199254740992', '1.5', '1e3', 'abc', ''].map(v => [...repeat, '--idle-backoff-max-ms', v]),
    [...repeat, '--idle-backoff-max-ms'],
    [...repeat, '--idle-backoff-max-ms', '1000', '--idle-backoff-max-ms', '1000'],
  ]) {
    expect(await cmdFleetGuardianResume([...o.args, ...flags, '--apply'], { drain })).toBe(2);
  }
  expect(drain).not.toHaveBeenCalled();
  expect(await readdir(o.output)).toEqual([]);
});
