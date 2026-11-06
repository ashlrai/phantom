import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { handleAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const path = '/api/verse/agent-bus';
const token = 'fake-http-token';
const requestMessage = { id: 'fake-request', from: 'fake-mason', to: 'fake-agent', priority: 'P1', ttl: 1000, body: { task: 'fake work' } };
const replyMessage = { id: 'fake-reply', from: 'fake-agent', to: 'fake-mason', priority: 'P1', ttl: 1000, body: { inReplyTo: 'fake-request', result: 'fake result' } };
let home: string;
let now: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fake-http-cli-bus-'));
  vi.stubEnv('ASHLR_HOME', join(home, 'ashlr'));
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// Exercise the exported production handler with the same request context as the
// HTTP family tests, without opening a socket or substituting storage functions.
async function http(method: 'GET' | 'POST', url: string, body?: unknown, authorized = true) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
  req.url = url;
  req.method = method;
  req.headers = { 'content-type': 'application/json', ...(authorized ? { 'x-ashlr-token': token } : {}) };
  let status = 0;
  let wire: unknown;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(payload: string) { wire = JSON.parse(payload); },
  } as unknown as ServerResponse;
  const ctx = { cfg: {}, token, allowDispatch: true, readSession: { id: 'fake-session', expiresAt: now + 60_000 } } as VerseApiContext;
  expect(await handleAgentBusApi(ctx, req, res, path, method)).toBe(true);
  return { status, wire };
}

async function cli(args: string[], input?: unknown) {
  let wire: unknown;
  const code = await cmdCommsBus(args, {}, {
    ...(input === undefined ? {} : { stdin: Readable.from([JSON.stringify(input)]) }),
    emit: json => { wire = JSON.parse(json); },
  });
  return { code, wire };
}

it('shares durable messages, cursor positions, deduplication and expiry across HTTP and CLI calls', async () => {
  expect(await http('POST', path, requestMessage)).toMatchObject({ status: 201, wire: { status: 'posted', cursor: 1 } });
  expect(await cli(['read', '--after', '0'])).toMatchObject({
    code: 0, wire: { status: 'ok', nextCursor: 1, messages: [{ cursor: 1, receivedAt: now, envelope: requestMessage }] },
  });

  // Replays and conflicts cross the boundary in both directions and never add a row.
  expect(await cli(['post', '--file', '-'], requestMessage)).toMatchObject({ code: 0, wire: { status: 'duplicate', cursor: 1 } });
  expect(await cli(['post', '--file', '-'], { ...requestMessage, body: { task: 'changed' } })).toMatchObject({ code: 1, wire: { status: 'conflict' } });
  expect(await cli(['post', '--file', '-'], replyMessage)).toMatchObject({ code: 0, wire: { status: 'posted', cursor: 2 } });
  expect(await http('POST', path, replyMessage)).toMatchObject({ status: 200, wire: { status: 'duplicate', cursor: 2 } });
  expect(await http('POST', path, { ...replyMessage, body: { inReplyTo: 'fake-request', result: 'changed' } })).toMatchObject({ status: 409, wire: { status: 'conflict' } });
  expect(await http('GET', `${path}?after=1`)).toMatchObject({
    status: 200, wire: { status: 'ok', nextCursor: 2, messages: [{ cursor: 2, receivedAt: now, envelope: replyMessage }] },
  });

  const denied = { ...requestMessage, id: 'fake-denied' };
  expect(await http('POST', path, denied, false)).toMatchObject({ status: 401 });
  expect(await cli(['read', '--after', '2'])).toMatchObject({ code: 0, wire: { status: 'ok', nextCursor: 2, messages: [] } });

  // The HTTP-created short-lived row expires; the CLI-created row remains live.
  const expired = { ...requestMessage, id: 'fake-expiring', ttl: 10 };
  const live = { ...replyMessage, id: 'fake-live' };
  expect(await http('POST', path, expired)).toMatchObject({ status: 201, wire: { cursor: 3 } });
  expect(await cli(['post', '--file', '-'], live)).toMatchObject({ code: 0, wire: { cursor: 4 } });
  now += 10;
  expect(await cli(['read', '--after', '2', '--limit', '1'])).toMatchObject({
    code: 0, wire: { status: 'ok', nextCursor: 4, messages: [{ cursor: 4, envelope: { ...live, ttl: 990 } }] },
  });
  expect(await http('GET', `${path}?after=2&limit=1`)).toMatchObject({
    status: 200, wire: { status: 'ok', nextCursor: 4, messages: [{ cursor: 4, envelope: { ...live, ttl: 990 } }] },
  });
  now += 990;
  expect(await http('GET', `${path}?after=2`)).toMatchObject({ status: 200, wire: { status: 'ok', nextCursor: 4, messages: [] } });
  expect(await cli(['read', '--after', '4'])).toMatchObject({ code: 0, wire: { status: 'ok', nextCursor: 4, messages: [] } });
}, 30_000);

it('persists a CLI checkpoint only after delivery of an HTTP-created message completes', async () => {
  const checkpoint = join(home, 'fake-checkpoint.json');
  expect(await http('POST', path, requestMessage)).toMatchObject({ status: 201, wire: { cursor: 1 } });
  let complete!: () => void;
  const delivery = new Promise<void>(resolve => { complete = resolve; });
  let emitted: unknown;
  const run = cmdCommsBus(['read', '--checkpoint', checkpoint], {}, {
    emit: json => { emitted = JSON.parse(json); return delivery; },
  });
  expect(emitted).toMatchObject({ nextCursor: 1, messages: [{ cursor: 1, envelope: requestMessage }] });
  expect(existsSync(checkpoint)).toBe(false);
  complete();
  expect(await run).toBe(0);
  expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toMatchObject({ scanCursor: 1 });

  expect(await http('POST', path, replyMessage)).toMatchObject({ status: 201, wire: { cursor: 2 } });
  const prior = readFileSync(checkpoint, 'utf8');
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], {}, {
    emit: async () => { throw new Error('fake output failure'); },
  })).toBe(1);
  expect(diagnostic).toHaveBeenCalled();
  expect(readFileSync(checkpoint, 'utf8')).toBe(prior);
  expect(await cli(['read', '--checkpoint', checkpoint])).toMatchObject({
    code: 0, wire: { nextCursor: 2, messages: [{ cursor: 2, envelope: replyMessage }] },
  });
  expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toMatchObject({ scanCursor: 2 });
}, 30_000);
