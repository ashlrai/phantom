/**
 * Route-level preservation of original PR #4744 (RQ-PHX-DOTREPLYAGE85) through
 * the CURRENT public route family, end to end:
 *
 *   handleVerseApi → dispatchWorkbenchModules → workbench family
 *   'comms-teammate-reply' → handleCommsTeammateReplyApi →
 *   handleCommsTeammateReplyAgeApi → the real teammates.jsonl under
 *   fixedOwnerRunsDir().
 *
 * The original's A10 mount-table entry is intentionally gone — the family owns
 * both prefixes now — so the route is proven at the current routing entry
 * point, not the retired mount table. The only interceptions are the
 * owner-file reader boundaries the module itself declares: the JSONL bytes
 * (a relocated HOME points fixedOwnerRunsDir at a temp dir — the repo's own
 * isolation facility) and, for the unavailable case, the documented `read`
 * seam. The age handler itself is never mocked. Fake rowids, senders and
 * text only; nothing leaves the response but times and flags.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedOwnerRunsDir } from '../src/core/comms/owner-channel.js';
import type { TeammateRow } from '../src/core/comms/imessage-teammate-inbox.js';
import type { AshlrConfig } from '../src/core/types.js';
import {
  createCommsTeammateReplyAgeApi,
  VERSE_COMMS_TEAMMATE_REPLY_AGE_PATH as PATH,
} from '../src/core/verse/comms-teammate-reply-age-api.js';
import {
  handleCommsTeammateReplyApi,
  VERSE_COMMS_TEAMMATE_REPLY_PATH as REPLY_PATH,
} from '../src/core/verse/comms-teammate-reply-api.js';
import {
  handleVerseApi,
  mountedApiModules,
  workbenchApiModules,
  type VerseApiContext,
} from '../src/core/verse/verse-api.js';
import { WORKBENCH_ROUTE_FAMILIES, workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
import { dotReplyAge, type DotReplyAgeRead } from '../src/web-ui/routes/verse/leader-thread/DotReplyAge.model.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const TOKEN = 'x'.repeat(64);
const MUTATE = { 'x-ashlr-token': TOKEN, 'content-type': 'application/json' };

let tmpHome: string;
let prevHome: string | undefined;
let imessageDir: string;
let ledger: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'dot-reply-age-original-route-241s-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // Resolve through the real owner-dir function — the same expression the
  // handler evaluates per request — so the fake ledger sits exactly where the
  // production read looks.
  imessageDir = join(fixedOwnerRunsDir(), 'imessage');
  ledger = join(imessageDir, 'teammates.jsonl');
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeLedger(rows: readonly TeammateRow[]): void {
  mkdirSync(imessageDir, { recursive: true, mode: 0o700 });
  writeFileSync(ledger, rows.map(row => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
}

function fakeReq(method: string, path: string, headers: Record<string, string> = {}, body?: string): IncomingMessage {
  const req = new PassThrough();
  if (body !== undefined) req.write(body);
  req.end();
  return Object.assign(req, { url: path, method, headers: { host: '127.0.0.1:9', ...headers } }) as unknown as IncomingMessage;
}

function fakeRes() {
  const state = { status: 0, body: '', headersSent: false, writableEnded: false };
  const res = {
    get headersSent() { return state.headersSent; },
    get writableEnded() { return state.writableEnded; },
    writeHead(code: number) { state.status = code; state.headersSent = true; return this; },
    setHeader() { return this; },
    write() { return true; },
    end(body?: unknown) { state.body = typeof body === 'string' ? body : ''; state.writableEnded = true; return this; },
    on() { return this; },
    once() { return this; },
  };
  return { res: res as unknown as ServerResponse, state };
}

const ctx = (allowDispatch: boolean): VerseApiContext =>
  ({ cfg: {} as AshlrConfig, token: TOKEN, allowDispatch });

/** The current Verse routing entry point, exactly as the server calls it. */
async function route(method: string, path: string, opts: { allowDispatch?: boolean; headers?: Record<string, string>; body?: string } = {}) {
  const { res, state } = fakeRes();
  const handled = await handleVerseApi(ctx(opts.allowDispatch ?? true), fakeReq(method, path, opts.headers, opts.body), res, path, method);
  const parsed = state.body ? JSON.parse(state.body) as DotReplyAgeRead & Record<string, unknown> : null;
  return { handled, status: state.status, text: state.body, body: parsed };
}

describe('the current route family wiring', () => {
  it('one workbench family owns the age path and resolves to the real delegation — no A10 mount, no duplicate', async () => {
    const families = WORKBENCH_ROUTE_FAMILIES.filter(family => family.id === 'comms-teammate-reply');
    expect(families).toHaveLength(1);
    expect(families[0]?.handler).toBe('handleCommsTeammateReplyApi');
    expect(families[0]?.prefixes).toEqual([REPLY_PATH, PATH]);
    expect(workbenchFamilyFor(PATH)?.id).toBe('comms-teammate-reply');
    // Prefix-boundary hygiene: a child is the family's own path, `…-ageX` is nobody's.
    expect(workbenchFamilyFor(`${PATH}/child`)?.id).toBe('comms-teammate-reply');
    expect(workbenchFamilyFor(`${PATH}X`)).toBeNull();
    const mounts = workbenchApiModules().filter(module => module.id === 'comms-teammate-reply');
    expect(mounts).toHaveLength(1);
    // The loader performs the real dynamic import; identity proves the mounted
    // handler IS the exported delegation (age first by exact path, then POST reply).
    expect(await mounts[0]?.load()).toBe(handleCommsTeammateReplyApi);
    // The retired A10 mount-table entry stays retired: neither name reappears there.
    expect(mountedApiModules().map(module => module.id)).not.toContain('comms-teammate-reply');
    expect(mountedApiModules().map(module => module.id)).not.toContain('comms-teammate-reply-age');
  });
});

describe('GET /api/verse/comms/teammate-reply-age through handleVerseApi', () => {
  it('reaches the age projection and feeds the Leader model "answered" evidence', async () => {
    writeLedger([
      { v: 1, at: iso(NOW - 40 * 60_000), rowid: 10, senderId: 'fake-sender-1', text: 'fake older text' },
      { v: 1, answered: 10, at: iso(NOW - 35 * 60_000) },
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 11, senderId: 'fake-sender-1', text: 'fake newer text' },
      { v: 1, answered: 11, at: iso(NOW - 1 * 60_000) },
    ]);
    const r = await route('GET', PATH);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1', source: 'healthy',
      lastInboundAt: iso(NOW - 4 * 60_000), lastOutboundAt: iso(NOW - 1 * 60_000), answered: true,
    });
    expect(dotReplyAge(r.body, NOW)).toMatchObject({ bucket: 'answered', answered: true, ageMinutes: 4, text: 'Dot: last text 4 min ago, answered' });
  });

  it('newest-rowid matching keeps an old reply from answering a newer text', async () => {
    writeLedger([
      { v: 1, at: iso(NOW - 40 * 60_000), rowid: 10, senderId: 'fake-sender-1', text: 'fake older text' },
      { v: 1, at: iso(NOW - 6 * 60_000), rowid: 11, senderId: 'fake-sender-1', text: 'fake newer text' },
      // A marker for the OLDER text written AFTER the newer text arrived: a
      // clock-only comparison would wrongly call the newer text answered.
      { v: 1, answered: 10, at: iso(NOW - 2 * 60_000) },
    ]);
    const r = await route('GET', PATH);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1', source: 'healthy',
      lastInboundAt: iso(NOW - 6 * 60_000), lastOutboundAt: null, answered: false,
    });
    expect(dotReplyAge(r.body, NOW)).toMatchObject({ bucket: 'ok', answered: false, ageMinutes: 6, text: 'Dot: last text 6 min ago, NOT answered' });
  });

  it('unanswered evidence past the ten-minute mark reaches the model as late', async () => {
    writeLedger([{ v: 1, at: iso(NOW - 23 * 60_000), rowid: 11, senderId: 'fake-sender-1', text: 'fake text' }]);
    const r = await route('GET', PATH);
    expect(r.body).toMatchObject({ lastInboundAt: iso(NOW - 23 * 60_000), lastOutboundAt: null, answered: false });
    expect(dotReplyAge(r.body, NOW)).toMatchObject({ bucket: 'late', answered: false, ageMinutes: 23, text: 'Dot: last text 23 min ago, NOT answered' });
  });

  it('a missing ledger stays unknown — route reports missing, model reports no record', async () => {
    const r = await route('GET', PATH);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ schema: 'comms.teammate-reply-age.v1', source: 'missing', lastInboundAt: null, lastOutboundAt: null, answered: null });
    expect(dotReplyAge(r.body, NOW)).toMatchObject({ bucket: 'unknown', answered: false, ageMinutes: null, text: 'Dot: no iMessage record yet' });
  });

  it('a torn ledger degrades — the route still reports parsed rows, the model stays unknown', async () => {
    mkdirSync(imessageDir, { recursive: true, mode: 0o700 });
    writeFileSync(ledger, `${JSON.stringify({ v: 1, at: iso(NOW - 6 * 60_000), rowid: 11, senderId: 'fake-sender-1', text: 'fake text' })}\nnot-json\n`, { mode: 0o600 });
    const r = await route('GET', PATH);
    expect(r.body).toMatchObject({ source: 'degraded', lastInboundAt: iso(NOW - 6 * 60_000), lastOutboundAt: null, answered: false });
    expect(dotReplyAge(r.body, NOW)).toMatchObject({ bucket: 'unknown', ageMinutes: null, text: 'Dot: reply status unknown' });
  });

  it('a reader failure stays unavailable, never a fabricated time (the documented read seam)', async () => {
    // createCommsTeammateReplyAgeApi is the same factory the mounted singleton
    // was built with; `read` is the declared owner-file reader boundary, and a
    // boundary that throws must produce 'unavailable' — the real readRows can
    // never throw, so the seam is the only way to reach this branch.
    const api = createCommsTeammateReplyAgeApi({ read: () => { throw new Error('fake reader failure'); } });
    const { res, state } = fakeRes();
    expect(await api(ctx(true), fakeReq('GET', PATH), res, PATH, 'GET')).toBe(true);
    expect(state.status).toBe(200);
    const body = JSON.parse(state.body) as DotReplyAgeRead;
    expect(body).toEqual({ schema: 'comms.teammate-reply-age.v1', source: 'unavailable', lastInboundAt: null, lastOutboundAt: null, answered: null });
    expect(dotReplyAge(body, NOW)).toMatchObject({ bucket: 'unknown', ageMinutes: null, text: 'Dot: reply status unknown' });
  });
});

describe('gates and route hygiene through the router', () => {
  it('disallowed dispatch stays refused — the family gate for POST, the module for GET', async () => {
    writeLedger([{ v: 1, at: iso(NOW - 6 * 60_000), rowid: 11, senderId: 'fake-sender-1', text: 'fake text' }]);
    const getOff = await route('GET', PATH, { allowDispatch: false });
    expect(getOff.status).toBe(404);
    const postOff = await route('POST', PATH, { allowDispatch: false, headers: MUTATE, body: '{}' });
    expect(postOff.status).toBe(404);
    expect(postOff.body).toMatchObject({ error: `not found: POST ${PATH}` });
  });

  it('keeps the original POST route semantics — the age path stays 405, the reply POST still owns its path', async () => {
    // An untrusted mutation dies at the family gate before any module loads.
    expect((await route('POST', PATH)).status).toBe(401);
    // Past the gate, the age handler — first in the delegation — still says
    // read-only here (original semantics unchanged).
    const post = await route('POST', PATH, { headers: MUTATE, body: '{}' });
    expect(post.status).toBe(405);
    expect(post.body).toMatchObject({ error: 'The teammate reply age is read only here.' });
    // Delegation order by exact path: the sibling GET is the reply handler's
    // 405, not the age one.
    const sib = await route('GET', REPLY_PATH);
    expect(sib.status).toBe(405);
    expect(sib.body).toMatchObject({ error: 'Use POST to reply to a teammate.' });
    // And the reply POST itself still validates its own body.
    const bad = await route('POST', REPLY_PATH, { headers: MUTATE, body: '{}' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ v: 1, status: 'invalid' });
    // A child of the age path is the family's own 404 — no second module claims it.
    expect((await route('GET', `${PATH}/extra`)).status).toBe(404);
  });

  it('never emits message text or sender ids — times and flags only', async () => {
    writeLedger([{ v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'fake-sender-secret', text: 'fake body that must not leak' }]);
    const r = await route('GET', PATH);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('fake body that must not leak');
    expect(r.text).not.toContain('fake-sender-secret');
    expect(Object.keys(r.body ?? {}).sort()).toEqual(['answered', 'lastInboundAt', 'lastOutboundAt', 'schema', 'source']);
  });
});
