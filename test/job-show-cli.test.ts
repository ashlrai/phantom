/**
 * `phm job show <id>` (src/cli/job-show.ts) over fleet.job.window.v1.
 *
 * Snapshot cases read a real temp runs dir; --follow cases inject a fake
 * window reader and wait so no timers or real files are involved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdJobShow } from '../src/cli/job-show.js';
import { buildJobWindow, type FleetJobWindowV1, type JobWindowFacts } from '../src/core/fleet/job-window.js';
import type { FleetJobWindowOptions } from '../src/core/fleet/runs-job-window.js';

let runs: string;
const T0 = new Date('2026-11-17T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'job-show-')); });
afterEach(async () => { await rm(runs, { recursive: true, force: true }); });

async function put(name: string, text: string, mtime: Date): Promise<void> {
  await writeFile(join(runs, name), text);
  await utimes(join(runs, name), mtime, mtime);
}
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); } } };
}

describe('phm job show (snapshot)', () => {
  it('--json prints one fleet.job.window.v1 object with every fact', async () => {
    const job = 'RQ-SHOWPUB';
    await put(`${job}.launch`, `launched ${job} codex pid 4242 base 1234abc\n`, at(0));
    await put(`${job}.base.meta`, 'MODEL codex work model-x\n', at(0));
    await put(`${job}.log`, 'first step\nsecond step\n', at(5));
    await put(`${job}.publish`, 'RESULT PR https://github.com/o/r/pull/1\n', at(10));
    await mkdir(join(runs, 'metrics'));
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ job, event: 'launch', ts: at(0).toISOString(), repo: 'o/r' })}\n`);

    const c = capture();
    const code = await cmdJobShow([job, '--json', '--runs-dir', runs], c.deps);
    expect(code).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out).toHaveLength(1);
    const w = JSON.parse(c.out[0]!) as FleetJobWindowV1;
    expect(w.schema).toBe('fleet.job.window.v1');
    expect(Object.keys(w)).toEqual(expect.arrayContaining([
      'job', 'state', 'stateLine', 'reason', 'lane', 'model', 'repo', 'tier',
      'startedAt', 'finishedAt', 'prUrl', 'facts', 'log',
    ]));
    expect(w.job).toBe(job);
    expect(w.state).toBe('finished-pr');
    expect(w.lane).toBe('codex');
    expect(w.model).toBe('model-x');
    expect(w.tier).toBe('work');
    expect(w.repo).toBe('o/r');
    expect(w.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(w.facts.map(f => f.label)).toEqual(['Lane', 'Model', 'Repo', 'Tier', 'Started', 'Finished', 'Pull request']);
    expect(w.log.lines).toEqual(['first step', 'second step']);
  });

  it('text mode prints the state line, the facts and "unknown" where there is no evidence', async () => {
    const job = 'RQ-SHOWRUN';
    await put(`${job}.launch`, `launched ${job} codex pid 4242 base 1234abc\n`, at(0));
    await put(`${job}.log`, 'working now\n', at(5));

    const c = capture();
    const code = await cmdJobShow([job, '--runs-dir', runs], c.deps);
    expect(code).toBe(0);
    expect(c.out[0]).toBe(`Job ${job}: Running now.`);
    expect(c.out.some(l => /^\s+Repo\s+unknown$/.test(l))).toBe(true);
    expect(c.out.some(l => /^\s+Model\s+unknown$/.test(l))).toBe(true);
    expect(c.out).toContain('working now');
  });

  it('--tail limits the log lines', async () => {
    const job = 'RQ-SHOWTAIL';
    await put(`${job}.launch`, `launched ${job} codex pid 4242 base 1234abc\n`, at(0));
    await put(`${job}.log`, 'one\ntwo\nthree\n', at(5));
    const c = capture();
    expect(await cmdJobShow([job, '--json', '--tail', '2', '--runs-dir', runs], c.deps)).toBe(0);
    expect((JSON.parse(c.out[0]!) as FleetJobWindowV1).log.lines).toEqual(['two', 'three']);
  });

  it('an unknown job prints its window and exits 1', async () => {
    const c = capture();
    expect(await cmdJobShow(['RQ-NOSUCH', '--runs-dir', runs], c.deps)).toBe(1);
    expect(c.out[0]).toBe('Job RQ-NOSUCH: State unknown.');
  });

  it('a thrown read is a plain error and exit 1', async () => {
    const c = capture();
    const code = await cmdJobShow(['RQ-BROKEN'], { ...c.deps, window: async () => { throw new Error('boom'); } });
    expect(code).toBe(1);
    expect(c.err).toEqual(['error: job window unavailable']);
    expect(c.out).toEqual([]);
  });

  it('--help and -h print usage and exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const c = capture();
      expect(await cmdJobShow([flag], c.deps)).toBe(0);
      expect(c.out.join('\n')).toContain('phm job show <id>');
    }
  });

  it.each([
    [[]],
    [['--json']],
    [['RQ-ONE', '--tail', '0']],
    [['RQ-ONE', '--tail', '201']],
    [['RQ-ONE', '--tail', '2.5']],
    [['RQ-ONE', '--tail']],
    [['RQ-ONE', '--json', '--json']],
    [['RQ-ONE', '--tail', '3', '--tail', '4']],
    [['RQ-ONE', '--nope']],
    [['RQ-ONE', 'RQ-TWO']],
    [['RQ-ONE', '--runs-dir', 'relative/dir']],
  ])('bad usage %j exits 2', async args => {
    const c = capture();
    let called = false;
    expect(await cmdJobShow(args, { ...c.deps, window: async () => { called = true; throw new Error('unused'); } })).toBe(2);
    expect(called).toBe(false);
    expect(c.err.join('\n')).toContain('Usage: phm job show');
  });
});

describe('phm job show --follow', () => {
  const JOB = 'RQ-FOLLOW';
  const win = (f: Omit<JobWindowFacts, 'job'>): FleetJobWindowV1 => buildJobWindow({ job: JOB, lane: 'codex', ...f });

  function fake(windows: FleetJobWindowV1[]) {
    const calls: FleetJobWindowOptions[] = [];
    const window = async (_job: string, options: FleetJobWindowOptions = {}) => {
      calls.push(options);
      const next = windows.shift();
      if (!next) throw new Error('no more windows');
      return next;
    };
    return { calls, window };
  }

  it('prints only new lines, passes the cursor back as after, and ends with the final state', async () => {
    const { calls, window } = fake([
      win({ detailState: 'running', lines: ['old one', 'old two'], cursor: 20 }),
      win({ detailState: 'running', lines: ['new three'], cursor: 30, since: 20, more: true }),
      win({ detailState: 'running', lines: ['new four'], cursor: 40, since: 30 }),
      win({ detailState: 'running', lines: [], cursor: 40, since: 40 }),
      win({ detailState: 'published', prUrl: 'https://github.com/o/r/pull/1', lines: ['new five'], cursor: 50, since: 40 }),
    ]);
    const waits: number[] = [];
    const c = capture();
    const code = await cmdJobShow([JOB, '--follow', '--tail', '5'], {
      ...c.deps, window, intervalMs: 7, wait: async ms => { waits.push(ms); },
    });
    expect(code).toBe(0);
    expect(calls.map(o => o.after)).toEqual([undefined, 20, 30, 40, 40]);
    expect(calls.every(o => o.lines === 5)).toBe(true);
    // `more` on the second poll skips one wait.
    expect(waits).toEqual([7, 7, 7]);
    const afterSnapshot = c.out.slice(c.out.indexOf('old two') + 1);
    expect(afterSnapshot).toEqual(['new three', 'new four', 'new five', `Job ${JOB}: Finished with a pull request.`]);
    expect(c.out.filter(l => l === 'old one')).toHaveLength(1);
  });

  it('--json emits one window per poll with new lines or a changed state', async () => {
    const { window } = fake([
      win({ detailState: 'running', lines: ['old'], cursor: 10 }),
      win({ detailState: 'running', lines: [], cursor: 10, since: 10 }),
      win({ detailState: 'running', lines: ['fresh'], cursor: 20, since: 10 }),
      win({ detailState: 'archived', lines: [], cursor: 20, since: 20 }),
    ]);
    const c = capture();
    expect(await cmdJobShow([JOB, '--follow', '--json'], { ...c.deps, window, wait: async () => {} })).toBe(0);
    const rows = c.out.map(l => JSON.parse(l) as FleetJobWindowV1);
    expect(rows.map(r => [r.state, r.log.lines])).toEqual([
      ['running', ['old']],
      ['running', ['fresh']],
      ['finished-empty', []],
    ]);
  });

  it('does not follow a job that is not running', async () => {
    const { calls, window } = fake([win({ detailState: 'archived', lines: ['done'] })]);
    const c = capture();
    expect(await cmdJobShow([JOB, '--follow'], { ...c.deps, window, wait: async () => {} })).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('Ctrl-C (abort) ends the follow with exit 0', async () => {
    const controller = new AbortController();
    const { calls, window } = fake([
      win({ detailState: 'running', lines: [], cursor: null }),
      win({ detailState: 'running', lines: ['late'], cursor: 5 }),
    ]);
    const c = capture();
    const code = await cmdJobShow([JOB, '--follow'], {
      ...c.deps, window, signal: controller.signal,
      wait: async () => { if (calls.length >= 2) controller.abort(); },
    });
    expect(code).toBe(0);
    // A null cursor re-reads the snapshot (after undefined).
    expect(calls.map(o => o.after)).toEqual([undefined, undefined]);
    expect(c.out).toContain('late');
  });
});
