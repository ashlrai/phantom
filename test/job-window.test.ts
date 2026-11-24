/**
 * fleet.job.window.v1 — one job as one window (job-window.ts + runs-job-window.ts).
 *
 * Contract:
 *   - buildJobWindow is pure: each state (running, finished with a PR,
 *     finished with nothing, stopped, unknown) has one plain state line and
 *     a reason when one is known; a fact with no evidence is null on the wire
 *     and "unknown" in words.
 *   - getFleetJobWindow reads the runs dir read-only; the log tail carries a
 *     byte cursor and `after` returns only whole lines written since; every
 *     log line is redacted by scrubJobLogLine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJobWindow, jobWindowLive, jobWindowText, JOB_WINDOW_SCHEMA } from '../src/core/fleet/job-window.js';
import { getFleetJobWindow } from '../src/core/fleet/runs-job-window.js';
import { readFleetJobLog } from '../src/core/fleet/runs-job-tail.js';

const PR = 'https://github.com/acme/demo/pull/7';
const factValue = (w: ReturnType<typeof buildJobWindow>, label: string) => w.facts.find(f => f.label === label)?.value;

describe('buildJobWindow', () => {
  it('says running in plain words with no finish time yet', () => {
    const w = buildJobWindow({ job: 'RQ-ONE', detailState: 'running', lane: 'claude', model: 'opus', tier: 'frontier',
      startedAt: '2026-11-18T10:00:00Z', finishedAt: '2026-11-18T11:00:00Z', lines: ['step one'], cursor: 9 });
    expect(w).toMatchObject({ schema: JOB_WINDOW_SCHEMA, state: 'running', stateLine: 'Running now.', reason: null, finishedAt: null });
    expect(factValue(w, 'Finished')).toBe('not yet');
    expect(factValue(w, 'Pull request')).toBe('not yet');
    expect(w.log).toEqual({ lines: ['step one'], cursor: 9, since: null, truncated: false, more: false, empty: null });
    expect(jobWindowLive(w)).toBe(true);
  });

  it('says finished with a PR and links it', () => {
    const w = buildJobWindow({ job: 'RQ-ONE', detailState: 'published', prUrl: PR, finishedAt: '2026-11-18T11:00:00Z' });
    expect(w).toMatchObject({ state: 'finished-pr', stateLine: 'Finished with a pull request.', prUrl: PR, finishedAt: '2026-11-18T11:00:00Z' });
    expect(factValue(w, 'Pull request')).toBe(PR);
    expect(jobWindowLive(w)).toBe(false);
  });

  it('says finished with nothing, with the reason', () => {
    expect(buildJobWindow({ job: 'RQ-ONE', detailState: 'published', resultEmpty: true }))
      .toMatchObject({ state: 'finished-empty', stateLine: 'Finished with nothing to ship.', reason: 'The worker reported no change to publish.' });
    expect(buildJobWindow({ job: 'RQ-ONE', detailState: 'archived' }))
      .toMatchObject({ state: 'finished-empty', reason: 'The job ended without publishing a result.' });
    const w = buildJobWindow({ job: 'RQ-ONE', detailState: 'published', prUrl: 'javascript:alert(1)' });
    expect(w).toMatchObject({ state: 'finished-empty', prUrl: null });
    expect(factValue(w, 'Pull request')).toBe('none');
  });

  it('says stopped with who and when, unless a PR already shipped', () => {
    const stop = { at: '2026-11-18T10:30:00Z', by: 'cli' };
    const w = buildJobWindow({ job: 'RQ-ONE', detailState: 'running', stop });
    expect(w).toMatchObject({ state: 'stopped', stateLine: 'Stopped before it finished.', reason: 'Stopped by cli at 2026-11-18T10:30:00Z.', finishedAt: stop.at });
    expect(buildJobWindow({ job: 'RQ-ONE', detailState: 'published', prUrl: PR, stop }).state).toBe('finished-pr');
    expect(buildJobWindow({ job: 'RQ-ONE', detailState: 'archived', stop: { at: null, by: null } }).reason).toBe('Stopped.');
  });

  it('shows every unknown fact as unknown, never a guess', () => {
    const w = buildJobWindow({ job: 'RQ-ONE', note: 'Nothing about this job is recorded here.' });
    expect(w).toMatchObject({ state: 'unknown', stateLine: 'State unknown.', reason: 'Nothing about this job is recorded here.',
      lane: null, model: null, repo: null, tier: null, startedAt: null, finishedAt: null, prUrl: null });
    expect(w.facts.map(f => f.label)).toEqual(['Lane', 'Model', 'Repo', 'Tier', 'Started', 'Finished', 'Pull request']);
    expect(w.facts.slice(0, 6).every(f => f.value === 'unknown')).toBe(true);
    expect(buildJobWindow({ job: 'RQ-ONE', detailState: 'running', lane: '  ', startedAt: 'not a time' }).facts.slice(0, 5).map(f => f.value))
      .toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  });

  it('names an empty log in plain words for each case', () => {
    expect(buildJobWindow({ job: 'RQ-ONE', detailState: 'running' }).log.empty).toBe('No log lines yet.');
    expect(buildJobWindow({ job: 'RQ-ONE', detailState: 'running', since: 40 }).log.empty).toBe('No new lines.');
    expect(buildJobWindow({ job: 'RQ-ONE' }).log.empty).toBe('No log on this machine.');
    expect(buildJobWindow({ job: 'RQ-ONE', detailState: 'archived' }).log.empty).toBe('The log has no lines here.');
    expect(buildJobWindow({ job: 'RQ-ONE', detailState: 'running', cursor: -1 }).log.cursor).toBeNull();
  });

  it('renders terminal text with the state, the facts and the log', () => {
    const text = jobWindowText(buildJobWindow({ job: 'RQ-ONE', detailState: 'published', resultEmpty: true, lines: ['last line'], truncated: true }));
    expect(text[0]).toBe('Job RQ-ONE: Finished with nothing to ship.');
    expect(text[1]).toBe('The worker reported no change to publish.');
    expect(text).toContain('  Lane          unknown');
    expect(text.slice(-2)).toEqual(['… earlier lines not shown', 'last line']);
  });
});

describe('getFleetJobWindow (runs dir)', () => {
  let runs: string;
  const JOB = 'RQ-WINDOWTEST';
  const T0 = new Date('2026-11-18T10:00:00Z');
  const at = (s: number) => new Date(T0.getTime() + s * 1000);
  const now = () => at(60);
  async function put(name: string, text: string, mtime: Date): Promise<void> {
    await writeFile(join(runs, name), text);
    await utimes(join(runs, name), mtime, mtime);
  }
  async function launch(log: string | null): Promise<void> {
    await put(`${JOB}.launch`, `launched ${JOB} claude pid 4242 base 1234abcd\n`, at(0));
    await put(`${JOB}.base.meta`, 'MODEL claude frontier opus\n', at(0));
    if (log !== null) await put(`${JOB}.log`, log, at(5));
  }
  beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'job-window-')); });
  afterEach(async () => { await rm(runs, { recursive: true, force: true }); });

  it('reads a running job: facts, redacted lines and a cursor at the last whole line', async () => {
    await launch('one\nthe secret word is blue\ntwo\nhalf');
    const w = await getFleetJobWindow(JOB, { runsDir: runs, now });
    expect(w).toMatchObject({ state: 'running', lane: 'claude', tier: 'frontier', model: 'opus', startedAt: at(0).toISOString(), repo: null });
    expect(w.log.lines).toEqual(['one', '[redacted line]', 'two']);
    expect(w.log.cursor).toBe(Buffer.byteLength('one\nthe secret word is blue\ntwo\n'));
    expect(factValue(w, 'Repo')).toBe('unknown');
  });

  it('returns only newer whole lines after the cursor, then nothing new', async () => {
    await launch('one\ntwo\n');
    const first = await getFleetJobWindow(JOB, { runsDir: runs, now });
    await appendFile(join(runs, `${JOB}.log`), 'three\nfour\nfi');
    await utimes(join(runs, `${JOB}.log`), at(10), at(10));
    const next = await getFleetJobWindow(JOB, { runsDir: runs, now, after: first.log.cursor });
    expect(next.log).toMatchObject({ lines: ['three', 'four'], since: first.log.cursor, more: false });
    const again = await getFleetJobWindow(JOB, { runsDir: runs, now, after: next.log.cursor });
    expect(again.log).toMatchObject({ lines: [], empty: 'No new lines.', cursor: next.log.cursor });
  });

  it('pages a burst of new lines with more, never skipping one', async () => {
    await launch('');
    await appendFile(join(runs, `${JOB}.log`), 'a\nb\nc\nd\ne\n');
    const page = await readFleetJobLog(JOB, { runsDir: runs, after: 0, lines: 2 });
    expect(page).toMatchObject({ lines: ['a', 'b'], cursor: 4, more: true });
    const rest = await readFleetJobLog(JOB, { runsDir: runs, after: page.cursor, lines: 10 });
    expect(rest).toMatchObject({ lines: ['c', 'd', 'e'], cursor: 10, more: false });
  });

  it('restarts at zero when the log was replaced by a shorter one', async () => {
    await launch('x\n');
    expect(await readFleetJobLog(JOB, { runsDir: runs, after: 500 })).toMatchObject({ lines: ['x'], cursor: 2 });
  });

  it('reads an empty log as no lines with plain words', async () => {
    await launch('');
    const w = await getFleetJobWindow(JOB, { runsDir: runs, now });
    expect(w.log).toMatchObject({ lines: [], cursor: 0, empty: 'No log lines yet.' });
  });

  it('reads a finished job with a PR and the finish time from the ledger', async () => {
    await launch('done\n');
    await put(`${JOB}.publish`, `RESULT PR ${PR}\n`, at(30));
    await mkdir(join(runs, 'metrics'));
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ job: JOB, event: 'finish', ts: at(29).toISOString(), repo: 'demo' })}\n`);
    const w = await getFleetJobWindow(JOB, { runsDir: runs, now });
    expect(w).toMatchObject({ state: 'finished-pr', prUrl: PR, repo: 'demo', finishedAt: at(29).toISOString() });
    expect(w.log.lines).toEqual(['done']);
  });

  it('reads RESULT EMPTY as finished with nothing', async () => {
    await launch('done\n');
    await put(`${JOB}.publish`, 'RESULT EMPTY\n', at(30));
    expect(await getFleetJobWindow(JOB, { runsDir: runs, now })).toMatchObject({ state: 'finished-empty', reason: 'The worker reported no change to publish.' });
  });

  it('reads a stop of this attempt from the stop ledger, and ignores an older one', async () => {
    await launch('working\n');
    await mkdir(join(runs, 'queue'));
    const stops = join(runs, 'queue', 'job-stops.jsonl');
    await writeFile(stops, `${JSON.stringify({ at: at(-60).toISOString(), id: JOB, pids: [1], outcome: 'stopped', by: 'old' })}\n`);
    expect((await getFleetJobWindow(JOB, { runsDir: runs, now })).state).toBe('running');
    await appendFile(stops, `${JSON.stringify({ at: at(20).toISOString(), id: JOB, pids: [1], outcome: 'stopped', by: 'cli' })}\n`);
    expect(await getFleetJobWindow(JOB, { runsDir: runs, now }))
      .toMatchObject({ state: 'stopped', reason: `Stopped by cli at ${at(20).toISOString()}.`, finishedAt: at(20).toISOString() });
  });

  it('reads a job this machine never saw as unknown', async () => {
    const w = await getFleetJobWindow('RQ-NOWHERE', { runsDir: runs, now });
    expect(w).toMatchObject({ state: 'unknown', lane: null, log: { lines: [], cursor: null, empty: 'No log on this machine.' } });
    expect(w.reason).toMatch(/unknown here/);
  });

  it('refuses a bad id and a relative runs dir', async () => {
    await expect(getFleetJobWindow('../x', { runsDir: runs })).rejects.toThrow();
    await expect(getFleetJobWindow(JOB, { runsDir: 'relative' })).rejects.toThrow();
  });
});
