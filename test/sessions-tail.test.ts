/**
 * `phm sessions tail <id>`: the stream behind the map's side panel
 * (cmdJobTail in 'session' mode over fleet.job.tail.v1). Fixtures live in a
 * temp runs dir and use plain words only; secret redaction is exercised
 * through the `redact` seam, the default through a home path.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdJobTail } from '../src/cli/job.js';
import { cmdSessions } from '../src/cli/sessions.js';
import { jobControlAvailability } from '../src/core/fleet/job-control-types.js';
import { getFleetJobTail } from '../src/core/fleet/runs-job-tail.js';

let runs: string;
const JOB = 'RQ-PANELTEST';
const T0 = new Date('2026-11-17T10:00:00Z');
const put = async (name: string, text: string, seconds: number): Promise<void> => {
  const when = new Date(T0.getTime() + seconds * 1000);
  await writeFile(join(runs, name), text);
  await utimes(join(runs, name), when, when);
};
const launch = async (log: string): Promise<void> => {
  await put(`${JOB}.launch`, `launched ${JOB} codex pid 4242 base 1234\n`, 0);
  await put(`${JOB}.base.meta`, 'MODEL codex frontier model-x\n', 0);
  await put(`${JOB}.log`, log, 5);
};
const capture = () => {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); } } };
};
const tail = (args: string[], deps: Parameters<typeof cmdJobTail>[1]) => cmdJobTail([JOB, '--runs-dir', runs, ...args], deps, 'session');

beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'sessions-tail-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(runs, { recursive: true, force: true }); });

it('tails a finished job: its last 200 lines, what it was, and why it cannot be steered', async () => {
  await launch(Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  await mkdir(join(runs, 'metrics'));
  await put('metrics/jobs.jsonl', `${JSON.stringify({ ts: T0.toISOString(), event: 'finish', job: JOB, repo: 'phantom', tokens_total: 1200 })}\n`, 8);
  await put(`${JOB}.publish`, 'RESULT PR https://github.com/example/repo/pull/42\n', 10);
  const { out, io } = capture();
  expect(await tail(['--json', '--follow'], io)).toBe(0); // finished: prints once, does not wait
  const rows = out.map(line => JSON.parse(line) as { source: string; text: string; status?: string; detail?: unknown; controls?: unknown });
  expect(rows[0]).toMatchObject({
    source: 'status', status: 'finished',
    detail: { lane: 'codex', model: 'model-x', repo: 'phantom', tokens: 1200, prUrl: 'https://github.com/example/repo/pull/42' },
    controls: { available: false, reason: 'This session has finished, so there is nothing to pause, stop or move.' },
  });
  const log = rows.filter(row => row.source === 'log').map(row => row.text);
  expect(log).toHaveLength(200);
  expect([log[0], log.at(-1)]).toEqual(['line 51', 'line 250']);
  // `phm job tail` keeps its own 120-line cap.
  expect(await cmdJobTail([JOB, '--runs-dir', runs, '--lines', '200'], capture().io)).toBe(2);
});

it('follow emits new lines in order as one JSON object per line', async () => {
  await launch('first\n');
  const controller = new AbortController();
  const { out, io } = capture();
  const done = tail(['--follow', '--json'], {
    ...io, signal: controller.signal, intervalMs: 20,
    out: line => {
      io.out(line);
      if (line.includes('"text":"first"')) void appendFile(join(runs, `${JOB}.log`), 'second\nthird\n');
      if (line.includes('"text":"third"')) controller.abort();
    },
  });
  expect(await done).toBe(0);
  const rows = out.map(line => JSON.parse(line) as { source: string; text: string; controls?: { available: boolean } });
  expect(rows[0]!.controls).toEqual({ available: true, reason: null });
  expect(rows.filter(row => row.source === 'log').map(row => row.text)).toEqual(['first', 'second', 'third']);
});

it('gives a plain error and exit code 2 for an unknown id, with nothing on stdout', async () => {
  const { out, err, io } = capture();
  expect(await tail(['--json'], io)).toBe(2);
  expect(out).toEqual([]);
  expect(err).toEqual([`No session ${JOB} on this computer. See: phm sessions`]);
  // The verb is routed from `phm sessions`, and bad usage is exit 2 as well.
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdSessions(['tail', JOB, '--runs-dir', runs])).toBe(2);
  expect(stderr).toHaveBeenLastCalledWith(`No session ${JOB} on this computer. See: phm sessions`);
  expect(await cmdSessions(['tail', JOB, '--lines', '201'])).toBe(2);
  expect(stderr.mock.calls.at(-1)![0]).toContain('Usage: phm sessions tail <id>');
});

it('redacts every line before display', async () => {
  await launch(`cloning into ${homedir()}/work\nSTUBMARK plain\n`);
  const { out, io } = capture();
  expect(await tail([], { ...io, snapshot: (id, options) => getFleetJobTail(id, { ...options, redact: line => line.replaceAll('STUBMARK', '[redacted]') }) })).toBe(0);
  expect(out).toContain('[redacted] plain');
  // The default redactor (the job detail's) runs first: the home path never reaches the screen.
  expect(out.join('\n')).not.toContain(homedir());
  expect(out.some(line => line.startsWith('cloning into ') && line.endsWith('/work'))).toBe(true);
});

it('says in plain words why controls are off when there is no control API', () => {
  expect(jobControlAvailability(undefined)).toEqual({ available: false, reason: 'This Phantom server has no job control for this session.' });
  expect(jobControlAvailability('remote').reason).toBe('No job control: this session runs on another computer.');
  expect(jobControlAvailability('unknown').available).toBe(false);
  expect(jobControlAvailability('live')).toEqual({ available: true, reason: null });
});
