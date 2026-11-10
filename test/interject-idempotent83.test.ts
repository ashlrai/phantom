// RQ-PHX-STEERDOUBLESEND83: a requestId marks one composed steer message — a
// double submit, a retry or a reconnect replays the first ack and must not
// append a second MASON-INBOX.md line; distinct ids and id-less posts land
// one line each, and the ledger survives a Hub restart.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import * as bus from '../src/core/fleet/bus-inbox.js';
import { INTERJECT_POST_PATH, buildInterjectBody, mintInterjectRequestId } from '../src/web-ui/routes/verse/fleet/interject-request.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
let root: string;
let runsDir: string;
let busRoot: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), 'interject-idempotent83-'));
  runsDir = join(root, 'runs');
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  busRoot = join(root, 'ashlr', 'fleet');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const api = createFleetRunsApi;
async function call(handler: ReturnType<typeof api>, url: string, method: 'GET' | 'POST', body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'fake-token' };
  req.method = method;
  req.url = url;
  let status = 0;
  let out = '';
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; }, end(value: string) { out = value; } } as unknown as ServerResponse;
  await handler({ token: 'fake-token', allowDispatch: true } as VerseApiContext, req, res, url.split('?')[0]!, method);
  return { status, body: JSON.parse(out) as Record<string, unknown> };
}
const inboxLines = () => readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8').split('\n').filter(line => /\[src:/.test(line));
function busMessages() {
  const page = bus.listBusInboxAfter(0, 100, { root: busRoot, now: () => NOW });
  if (page.status !== 'ok') throw new Error('bus unavailable');
  return page.messages;
}

it('the same request id twice yields one inbox line and two identical acks', async () => {
  const handler = api({ runsDir, now: () => NOW });
  const body = buildInterjectBody('Order: hold lane claude', 'req-83aaa0000001');
  const first = await call(handler, INTERJECT_POST_PATH, 'POST', body);
  const second = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody('Order: hold lane claude', 'req-83aaa0000001'));
  expect(first.status).toBe(201);
  expect(first.body).toMatchObject({ ok: true, accepted: true });
  // The replay returns the first response verbatim — the UI shows landed.
  expect(second).toEqual(first);
  expect(inboxLines()).toHaveLength(1);
  expect(busMessages()).toHaveLength(1);
});

it('two different request ids yield two lines even for the same text', async () => {
  const handler = api({ runsDir, now: () => NOW });
  const first = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody('ship it', 'req-83bbb0000001'));
  const second = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody('ship it', 'req-83bbb0000002'));
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(second.body).not.toEqual(first.body);
  expect(inboxLines()).toHaveLength(2);
});

it('a request with no id keeps todays behavior: a line per distinct message', async () => {
  const handler = api({ runsDir, now: () => NOW });
  await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody('first order'));
  await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody('second order'));
  expect(inboxLines()).toHaveLength(2);
  // The receiver's text-window dedupe still catches an id-less resend.
  const third = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody('second order'));
  expect(third.body).toMatchObject({ duplicate: true });
  expect(inboxLines()).toHaveLength(2);
});

it('a minted client id is well formed and a resend after a restart replays the ack', async () => {
  const requestId = mintInterjectRequestId();
  expect(requestId).toMatch(/^req-[A-Za-z0-9._:-]{4,124}$/);
  const handler = api({ runsDir, now: () => NOW });
  const first = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody('Order: merge the queue', requestId));
  expect(first.status).toBe(201);
  // A restarted Hub (new API instance, same runsDir) still knows the id.
  const restarted = api({ runsDir, now: () => NOW });
  const second = await call(restarted, INTERJECT_POST_PATH, 'POST', buildInterjectBody('Order: merge the queue', requestId));
  expect(second).toEqual(first);
  expect(inboxLines()).toHaveLength(1);
});
