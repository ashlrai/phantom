/** Agent sessions: create, fold, observe the queue, resume, retry, terminate, and the CLI. */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSessionError, createAgentSession, foldSession, getAgentSession, listAgentSessions, resumeAgentSession, terminateAgentSession,
} from '../src/core/agents/session.js';
import { QueueStore } from '../src/core/queue/store.js';
import type { QueueJob } from '../src/core/queue/schema.js';
import { cmdSessions } from '../src/cli/sessions.js';

let root: string;
let dir: string;
let queueDir: string;
let store: QueueStore;
const previousHome = process.env.ASHLR_HOME;

const job = (id: string): QueueJob => ({
  id, status: 'READY', priority: 'P1', pool: 'claude', tier: 'T2', repo: 'phantom',
  scope: 'Write the session doc', acceptance: 'Doc exists', deps: [], claims: [],
});
const create = (jobId = 'J1') => createAgentSession({ agentId: 'helper', agentVersion: 2, environmentId: 'local', jobId, queueDir }, { dir });
const code = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; return 'none'; } catch (error) { return error instanceof AgentSessionError ? error.code : String(error); }
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agent-sessions-'));
  dir = join(root, 'home', 'agent-sessions');
  queueDir = join(root, 'queue');
  store = new QueueStore(queueDir);
  await store.add(job('J1'));
  process.env.ASHLR_HOME = join(root, 'home');
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('agent sessions core', () => {
  it('creates a running session whose first turn is the queue job, with a private log', async () => {
    const session = await create();
    expect(session).toMatchObject({ schema: 'agent-session.v1', status: 'running', agent: { id: 'helper', version: 2 }, environmentId: 'local', queueDir });
    expect(session.id).toMatch(/^sesn_[0-9a-f]{16}$/);
    expect(session.turns).toEqual([expect.objectContaining({ turn: 1, jobId: 'J1', source: 'create', queueStatus: 'READY' })]);
    const file = join(dir, `${session.id}.jsonl`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => line.type)).toEqual(['session.created', 'turn.queued']);
    // Scope text stays in the queue.
    expect(readFileSync(file, 'utf8')).not.toContain('Write the session doc');
  });

  it('refuses invalid references, unknown jobs and a job already owned by a live session', async () => {
    expect(await code(createAgentSession({ agentId: '../x', agentVersion: 1, environmentId: 'local', jobId: 'J1', queueDir }, { dir }))).toBe('invalid');
    expect(await code(createAgentSession({ agentId: 'helper', agentVersion: 0, environmentId: 'local', jobId: 'J1', queueDir }, { dir }))).toBe('invalid');
    expect(await code(createAgentSession({ agentId: 'helper', agentVersion: 1, environmentId: 'a b', jobId: 'J1', queueDir }, { dir }))).toBe('invalid');
    expect(await code(create('NOPE'))).toBe('not-found');
    const first = await create();
    expect(await code(create())).toBe('conflict');
    await terminateAgentSession(first.id, {}, { dir });
    expect(await code(create())).toBe('none');
  });

  it('observes queue status changes into the append-only log and folds them into status', async () => {
    const { id } = await create();
    await store.claim('J1', 'worker');
    expect((await getAgentSession(id, { dir })).session.status).toBe('running');
    await store.finish('J1', 'worker');
    const { session, events } = await getAgentSession(id, { dir });
    expect(session.status).toBe('idle');
    expect(events.filter(e => e.type === 'turn.observed').map(e => 'queueStatus' in e && e.queueStatus)).toEqual(['CLAIMED', 'DONE']);
    expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4]);
    // A second read with no queue change appends nothing.
    expect((await getAgentSession(id, { dir })).events).toHaveLength(4);
  });

  it('resumes an idle session with a new turn job that copies routing fields', async () => {
    const { id } = await create();
    await store.claim('J1', 'worker');
    await store.finish('J1', 'worker', { prUrl: 'https://example.invalid/pr/1' });
    expect(await code(resumeAgentSession(id, {}, { dir }))).toBe('invalid');
    const { session, job } = await resumeAgentSession(id, { scope: 'Address review comments' }, { dir });
    expect(job).toMatchObject({ id: `${id}.t2`, status: 'READY', pool: 'claude', repo: 'phantom', scope: 'Address review comments', acceptance: 'Doc exists' });
    expect(session.status).toBe('running');
    expect(session.turns.map(t => [t.turn, t.jobId, t.source])).toEqual([[1, 'J1', 'create'], [2, `${id}.t2`, 'resume']]);
    expect((await store.read()).jobs.map(j => j.id)).toEqual(['J1', `${id}.t2`]);
    expect(await code(resumeAgentSession(id, { scope: 'again' }, { dir }))).toBe('running');
  });

  it('marks a blocked turn rescheduling and retries it through queue replay', async () => {
    const { id } = await create();
    await store.claim('J1', 'worker');
    await store.finish('J1', 'worker', { reason: 'flaky test' });
    expect((await getAgentSession(id, { dir })).session.status).toBe('rescheduling');
    const { session, job } = await resumeAgentSession(id, {}, { dir });
    expect(job).toMatchObject({ replayOf: 'J1', status: 'READY', scope: 'Write the session doc' });
    expect(session.turns.at(-1)).toMatchObject({ turn: 2, jobId: job.id, source: 'retry' });
    expect(session.status).toBe('running');
  });

  it('adopts a replay made with phm queue replay as the next turn', async () => {
    const { id } = await create();
    await store.claim('J1', 'worker');
    await store.finish('J1', 'worker', { reason: 'flaky test' });
    const [replayed] = await store.replay({ ids: ['J1'] });
    const { session } = await getAgentSession(id, { dir });
    expect(session.turns.at(-1)).toMatchObject({ turn: 2, jobId: replayed.id, source: 'replay' });
    expect(session.status).toBe('running');
  });

  it('adopts a resume job whose log append was lost', async () => {
    const { id } = await create();
    await store.claim('J1', 'worker');
    await store.finish('J1', 'worker');
    await store.add(job(`${id}.t2`));
    const { session } = await getAgentSession(id, { dir });
    expect(session.turns.at(-1)).toMatchObject({ turn: 2, jobId: `${id}.t2`, source: 'resume' });
  });

  it('terminates once, scrubs the reason, stops observing and refuses resume', async () => {
    const { id } = await create();
    const reason = `done here ${'ghp_' + 'a'.repeat(36)}`;
    const first = await terminateAgentSession(id, { reason }, { dir });
    expect(first.alreadyTerminated).toBe(false);
    expect(first.session.status).toBe('terminated');
    expect(readFileSync(join(dir, `${id}.jsonl`), 'utf8')).not.toContain('ghp_');
    expect((await terminateAgentSession(id, {}, { dir })).alreadyTerminated).toBe(true);
    await store.claim('J1', 'worker');
    const { events } = await getAgentSession(id, { dir });
    expect(events.some(e => e.type === 'turn.observed')).toBe(false);
    expect(await code(resumeAgentSession(id, { scope: 'more' }, { dir }))).toBe('terminated');
  });

  it('skips torn or forged lines and keeps appending parseable events', async () => {
    const { id } = await create();
    const file = join(dir, `${id}.jsonl`);
    appendFileSync(file, '{"seq":9,"ts":"2026-11-09T00:00:00Z","type":"turn.queued","turn":7,"jobId":"X","source":"create","queueStatus":"READY"}\n{"torn":');
    await store.claim('J1', 'worker');
    const { session, events } = await getAgentSession(id, { dir });
    expect(session.skippedLines).toBe(2);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].queueStatus).toBe('CLAIMED');
    expect(events.at(-1)?.seq).toBe(10);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean).at(-1)).toContain('"turn.observed"');
  });

  it('rejects bad ids, missing sessions and symlinked logs', async () => {
    expect(await code(getAgentSession('../../etc', { dir }))).toBe('invalid-id');
    expect(await code(getAgentSession('sesn_0000000000000000', { dir }))).toBe('not-found');
    const { id } = await create();
    const real = join(root, 'elsewhere.jsonl');
    writeFileSync(real, readFileSync(join(dir, `${id}.jsonl`)));
    rmSync(join(dir, `${id}.jsonl`));
    symlinkSync(real, join(dir, `${id}.jsonl`));
    expect(await code(getAgentSession(id, { dir }))).toBe('invalid');
  });

  it('lists newest first, reports unreadable logs, and keeps the last status when the queue is unreadable', async () => {
    const a = await create();
    await store.add(job('J2'));
    const b = await create('J2');
    writeFileSync(join(dir, 'sesn_ffffffffffffffff.jsonl'), 'not json\n');
    writeFileSync(join(queueDir, 'queue.v1.json'), '{"schema":"wrong"}');
    const listed = await listAgentSessions({ dir });
    expect(listed.sessions.map(s => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(listed.sessions.every(s => s.status === 'running')).toBe(true);
    expect(listed.errors).toEqual([expect.objectContaining({ id: 'sesn_ffffffffffffffff' })]);
    const shown = await getAgentSession(a.id, { dir });
    expect(shown.session.queueError).toMatch(/queue\.v1/);
  });

  it('folds an empty or headless log as invalid', () => {
    expect(() => foldSession('sesn_0000000000000000', [])).toThrow(AgentSessionError);
  });
});

describe('phm sessions (agent verbs)', () => {
  const run = async (args: string[]): Promise<{ status: number; out: string[]; err: string }> => {
    const out: string[] = [];
    let err = '';
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
    try { return { status: await cmdSessions(args), out, err }; }
    finally { stderr.mockRestore(); stdout.mockRestore(); vi.mocked(console.log).mockRestore(); }
  };

  it('creates, shows, resumes and terminates with --json', async () => {
    const created = await run(['create', '--agent', 'helper', '--agent-version', '3', '--environment', 'local', '--job', 'J1', '--dir', queueDir, '--json']);
    expect(created.status).toBe(0);
    const { session } = JSON.parse(created.out[0]);
    expect(session.agent).toEqual({ id: 'helper', version: 3 });

    const shown = await run(['show', session.id, '--json']);
    expect(JSON.parse(shown.out[0]).events).toHaveLength(2);

    const busy = await run(['resume', session.id, '--scope', 'next', '--json']);
    expect(busy.status).toBe(1);
    expect(JSON.parse(busy.out[0])).toMatchObject({ ok: false, reason: 'running' });

    await store.claim('J1', 'worker');
    await store.finish('J1', 'worker');
    const resumed = await run(['resume', session.id, '--scope', 'next', '--json']);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.out[0]).job.id).toBe(`${session.id}.t2`);

    const listed = await run(['list', '--json']);
    const body = JSON.parse(listed.out[0]);
    expect(body.sessions).toEqual([]);
    expect(body.agentSessions.map((s: { id: string }) => s.id)).toEqual([session.id]);

    const ended = await run(['terminate', session.id, '--reason', 'shipped', '--json']);
    expect(JSON.parse(ended.out[0])).toMatchObject({ ok: true, alreadyTerminated: false, session: { status: 'terminated', terminationReason: 'shipped' } });
  });

  it('prints human output and usage errors', async () => {
    const created = await run(['create', '--agent', 'helper', '--agent-version', '1', '--environment', 'local', '--job', 'J1', '--dir', queueDir]);
    expect(created.out[0]).toMatch(/^Created sesn_[0-9a-f]{16} \(running\)\. Turn 1 is job J1\.$/);
    const id = created.out[0].split(' ')[1];
    const shown = await run(['show', id]);
    expect(shown.out[0]).toContain('running');
    expect(shown.out[1]).toContain('turn 1  J1  READY');
    expect((await run(['list'])).out.join('\n')).toContain('Agent sessions:');

    expect((await run(['create', '--agent', 'helper', '--json'])).status).toBe(2);
    expect((await run(['create', '--agent', 'helper', '--agent-version', 'two', '--environment', 'local', '--job', 'J1', '--json'])).status).toBe(2);
    expect((await run(['show'])).status).toBe(2);
    expect((await run(['show', id, '--bogus'])).status).toBe(2);
    expect((await run(['show', 'nope', '--json'])).status).toBe(2);
    expect((await run(['show', 'sesn_0000000000000000'])).status).toBe(1);
    expect((await run(['resume', '--help'])).status).toBe(0);
  });
});
