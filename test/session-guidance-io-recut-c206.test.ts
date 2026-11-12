/** RQ-PHX-RECUTDESKOLDC206 — recut coverage for the #3297 session-guidance-io
 * slice (RQ-PHX-SESSIONINTERJECT): the append-only writer, the bounded readers
 * and the /api/fleet/** guidance routes, exercised through their real entry
 * points against a temp ASHLR_RUNS_DIR. The pure contract (strategy table,
 * ack fold, job-id guard, 4 KiB cap) is covered by test/session-guidance.test.ts.
 * Hermetic: mkdtemp dirs only, no real HOME, network or runs state. */
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GUIDANCE_DIR,
  GUIDANCE_TEXT_MAX_BYTES,
} from '../src/core/fleet/session-guidance.js';
import {
  appendSessionGuidance,
  listSessionGuidance,
  readJobLaneAndTier,
  readSessionGuidance,
} from '../src/core/fleet/session-guidance-io.js';
import { handleApi } from '../src/core/web/api.js';
import { defaultConfig } from '../src/core/config.js';

const JOB = 'RQ-PHX-TEST-1';
const NOW = () => Date.parse('2026-11-03T19:31:00.000Z');

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'guidance-c206-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const file = (job = JOB) => join(dir, GUIDANCE_DIR, `${job}.jsonl`);
const lines = async (job = JOB) =>
  (await readFile(file(job), 'utf8')).trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

describe('appendSessionGuidance', () => {
  it('appends one scrubbed record per call and never truncates history', async () => {
    const first = await appendSessionGuidance(JOB, 'first note', { runsDir: dir, now: NOW });
    const second = await appendSessionGuidance(JOB, 'second note', { runsDir: dir, now: () => NOW() + 60_000 });
    expect(first).toMatchObject({ ok: true, job: JOB, state: 'queued', strategy: 'requeue', truncated: false });
    expect(second.ok).toBe(true);
    const rows = await lines();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ v: 1, type: 'guidance', job: JOB, text: 'first note', at: '2026-11-03T19:31:00.000Z' });
    expect(rows[1]).toMatchObject({ text: 'second note' });
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });

  it('creates the directory 0700 and the file 0600 (the umask-077 posture)', async () => {
    await appendSessionGuidance(JOB, 'note', { runsDir: dir });
    const dirStat = await stat(join(dir, GUIDANCE_DIR));
    const fileStat = await stat(file());
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it('scrubs secret-shaped text before it lands', async () => {
    const secret = `xai-${'a'.repeat(24)}`;
    const result = await appendSessionGuidance(JOB, `use key ${secret} please`, { runsDir: dir });
    expect(result.ok).toBe(true);
    const raw = await readFile(file(), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[REDACTED]');
  });

  it('caps one message at 4 KiB and marks it truncated', async () => {
    const result = await appendSessionGuidance(JOB, 'x'.repeat(5_000), { runsDir: dir });
    expect(result).toMatchObject({ ok: true, truncated: true });
    const rows = await lines();
    expect(Buffer.byteLength(String(rows[0]!.text), 'utf8')).toBeLessThanOrEqual(GUIDANCE_TEXT_MAX_BYTES);
    expect(rows[0]!.truncated).toBe(true);
  });

  it.each(['../escape', 'a/b', 'a..b', '', 'bad id'])('refuses traversal-shaped id %j without writing', async (job) => {
    const result = await appendSessionGuidance(job, 'note', { runsDir: dir });
    expect(result).toEqual({ ok: false, code: 'invalid-job' });
    await expect(readdir(join(dir, GUIDANCE_DIR)).catch(() => [])).resolves.toEqual([]);
  });

  it('refuses an empty (or scrubbed-empty) message', async () => {
    expect(await appendSessionGuidance(JOB, '   ', { runsDir: dir })).toEqual({ ok: false, code: 'empty' });
  });

  it('stores the lane and tier read from the runs dir, and the resolved strategy', async () => {
    await writeFile(join(dir, `${JOB}.base.meta`), `MODEL claude work claude-opus-4 extra\n`, 'utf8');
    const result = await appendSessionGuidance(JOB, 'note', { runsDir: dir });
    expect(result).toMatchObject({ ok: true, lane: 'claude', tier: 'work', strategy: 'resume-followup', strategyFamily: 'claude' });
    expect((await lines())[0]).toMatchObject({ lane: 'claude', tier: 'work', strategy: 'resume-followup' });
  });

  it('falls back to the launch record for the lane', async () => {
    await writeFile(join(dir, `${JOB}.launch`), `launched ${JOB} codex-cmp pid 42 base deadbeef\n`, 'utf8');
    expect(await readJobLaneAndTier(JOB, dir)).toEqual({ lane: 'codex-cmp', tier: null });
    const result = await appendSessionGuidance(JOB, 'note', { runsDir: dir });
    expect(result).toMatchObject({ ok: true, lane: 'codex-cmp', strategy: 'resume' });
  });

  it('refuses to follow a symlinked guidance file', async () => {
    await mkdir(join(dir, GUIDANCE_DIR), { recursive: true });
    const target = join(dir, 'elsewhere.jsonl');
    await writeFile(target, '', 'utf8');
    await symlink(target, file());
    const result = await appendSessionGuidance(JOB, 'note', { runsDir: dir });
    expect(result).toEqual({ ok: false, code: 'unsafe-file' });
    expect((await readFile(target, 'utf8'))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

describe('readSessionGuidance', () => {
  it('answers missing for a job with no file', async () => {
    const read = await readSessionGuidance(JOB, { runsDir: dir });
    expect(read).toMatchObject({ v: 1, job: JOB, sourceState: 'missing', entries: [], pending: 0 });
  });

  it('folds acks into the entries and counts pending', async () => {
    const a = await appendSessionGuidance(JOB, 'first', { runsDir: dir, now: NOW, id: 'g-a' });
    await appendSessionGuidance(JOB, 'second', { runsDir: dir, now: () => NOW() + 1_000, id: 'g-b' });
    expect(a.ok && a.id).toBe('g-a');
    await appendFile(file(), JSON.stringify({ v: 1, type: 'ack', id: 'g-a', at: '2026-11-03T19:33:00.000Z', state: 'delivered', turn: 7 }) + '\n');
    const read = await readSessionGuidance(JOB, { runsDir: dir });
    expect(read.sourceState).toBe('healthy');
    expect(read.pending).toBe(1);
    expect(read.entries.map((entry) => [entry.id, entry.state, entry.turn])).toEqual([['g-a', 'delivered', 7], ['g-b', 'queued', null]]);
  });

  it('re-scrubs stored text on the way out', async () => {
    const secret = `xai-${'b'.repeat(24)}`;
    await mkdir(join(dir, GUIDANCE_DIR), { recursive: true });
    // A writer that skipped the scrub leaves a poisoned line; the reader still cleans it.
    await appendFile(file(), JSON.stringify({ v: 1, type: 'guidance', id: 'g-x', job: JOB, at: '2026-11-03T19:31:00.000Z', source: 'x', lane: 'claude', tier: null, strategy: 'resume-followup', text: `key ${secret}`, truncated: false }) + '\n');
    const read = await readSessionGuidance(JOB, { runsDir: dir });
    expect(read.entries[0]!.text).not.toContain(secret);
    expect(read.entries[0]!.text).toContain('[REDACTED]');
  });
});

describe('listSessionGuidance', () => {
  it('answers missing when the guidance dir does not exist', async () => {
    expect(await listSessionGuidance({ runsDir: dir })).toMatchObject({ sourceState: 'missing', sessions: [] });
  });

  it('summarizes each session: pending count and the latest ack state', async () => {
    await appendSessionGuidance(JOB, 'one', { runsDir: dir, id: 'g-1', lane: 'agy', tier: 'work' });
    await appendSessionGuidance(JOB, 'two', { runsDir: dir, id: 'g-2', lane: 'agy', tier: 'work' });
    await appendSessionGuidance('RQ-PHX-TEST-2', 'other', { runsDir: dir, id: 'g-9', lane: 'devin', tier: 'mid' });
    await appendFile(file(), JSON.stringify({ v: 1, type: 'ack', id: 'g-1', state: 'requeued', to: 'RQ-PHX-TEST-9' }) + '\n');
    const list = await listSessionGuidance({ runsDir: dir });
    expect(list.sourceState).toBe('healthy');
    expect(list.sessions).toHaveLength(2);
    const mine = list.sessions.find((s) => s.job === JOB)!;
    expect(mine).toMatchObject({ lane: 'agy', strategy: 'stream-json-inject', pending: 1 });
    expect(mine.latest).toMatchObject({ id: 'g-2', state: 'queued' });
    const other = list.sessions.find((s) => s.job === 'RQ-PHX-TEST-2')!;
    expect(other).toMatchObject({ lane: 'devin', strategy: 'requeue', pending: 1 });
  });

  it('ignores files whose names are not guidance files', async () => {
    await mkdir(join(dir, GUIDANCE_DIR), { recursive: true });
    await writeFile(join(dir, GUIDANCE_DIR, '..%2f.jsonl'), 'x\n');
    await writeFile(join(dir, GUIDANCE_DIR, 'not-a-job.txt'), 'x\n');
    await writeFile(join(dir, GUIDANCE_DIR, '.hidden'), 'x\n');
    await appendSessionGuidance(JOB, 'one', { runsDir: dir });
    const list = await listSessionGuidance({ runsDir: dir });
    expect(list.sessions.map((s) => s.job)).toEqual([JOB]);
  });
});

// ---------------------------------------------------------------------------
// The routes (handleApi, same gate as the interject box)
// ---------------------------------------------------------------------------

function response() {
  let status = 0;
  let body = '';
  const headers: Record<string, unknown> = {};
  const res = {
    writeHead: (code: number, values: Record<string, unknown>) => { status = code; Object.assign(headers, values); },
    end: (value: string) => { body = value; },
    setHeader: (name: string, value: unknown) => { headers[name] = value; },
    headersSent: false,
  } as unknown as ServerResponse;
  return { res, result: () => ({ status, headers, body: body ? JSON.parse(body) as unknown : null }) };
}

function post(url: string, payload: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([JSON.stringify(payload)]) as unknown as IncomingMessage;
  req.url = url;
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', ...headers };
  return req;
}

describe('guidance routes', () => {
  beforeEach(() => { vi.stubEnv('ASHLR_RUNS_DIR', dir); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('POST is 404 without allowDispatch and 401 without the token', async () => {
    const cfg = defaultConfig();
    const url = `/api/fleet/sessions/${JOB}/guidance`;
    let out = response();
    expect(await handleApi(post(url, { text: 'hi' }, { 'x-ashlr-token': 't' }), out.res, cfg, { token: 't', allowDispatch: false })).toBe(true);
    expect(out.result().status).toBe(404);
    out = response();
    await handleApi(post(url, { text: 'hi' }), out.res, cfg, { token: 't', allowDispatch: true });
    expect(out.result().status).toBe(401);
    out = response();
    const wrongType = post(url, { text: 'hi' }, { 'x-ashlr-token': 't' });
    wrongType.headers['content-type'] = 'text/plain';
    await handleApi(wrongType, out.res, cfg, { token: 't', allowDispatch: true });
    expect(out.result().status).toBe(415);
  });

  it('POST writes the file and answers the resolved strategy', async () => {
    const cfg = defaultConfig();
    await writeFile(join(dir, `${JOB}.base.meta`), 'MODEL agy frontier agy-1\n', 'utf8');
    const out = response();
    const url = `/api/fleet/sessions/${JOB}/guidance`;
    expect(await handleApi(post(url, { text: 'switch to the small model' }, { 'x-ashlr-token': 't' }), out.res, cfg, { token: 't', allowDispatch: true })).toBe(true);
    const result = out.result();
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ v: 1, ok: true, job: JOB, lane: 'agy', strategy: 'stream-json-inject', state: 'queued', truncated: false });
    const rows = await lines();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'guidance', text: 'switch to the small model' });
  });

  it('POST refuses bad ids and bad bodies', async () => {
    const cfg = defaultConfig();
    let out = response();
    await handleApi(post('/api/fleet/sessions/..%2Fetc/guidance', { text: 'hi' }, { 'x-ashlr-token': 't' }), out.res, cfg, { token: 't', allowDispatch: true });
    expect(out.result().status).toBe(400);
    out = response();
    await handleApi(post(`/api/fleet/sessions/${JOB}/guidance`, { text: '' }, { 'x-ashlr-token': 't' }), out.res, cfg, { token: 't', allowDispatch: true });
    expect(out.result().status).toBe(400);
    out = response();
    await handleApi(post(`/api/fleet/sessions/${JOB}/guidance`, { text: 'x', extra: 1 }, { 'x-ashlr-token': 't' }), out.res, cfg, { token: 't', allowDispatch: true });
    expect(out.result().status).toBe(400);
    await expect(readdir(join(dir, GUIDANCE_DIR)).catch(() => [])).resolves.toEqual([]);
  });

  it('GET the per-job read and the aggregate', async () => {
    const cfg = defaultConfig();
    await appendSessionGuidance(JOB, 'note', { runsDir: dir, id: 'g-1', lane: 'devin' });
    const req = { url: `/api/fleet/sessions/${JOB}/guidance`, method: 'GET', headers: {} } as unknown as IncomingMessage;
    let out = response();
    await handleApi(req, out.res, cfg, { token: 't', allowDispatch: false });
    expect(out.result().status).toBe(200);
    expect(out.result().body).toMatchObject({ v: 1, job: JOB, sourceState: 'healthy', strategy: 'requeue', pending: 1 });
    out = response();
    await handleApi({ url: '/api/fleet/guidance', method: 'GET', headers: {} } as unknown as IncomingMessage, out.res, cfg, { token: 't', allowDispatch: false });
    expect(out.result().status).toBe(200);
    expect(out.result().body).toMatchObject({ v: 1, sourceState: 'healthy' });
  });

  it('PUT and DELETE get 405', async () => {
    const cfg = defaultConfig();
    const out = response();
    await handleApi({ url: `/api/fleet/sessions/${JOB}/guidance`, method: 'DELETE', headers: {} } as unknown as IncomingMessage, out.res, cfg, { token: 't', allowDispatch: true });
    expect(out.result().status).toBe(405);
  });
});
