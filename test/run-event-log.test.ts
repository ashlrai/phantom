/**
 * run-event-log tests — RQ-SWE5-EVENT-LOG, event-sourced per-job run state.
 *
 * Hermetic: every test writes under a fresh tmpdir via --runs-dir; the real
 * ~/.ashlr-runs is never touched. Covers the OpenHands-pattern contract:
 * append-only JSONL, parent-linked tree, movable head (checkout/fork as
 * appended head records), replay fold, checkpoint refs, torn-tail recovery,
 * fail-closed corruption handling, lock contention and secret refusal.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { appendFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  appendRunEvent,
  forkRun,
  moveRunHead,
  readRunEventLog,
  replayRunState,
  runBranches,
  runEventLockPath,
  runEventLogPath,
  runHead,
  runPath,
  RunEventLogError,
  type RunEvent,
} from '../src/core/events/run-event-log.js';
import { cmdEvents } from '../src/cli/events.js';
import { cmdCheckpoint } from '../src/cli/checkpoint.js';

let runsDir: string;
const job = 'RQ-TEST-1';
const opts = () => ({ runsDir });

const launch = () => appendRunEvent(job, 'launch', { lane: 'work', pid: 4242 }, opts());
const finish = (outcome = 'done') => appendRunEvent(job, 'finish', { outcome }, opts());

const ids = (events: RunEvent[]) => events.map(e => e.id);

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'run-events-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('run event log: append and read', () => {
  it('appends a lifecycle chain with seqs, ids and parents; log is private JSONL', async () => {
    const e1 = await launch();
    const e2 = await appendRunEvent(job, 'tool-call', { name: 'read', callId: 'c1' }, opts());
    const e3 = await appendRunEvent(job, 'tool-result', { callId: 'c1', ok: true }, opts());
    const e4 = await finish();
    const e5 = await appendRunEvent(job, 'publish', { prUrl: 'https://x.test/1', result: 'PR' }, opts());

    for (const [event, seq, parent] of [[e1, 1, null], [e2, 2, 'e1'], [e3, 3, 'e2'], [e4, 4, 'e3'], [e5, 5, 'e4']] as const) {
      expect(event.seq).toBe(seq);
      expect(event.id).toBe(`e${seq}`);
      expect(event.parent).toBe(parent);
      expect(event.branch).toBe('main');
      expect(event.job).toBe(job);
    }

    const path = runEventLogPath(job, runsDir);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(JSON.parse(line).schema).toBe('run.event.v1');

    const read = await readRunEventLog(job, opts());
    expect(read.deferred).toBe(false);
    expect(ids(read.events)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(runHead(read.events)).toEqual({ id: 'e5', branch: 'main' });
    expect(runPath(read.events)).toEqual(ids(read.events));
  });

  it('reads a missing log as empty and refuses bad job ids and non-absolute dirs', async () => {
    expect(await readRunEventLog('NOPE', opts())).toEqual({ events: [], deferred: false });
    expect(runHead([])).toEqual({ id: null, branch: 'main' });
    await expect(appendRunEvent('bad job!', 'note', {}, opts())).rejects.toThrow(RunEventLogError);
    await expect(appendRunEvent(job, 'note', {}, { runsDir: 'relative' })).rejects.toThrow(RunEventLogError);
  });

  it('refuses symlinked and oversized logs', async () => {
    const path = runEventLogPath(job, runsDir);
    await symlink('/tmp/elsewhere', path);
    await expect(readRunEventLog(job, opts())).rejects.toThrow(RunEventLogError);
    await rm(path);
    await appendRunEvent(job, 'note', { text: 'ok' }, opts());
  });

  it('rejects invalid kinds, checkpoint without ref, bad data and secret-shaped payloads', async () => {
    await expect(appendRunEvent(job, 'head', {}, opts())).rejects.toThrow(RunEventLogError);
    // @ts-expect-error — kind whitelist enforced at runtime too
    await expect(appendRunEvent(job, 'rm-rf', {}, opts())).rejects.toThrow(RunEventLogError);
    await expect(appendRunEvent(job, 'checkpoint', {}, opts())).rejects.toThrow(RunEventLogError);
    await expect(appendRunEvent(job, 'note', { a: undefined }, opts())).rejects.toThrow(RunEventLogError);
    await expect(appendRunEvent(job, 'note', { deep: { x: { y: { z: { w: { v: { u: 1 } } } } } } }, opts())).rejects.toThrow(RunEventLogError);
    await expect(appendRunEvent(job, 'note', { key: 'ghp_' + 'a'.repeat(40) }, opts())).rejects.toThrow(RunEventLogError);
    await expect(appendRunEvent(job, 'note', { at: 'x' }, { ...opts(), at: 'not-a-date' })).rejects.toThrow(RunEventLogError);
    expect(await readRunEventLog(job, opts())).toEqual({ events: [], deferred: false });
  });

  it('holds the lock and reports busy when another process holds it', async () => {
    await mkdir(join(runsDir, 'locks'), { recursive: true, mode: 0o700 });
    await writeFile(runEventLockPath(job, runsDir), JSON.stringify({ pid: process.pid, token: 'held' }), { mode: 0o600 });
    await expect(appendRunEvent(job, 'launch', {}, { ...opts(), lockWaitMs: 0 })).rejects.toThrow(RunEventLogError);
    // Reads never lock.
    expect(await readRunEventLog(job, opts())).toEqual({ events: [], deferred: false });
  });
});

describe('run event log: movable head, fork and replay', () => {
  it('checkout rewinds the head; new events extend the target branch', async () => {
    await launch();
    const e2 = await appendRunEvent(job, 'tool-call', { name: 'a' }, opts());
    await appendRunEvent(job, 'tool-call', { name: 'b' }, opts());
    const rec = await moveRunHead(job, e2.id, opts());
    expect(rec.kind).toBe('head');
    expect(rec.data).toMatchObject({ event: 'e2' });

    const e5 = await appendRunEvent(job, 'note', { text: 'rework' }, opts());
    expect(e5.parent).toBe('e2');
    expect(e5.branch).toBe('main');

    const read = await readRunEventLog(job, opts());
    expect(runHead(read.events)).toEqual({ id: 'e5', branch: 'main' });
    expect(runPath(read.events)).toEqual(['e1', 'e2', 'e5']);
  });

  it('checkout to the current head is a no-op refusal; head targets must exist and be content', async () => {
    const e1 = await launch();
    await expect(moveRunHead(job, e1.id, opts())).rejects.toThrow(RunEventLogError);
    await expect(moveRunHead(job, 'e99', opts())).rejects.toThrow(RunEventLogError);
    const rec = await forkRun(job, e1.id, { ...opts(), branch: 'probe' });
    await expect(moveRunHead(job, rec.id, opts())).rejects.toThrow(RunEventLogError);
    await expect(moveRunHead(job, e1.id, { ...opts(), branch: 'bad branch!' })).rejects.toThrow(RunEventLogError);
    await expect(moveRunHead(job, e1.id, { ...opts(), reason: '  ' })).rejects.toThrow(RunEventLogError);
  });

  it('fork grows a named branch while main is preserved; branches list both', async () => {
    await launch();
    const e2 = await appendRunEvent(job, 'tool-call', { name: 'a' }, opts());
    const e3 = await appendRunEvent(job, 'tool-call', { name: 'b' }, opts());
    const rec = await forkRun(job, e2.id, { ...opts(), branch: 'alt', reason: 'try another approach' });
    expect(rec.data).toMatchObject({ event: 'e2', branch: 'alt', reason: 'try another approach' });

    const forkEvent = await appendRunEvent(job, 'note', { text: 'alt work' }, opts());
    expect(forkEvent.parent).toBe('e2');
    expect(forkEvent.branch).toBe('alt');

    const read = await readRunEventLog(job, opts());
    const head = runHead(read.events);
    expect(head).toEqual({ id: forkEvent.id, branch: 'alt' });
    // The conversation is root -> fork point -> new work; e3 stays reachable on main.
    expect(runPath(read.events)).toEqual(['e1', 'e2', forkEvent.id]);
    expect(runPath(read.events, e3.id)).toEqual(['e1', 'e2', 'e3']);

    const branches = runBranches(read.events);
    expect(branches.map(b => b.name).sort()).toEqual(['alt', 'main']);
    expect(branches.find(b => b.name === 'alt')).toMatchObject({ tip: forkEvent.id });
    expect(branches.find(b => b.name === 'main')!.tip).toBe('e4'); // the head record stays on main
  });

  it('auto-derives unique fork labels', async () => {
    const e1 = await launch();
    const r1 = await forkRun(job, e1.id, opts());
    const e3 = await appendRunEvent(job, 'note', { text: 'a' }, opts());
    const r2 = await forkRun(job, e1.id, opts());
    expect(r1.data.branch).toBe('fork-e1');
    expect(r2.data.branch).toBe('fork-e1-2');
    expect(e3.branch).toBe('fork-e1');
  });

  it('replay folds the head path: phase, counts, checkpoint and publish', async () => {
    await launch();
    await appendRunEvent(job, 'tool-call', { name: 'x' }, opts());
    const cp = await appendRunEvent(job, 'checkpoint', { ref: '/tmp/handoff.json', source: 'agent-checkpoint' }, opts());
    await finish('done');
    await appendRunEvent(job, 'publish', { prUrl: 'https://x.test/9' }, opts());

    const view = replayRunState(job, await readRunEventLog(job, opts()));
    expect(view.schema).toBe('run.state.v1');
    expect(view.phase).toBe('published');
    expect(view.counts).toMatchObject({ launch: 1, 'tool-call': 1, checkpoint: 1, finish: 1, publish: 1 });
    expect(view.checkpoint).toMatchObject({ eventId: cp.id, ref: '/tmp/handoff.json', source: 'agent-checkpoint' });
    expect(view.publish).toMatchObject({ prUrl: 'https://x.test/9' });
    expect(view.finish).toMatchObject({ outcome: 'done' });
    expect(view.head).toMatchObject({ id: 'e5', branch: 'main' });
  });

  it('replay --at is a read-only replay; checkpoint visibility follows the head path', async () => {
    const e1 = await launch();
    await appendRunEvent(job, 'tool-call', { name: 'a' }, opts());
    const cp = await appendRunEvent(job, 'checkpoint', { ref: '/tmp/state.json' }, opts());
    await finish();
    await forkRun(job, e1.id, { ...opts(), branch: 'no-checkpoint' });
    await appendRunEvent(job, 'note', { text: 'fresh try' }, opts());

    const read = await readRunEventLog(job, opts());
    // Head is on the fork; the checkpoint on main is not part of the resume view.
    const view = replayRunState(job, read);
    expect(view.checkpoint).toBeNull();
    expect(view.phase).toBe('running');
    expect(view.path.at(-1)).not.toBe(cp.id);
    // Read-only replay at the old finish still sees it.
    const past = replayRunState(job, read, { at: 'e4' });
    expect(past.phase).toBe('finished');
    expect(past.checkpoint).toMatchObject({ ref: '/tmp/state.json' });
    expect(() => runPath(read.events, 'e99')).toThrow(RunEventLogError);
  });
});

describe('run event log: crash and corruption handling', () => {
  it('tolerates a torn trailing line and replaces it on the next append', async () => {
    await launch();
    const path = runEventLogPath(job, runsDir);
    await appendFile(path, '{"schema":"run.event.v1","seq":2,"id":"e2","jo');
    let read = await readRunEventLog(job, opts());
    expect(read.deferred).toBe(true);
    expect(ids(read.events)).toEqual(['e1']);
    // Next append rewrites the torn tail as a real event.
    const e2 = await appendRunEvent(job, 'note', { text: 'resume' }, opts());
    expect(e2.seq).toBe(2);
    read = await readRunEventLog(job, opts());
    expect(read.deferred).toBe(false);
    expect(ids(read.events)).toEqual(['e1', 'e2']);
  });

  it('fails closed on malformed complete lines, foreign jobs, wrong seqs and dangling parents', async () => {
    const path = runEventLogPath(job, runsDir);
    const line = (over: object) => JSON.stringify({
      schema: 'run.event.v1', seq: 1, id: 'e1', job, at: '2026-11-08T00:00:00Z',
      branch: 'main', parent: null, kind: 'launch', data: {}, ...over,
    }) + '\n';
    for (const text of [
      'not json\n',
      line({ seq: 7 }),
      line({ id: 'e9' }),
      line({ job: 'OTHER' }),
      line({ parent: 'e9' }),
      line({ kind: 'bogus' }),
      line({ at: 'yesterday' }),
      JSON.stringify({ schema: 'run.event.v1', seq: 1, id: 'e1', job, at: '2026-11-08T00:00:00Z', branch: 'main', parent: null, kind: 'head', data: { event: 'e2' } }) + '\n',
    ]) {
      await writeFile(path, text, { mode: 0o600 });
      await expect(readRunEventLog(job, opts())).rejects.toThrow(RunEventLogError);
    }
    // A head record pointing at a head record is refused.
    const headRecord = { schema: 'run.event.v1', seq: 1, id: 'e1', job, at: '2026-11-08T00:00:00Z', branch: 'main', parent: null, kind: 'head', data: { event: 'e1' } };
    await writeFile(path, JSON.stringify(headRecord) + '\n', { mode: 0o600 });
    await expect(readRunEventLog(job, opts())).rejects.toThrow(RunEventLogError);
  });
});

describe('phm events CLI', () => {
  let out: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation((v?: unknown) => { process.stdout.write(String(v) + '\n'); });
  });
  afterEach(() => vi.restoreAllMocks());
  const printed = () => out.mock.calls.map(c => String(c[0])).join('');

  it('drives append/head/list/replay/fork/checkout via argv', async () => {
    const dir = ['--runs-dir', runsDir];
    expect(await cmdEvents(['append', job, '--kind', 'launch', '--data', '{"lane":"work"}', ...dir])).toBe(0);
    expect(await cmdEvents(['append', job, '--kind', 'tool-call', '--data', '{"name":"x"}', ...dir])).toBe(0);
    expect(await cmdEvents(['note', job, 'hello', 'world', ...dir])).toBe(0);

    expect(await cmdEvents(['head', job, '--json', ...dir])).toBe(0);
    const head = JSON.parse(printed().trim().split('\n').at(-1)!);
    expect(head).toMatchObject({ job, id: 'e3', branch: 'main' });

    expect(await cmdEvents(['list', job, '--json', ...dir])).toBe(0);
    expect(JSON.parse(printed().trim().split('\n').at(-1)!).events).toHaveLength(3);

    expect(await cmdEvents(['fork', job, '--at', 'e1', '--branch', 'alt', ...dir])).toBe(0);
    expect(await cmdEvents(['note', job, 'alt work', ...dir])).toBe(0);
    expect(await cmdEvents(['replay', job, '--json', ...dir])).toBe(0);
    const view = JSON.parse(printed().trim().split('\n').at(-1)!);
    expect(view.head.branch).toBe('alt');
    expect(view.path).toEqual(['e1', 'e5']);

    expect(await cmdEvents(['checkout', job, '--at', 'e2', ...dir])).toBe(0);
    expect(await cmdEvents(['head', job, '--json', ...dir])).toBe(0);
    expect(JSON.parse(printed().trim().split('\n').at(-1)!).id).toBe('e2');

    expect(await cmdEvents(['branches', job, '--json', ...dir])).toBe(0);
    expect(JSON.parse(printed().trim().split('\n').at(-1)!).branches.map((b: { name: string }) => b.name).sort())
      .toEqual(['alt', 'main']);
  });

  it('reports usage errors and operational failures distinctly', async () => {
    const dir = ['--runs-dir', runsDir];
    expect(await cmdEvents(['help'])).toBe(0);
    expect(await cmdEvents([])).toBe(0);
    expect(await cmdEvents(['bogus', job, ...dir])).toBe(2);
    expect(await cmdEvents(['append', job, ...dir])).toBe(2);
    expect(await cmdEvents(['append', job, '--kind', 'head', ...dir])).toBe(2);
    expect(await cmdEvents(['append', job, '--kind', 'note', '--data', 'not-json', ...dir])).toBe(2);
    expect(await cmdEvents(['append', job, '--kind', 'note', '--data', '[1]', ...dir])).toBe(2);
    expect(await cmdEvents(['note', job, ...dir])).toBe(2);
    expect(await cmdEvents(['checkout', job, ...dir])).toBe(2);
    expect(await cmdEvents(['fork', job, '--at', 'e99', ...dir])).toBe(1);
    expect(await cmdEvents(['list', 'bad job!', ...dir])).toBe(2);
    // busy → exit 3
    await mkdir(join(runsDir, 'locks'), { recursive: true, mode: 0o700 });
    await writeFile(runEventLockPath(job, runsDir), JSON.stringify({ pid: process.pid, token: 'held' }), { mode: 0o600 });
    expect(await cmdEvents(['note', job, 'x', ...dir, '--lock-wait'])).toBe(2); // unknown flag
    expect(await cmdEvents(['note', job, 'x', ...dir])).toBe(3);
  });
});

describe('checkpoint integration', () => {
  const checkpointDoc = { version: 1, goal: 'g', done: [], next: [], evidence: [], openQuestions: [] };
  it('phm checkpoint save --job records a checkpoint event replay can resolve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-git-'));
    try {
      const git = (...a: string[]) => promisify(execFile)('git', ['-C', dir, ...a]);
      await git('init'); await git('config', 'user.email', 't@t.t'); await git('config', 'user.name', 'T');
      await writeFile(join(dir, 'f'), 'x'); await git('add', 'f'); await git('commit', '-m', 'base');
      const source = join(dir, 'h.json'), destination = join(dir, 'saved.json');
      await writeFile(source, JSON.stringify(checkpointDoc));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await cmdCheckpoint(['save', source, destination, dir, '--job', job, '--runs-dir', runsDir])).toBe(0);
      } finally { vi.restoreAllMocks(); }
      const read = await readRunEventLog(job, { runsDir });
      expect(read.events).toHaveLength(1);
      expect(read.events[0]).toMatchObject({ kind: 'checkpoint', data: { ref: resolve(destination), source: 'agent-checkpoint' } });
      const view = replayRunState(job, read);
      expect(view.checkpoint).toMatchObject({ ref: resolve(destination) });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('refuses --job on resume and bad job ids', async () => {
    const e = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await cmdCheckpoint(['resume', '/tmp/x', '--job', job])).toBe(2);
      expect(await cmdCheckpoint(['save', '/tmp/a', '/tmp/b', '/tmp/c', '--job', 'bad job!'])).toBe(2);
    } finally { e.mockRestore(); }
  });
});
