/**
 * RQ-PHX-DOTREPLYOWNERPARITY306S — owner-parity qualification for still-open
 * owner PR #5105 (RQ-PHX-DOTREPLYAPIRECOVER161, head
 * d2782c130d4d9a4c9cf12e28b4dfc8f13a5aefcf). Its production module and its
 * unit suite are byte-identical on master, and its six real-router cases are
 * preserved verbatim by teammate-reply-age-router-preserved-186s /
 * teammate-reply-age-router-recovered-199s and extended by
 * dot-reply-age-original-route-241s — so this file pins ONLY the original
 * comms.teammate-reply-age.v1 contract facets those suites leave unexercised,
 * through the real handleVerseApi → comms-teammate-reply workbench family →
 * delegation → real readRows on a per-test temporary HOME. Fake rowids,
 * senders and text only; times and flags are all that can leave.
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
import { VERSE_COMMS_TEAMMATE_REPLY_AGE_PATH as PATH } from '../src/core/verse/comms-teammate-reply-age-api.js';
import {
  handleVerseApi,
  setMountedApiModulesForTest,
  setWorkbenchApiModulesForTest,
  type VerseApiContext,
} from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let tmpHome: string;
let prevHome: string | undefined;
let imessageDir: string;
let ledger: string;

beforeEach(() => {
  setMountedApiModulesForTest(null);
  setWorkbenchApiModulesForTest(null);
  tmpHome = mkdtempSync(join(tmpdir(), 'teammate-reply-age-parity-306s-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // Resolve through the real owner-dir function — the same expression the
  // handler evaluates per request — so the fake ledger sits exactly where the
  // production read looks.
  imessageDir = join(fixedOwnerRunsDir(), 'imessage');
  ledger = join(imessageDir, 'teammates.jsonl');
});
afterEach(() => {
  setMountedApiModulesForTest(null);
  setWorkbenchApiModulesForTest(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeLedger(rows: readonly TeammateRow[]): void {
  mkdirSync(imessageDir, { recursive: true, mode: 0o700 });
  writeFileSync(ledger, rows.map(row => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
}

function fakeReq(method: string): IncomingMessage {
  const req = new PassThrough();
  req.end();
  return Object.assign(req, { url: PATH, method, headers: { host: '127.0.0.1:9' } }) as unknown as IncomingMessage;
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

/** The current Verse routing entry point, exactly as the server calls it. */
async function route(method = 'GET') {
  const { res, state } = fakeRes();
  const ctx = { cfg: {} as AshlrConfig, token: 'x'.repeat(64), allowDispatch: true } as VerseApiContext;
  const handled = await handleVerseApi(ctx, fakeReq(method), res, PATH, method);
  return { handled, status: state.status, text: state.body, body: state.body ? JSON.parse(state.body) : null };
}

describe('owner parity: original #5105 reply-age contract facets the preserved suites leave open', () => {
  it('answered tracks ONLY the newest rowid: an unanswered older text does not mask an answered newest', async () => {
    // Mirror of the preserved "older answered + newer unanswered" case: here the
    // OLDER text has no marker at all while the newest does. If `answered` ever
    // meant "every inbound answered" or "any marker exists", this turns false.
    writeLedger([
      { v: 1, at: iso(NOW - 30 * 60_000), rowid: 40, senderId: 'fake-sender-1', text: 'fake older unanswered' },
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'fake-sender-1', text: 'fake newer answered' },
      { v: 1, answered: 41, at: iso(NOW - 60_000) },
    ]);
    const r = await route();
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1', source: 'healthy',
      lastInboundAt: iso(NOW - 4 * 60_000), lastOutboundAt: iso(NOW - 60_000), answered: true,
    });
  });

  it('equal timestamps resolve to the higher rowid — the later arrival is the newest text', async () => {
    // rowid is the arrival order: at equal `at`, the higher rowid landed later.
    // Only rowid 50 carries a marker, so answered=false proves 51 — not 50 —
    // is the newest inbound the projection reports, in either file order.
    const tied = (first: number, second: number): TeammateRow[] => [
      { v: 1, at: iso(NOW - 10 * 60_000), rowid: first, senderId: 'fake-sender-1', text: `fake rowid ${first}` },
      { v: 1, at: iso(NOW - 10 * 60_000), rowid: second, senderId: 'fake-sender-1', text: `fake rowid ${second}` },
      { v: 1, answered: 50, at: iso(NOW - 5 * 60_000) },
    ];
    for (const rows of [tied(50, 51), tied(51, 50)]) {
      writeLedger(rows);
      const r = await route();
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        schema: 'comms.teammate-reply-age.v1', source: 'healthy',
        lastInboundAt: iso(NOW - 10 * 60_000), lastOutboundAt: null, answered: false,
      });
    }
  });

  it('a clean ledger with no inbound text is healthy with a null projection — not missing, not fabricated', async () => {
    // Marker rows alone prove the file parses; with no inbound rowid the
    // projection is the same null triple a missing file gives, but `source`
    // stays honest: the ledger exists and is clean.
    writeLedger([{ v: 1, answered: 41, at: iso(NOW - 60_000) }]);
    const r = await route();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1', source: 'healthy',
      lastInboundAt: null, lastOutboundAt: null, answered: null,
    });
  });

  it('an inbound row missing its text is dropped and degrades the source — never counted as newest', async () => {
    // The -4m row has rowid/senderId but no `text`: readRows refuses it as a
    // text row (and flags degraded), so the -30m row stays newest and its own
    // marker still answers it.
    writeLedger([
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'fake-sender-1' },
      { v: 1, at: iso(NOW - 30 * 60_000), rowid: 40, senderId: 'fake-sender-1', text: 'fake older text' },
      { v: 1, answered: 40, at: iso(NOW - 25 * 60_000) },
    ]);
    const r = await route();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1', source: 'degraded',
      lastInboundAt: iso(NOW - 30 * 60_000), lastOutboundAt: iso(NOW - 25 * 60_000), answered: true,
    });
  });

  it('duplicate answer markers keep the latest marker time, whatever the file order', async () => {
    // answeredAt keeps the max `at` per rowid — written here latest-first so a
    // last-line-wins reader would answer -60s, not -30s.
    writeLedger([
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'fake-sender-1', text: 'fake text' },
      { v: 1, answered: 41, at: iso(NOW - 30_000) },
      { v: 1, answered: 41, at: iso(NOW - 60_000) },
    ]);
    const r = await route();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1', source: 'healthy',
      lastInboundAt: iso(NOW - 4 * 60_000), lastOutboundAt: iso(NOW - 30_000), answered: true,
    });
  });

  it('file order does not decide newest — the timestamps do', async () => {
    // The newest text sits FIRST in the ledger; a last-line-wins read would
    // report rowid 40 instead.
    writeLedger([
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'fake-sender-1', text: 'fake newest written first' },
      { v: 1, answered: 41, at: iso(NOW - 60_000) },
      { v: 1, at: iso(NOW - 30 * 60_000), rowid: 40, senderId: 'fake-sender-1', text: 'fake older written last' },
      { v: 1, answered: 40, at: iso(NOW - 25 * 60_000) },
    ]);
    const r = await route();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1', source: 'healthy',
      lastInboundAt: iso(NOW - 4 * 60_000), lastOutboundAt: iso(NOW - 60_000), answered: true,
    });
  });
});
