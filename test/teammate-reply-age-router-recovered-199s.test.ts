/** RQ-PHX-DOTROUTERTESTRECOVER199S: preserves the six real-router cases of
 * test/teammate-reply-age-router-preserved-186s.test.ts from Phantom PR #5195
 * head 3910ac6560c0a431474d2210150c5fe044063d96 (job RQ-PHX-DOTROUTERCOVER186S),
 * itself preserving the original six router cases of
 * test/teammate-reply-age-router-s161.test.ts from PR #5105 head
 * 2e52cdfa5dc68a649844de70c454df264aea563c.
 * GET /api/verse/comms/teammate-reply-age through the REAL verse router
 * (handleVerseApi + the default workbench/mount tables), with the durable
 * teammates.jsonl fixture under a per-test temporary HOME that
 * fixedOwnerRunsDir() resolves via realHome() -> process home under Vitest.
 * Fake rowids/senders only; the response must carry times and flags, never
 * text, sender ids, handles or numbers. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleVerseApi, setMountedApiModulesForTest, setWorkbenchApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';

const PATH = '/api/verse/comms/teammate-reply-age';
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

// fixedOwnerRunsDir() resolves <realHome>/.ashlr-runs; under Vitest realHome is
// the process home, so each test gets its own throwaway HOME and the mounted
// module reads <tmpHome>/.ashlr-runs/imessage/teammates.jsonl. Cleanup removes
// only the directory this test created — never the worker home or the real
// ~/.ashlr-runs.
let tmpHome: string;
let prevHome: string | undefined;
let imessageDir: string;
let teammatesFile: string;

beforeEach(() => {
  setMountedApiModulesForTest(null);
  setWorkbenchApiModulesForTest(null);
  tmpHome = mkdtempSync(join(tmpdir(), 'teammate-reply-age-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  imessageDir = join(tmpHome, '.ashlr-runs', 'imessage');
  teammatesFile = join(imessageDir, 'teammates.jsonl');
});
afterEach(() => {
  setMountedApiModulesForTest(null);
  setWorkbenchApiModulesForTest(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeRawTeammates(content: string): void {
  mkdirSync(imessageDir, { recursive: true, mode: 0o700 });
  writeFileSync(teammatesFile, content, { mode: 0o600 });
}
function writeRows(rows: Record<string, unknown>[]): void {
  writeRawTeammates(rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

async function dispatch(method: string, allowDispatch = true) {
  let status = 0;
  let text = '';
  const req = Object.assign(new PassThrough(), {
    method,
    url: PATH,
    headers: {},
  }) as IncomingMessage & PassThrough;
  req.end();
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body?: string) { text = body ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { cfg: {}, token: 'x'.repeat(64), allowDispatch } as VerseApiContext;
  const handled = await handleVerseApi(ctx, req, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null, raw: text };
}

describe('GET /api/verse/comms/teammate-reply-age via the real router', () => {
  it('reaches the mounted module: a newer unanswered row is not answered by an older marker', async () => {
    writeRows([
      { v: 1, at: iso(NOW - 30 * 60_000), rowid: 40, senderId: 'teammate-test-1', text: 'fake older text' },
      { v: 1, answered: 40, at: iso(NOW - 25 * 60_000) },
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'teammate-test-1', text: 'fake newer text' },
    ]);
    const r = await dispatch('GET');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1',
      source: 'healthy',
      lastInboundAt: iso(NOW - 4 * 60_000),
      lastOutboundAt: null,
      answered: false,
    });
  });

  it('reports the answer marker time when the newest inbound row is answered', async () => {
    writeRows([
      { v: 1, at: iso(NOW - 30 * 60_000), rowid: 40, senderId: 'teammate-test-1', text: 'fake older text' },
      { v: 1, answered: 40, at: iso(NOW - 25 * 60_000) },
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'teammate-test-1', text: 'fake newer text' },
      { v: 1, answered: 41, at: iso(NOW - 60_000) },
    ]);
    const r = await dispatch('GET');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      schema: 'comms.teammate-reply-age.v1',
      source: 'healthy',
      lastInboundAt: iso(NOW - 4 * 60_000),
      lastOutboundAt: iso(NOW - 60_000),
      answered: true,
    });
  });

  it('absent input: no teammates file answers missing with null times, not an error', async () => {
    const r = await dispatch('GET');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1',
      source: 'missing',
      lastInboundAt: null,
      lastOutboundAt: null,
      answered: null,
    });
  });

  it('malformed input: a torn teammates.jsonl is degraded, never a fabricated time', async () => {
    writeRawTeammates(
      `${JSON.stringify({ v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'teammate-test-1', text: 'fake' })}\n`
      + '{"v":1,"at":"not-json"\n',
    );
    const r = await dispatch('GET');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      schema: 'comms.teammate-reply-age.v1',
      source: 'degraded',
      lastInboundAt: iso(NOW - 4 * 60_000),
      answered: false,
    });
  });

  it('the serialized response carries no message text, sender ids, handles or phone numbers', async () => {
    writeRows([
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'teammate-test-1', text: 'fake secret body' },
      { v: 1, answered: 41, at: iso(NOW - 60_000) },
    ]);
    const r = await dispatch('GET');
    expect(r.status).toBe(200);
    expect(r.raw).not.toContain('fake secret body');
    expect(r.raw).not.toContain('teammate-test-1');
    expect(Object.keys(r.body).sort()).toEqual(['answered', 'lastInboundAt', 'lastOutboundAt', 'schema', 'source']);
  });

  it('a non-GET never reaches the read: dispatch closed means 404, open means the mutation gate', async () => {
    const closed = await dispatch('POST', false);
    expect(closed.status).toBe(404);
    // Open dispatch without the mutation token headers is refused by the gate.
    const open = await dispatch('POST', true);
    expect(open.status).not.toBe(200);
  });
});
