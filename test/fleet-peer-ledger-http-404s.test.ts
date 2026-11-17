import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PEER_PAIR_LIMIT } from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger, type PeerPairSelector } from '../src/core/agentnet/peer-ledger.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import {
  createFleetPeerLedgerApi,
  VERSE_FLEET_PEER_LEDGER_PATH as PATH,
} from '../src/core/verse/fleet-peer-ledger-api.js';
import {
  handleVerseApi,
  setMountedApiModulesForTest,
  type VerseApiContext,
} from '../src/core/verse/verse-api.js';

const T0 = Date.parse('2026-11-15T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MAX_PAIRS = 64;
const THREAD = 'private-thread-404s';
const DIGEST = 'f'.repeat(64);
const CORRUPT = 'corrupt-private-404s';
const ORIGIN = `peer-${randomUUID()}`;

let root = '';
let dir = '';
let file = '';
let nowMs = T0;
let read: ReturnType<typeof vi.fn>;
let api: ApiModule;

const row = (fromAgent: string, target: string, at: number) => ({
  id: `peer-${randomUUID()}`,
  fromAgent,
  target,
  origin: ORIGIN,
  digest: DIGEST,
  hopCount: 1,
  threadId: THREAD,
  at,
});

function writeRows(rows: unknown[]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
  chmodSync(file, 0o600);
}

beforeEach(() => {
  nowMs = T0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'peer-ledger-http-404s-')));
  dir = join(root, 'agentnet');
  file = join(dir, 'coordination.json');
  read = vi.fn((pair?: PeerPairSelector) => readPeerLedger({ busRoot: root, pair, now: () => nowMs }));
  api = createFleetPeerLedgerApi({ read, now: () => new Date(nowMs) });
  setMountedApiModulesForTest([]);
});

afterEach(() => {
  setMountedApiModulesForTest(null);
  if (root) rmSync(root, { recursive: true, force: true });
});

async function call(
  path = PATH,
  options: {
    method?: string;
    url?: string;
    allowDispatch?: boolean;
    headers?: Record<string, string>;
  } = {},
) {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const req = { url: options.url ?? path, headers: options.headers ?? {} } as IncomingMessage;
  const ctx = {
    cfg: {} as VerseApiContext['cfg'],
    token: 'test-token',
    allowDispatch: options.allowDispatch ?? false,
    fleetPeerLedgerApi: api,
  } as VerseApiContext;
  const handled = await handleVerseApi(ctx, req, res, path, options.method ?? 'GET');
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

function expectNoPrivateDetail(text: string) {
  for (const detail of [root, dir, file, THREAD, DIGEST, CORRUPT]) {
    expect(text).not.toContain(detail);
  }
}

describe('GET /api/verse/fleet/peer-ledger', () => {
  it('serves aggregate metadata and selects an exact pair beyond the 64-row cap', async () => {
    const decoys = Array.from({ length: MAX_PAIRS }, (_, i) =>
      row('a-src', `agent-a${String(i).padStart(2, '0')}`, T0 - 1_000));
    writeRows([...decoys, row('z-src', 'agent-zz', T0 - 1_000)]);
    const before = readFileSync(file);

    const aggregate = await call();
    expect(aggregate).toMatchObject({ handled: true, status: 200 });
    expect(aggregate.body).toMatchObject({
      v: 1, authority: 'none', status: 'ok', asOf: iso(T0), liveRows: MAX_PAIRS + 1,
      pairLimit: PEER_PAIR_LIMIT, truncated: { pairs: true },
    });
    expect(aggregate.body.pairs).toHaveLength(MAX_PAIRS);
    expect(aggregate.body).not.toHaveProperty('selection');
    expect(aggregate.text).not.toContain('z-src');
    expect(aggregate.text).not.toContain('agent-zz');
    expectNoPrivateDetail(aggregate.text);

    const picked = await call(PATH, { url: `${PATH}?fromAgent=z-src&target=agent-zz` });
    expect(picked).toMatchObject({ handled: true, status: 200 });
    expect(picked.body).toMatchObject({
      status: 'ok', liveRows: MAX_PAIRS + 1,
      selection: { fromAgent: 'z-src', target: 'agent-zz', match: 'exact' },
      pairs: [{ fromAgent: 'z-src', target: 'agent-zz', inWindow: 1, remaining: PEER_PAIR_LIMIT - 1,
        lastAt: iso(T0 - 1_000), retryAt: null }],
      truncated: { pairs: true },
    });
    expectNoPrivateDetail(picked.text);
    expect(readFileSync(file)).toEqual(before);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reports the exact retry boundary and rereads it on the next request', async () => {
    writeRows(Array.from({ length: PEER_PAIR_LIMIT }, (_, i) =>
      row('fx-zz', 'fx-zy', T0 - 50_000 + i * 10_000)));
    const url = `${PATH}?fromAgent=fx-zz&target=fx-zy`;

    const blocked = await call(PATH, { url });
    expect(blocked.body).toMatchObject({
      status: 'ok', asOf: iso(T0),
      selection: { fromAgent: 'fx-zz', target: 'fx-zy', match: 'exact' },
      pairs: [{ inWindow: PEER_PAIR_LIMIT, remaining: 0, retryAt: iso(T0 + 10_000) }],
    });

    nowMs = T0 + 10_000;
    const released = await call(PATH, { url });
    expect(released.body).toMatchObject({
      status: 'ok', asOf: iso(T0 + 10_000),
      selection: { fromAgent: 'fx-zz', target: 'fx-zy', match: 'exact' },
      pairs: [{ inWindow: PEER_PAIR_LIMIT - 1, remaining: 1, retryAt: null,
        lastAt: iso(T0) }],
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads missing, corrupt and repaired ledgers afresh without private details', async () => {
    const url = `${PATH}?fromAgent=z-src&target=agent-zz`;
    const missing = await call(PATH, { url });
    expect(missing.body).toMatchObject({
      status: 'empty', authority: 'none', asOf: iso(T0), liveRows: 0,
      selection: { fromAgent: 'z-src', target: 'agent-zz', match: 'none' }, pairs: [],
    });
    expect(missing.body).not.toHaveProperty('enrolled');
    expect(missing.body).not.toHaveProperty('dispatchReady');

    writeRows([row('z-src', 'agent-zz', T0 - 1_000), row('z-src', 'agent-zz', T0 - 2_000)]);
    writeFileSync(file, CORRUPT);
    chmodSync(file, 0o600);
    const corrupt = await call(PATH, { url });
    expect(corrupt.body).toMatchObject({
      status: 'unavailable', reason: 'peer-ledger-unreadable', authority: 'none',
      selection: { fromAgent: 'z-src', target: 'agent-zz', match: 'none' }, pairs: [],
    });
    expect(corrupt.text).not.toContain(CORRUPT);
    expectNoPrivateDetail(corrupt.text);
    expect(readFileSync(file, 'utf8')).toBe(CORRUPT);

    writeRows([row('z-src', 'agent-zz', T0 - 500)]);
    const repairedBytes = readFileSync(file);
    const repaired = await call(PATH, { url });
    expect(repaired.body).toMatchObject({
      status: 'ok', authority: 'none',
      selection: { fromAgent: 'z-src', target: 'agent-zz', match: 'exact' },
      pairs: [{ fromAgent: 'z-src', target: 'agent-zz', inWindow: 1, remaining: PEER_PAIR_LIMIT - 1 }],
    });
    expectNoPrivateDetail(repaired.text);
    expect(readFileSync(file)).toEqual(repairedBytes);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([
    `${PATH}?fromAgent=z-src`,
    `${PATH}?target=agent-zz`,
    `${PATH}?fromAgent=z-src&fromAgent=z-src&target=agent-zz`,
    `${PATH}?fromAgent=z-src&target=agent-zz&root=${root}`,
    `${PATH}?path=/tmp`,
    `${PATH}?busRoot=${root}`,
    `${PATH}?cwd=${root}`,
    `${PATH}?fromAgent=z-src&target=agent-zz&extra=1`,
    `${PATH}?fromAgent=Z-SRC&target=agent-zz`,
    `${PATH}?fromAgent=z-src&target=`,
    `${PATH}?fromAgent=z-src&target=agent%20zz`,
  ])('rejects invalid query %s before reading', async (url) => {
    const result = await call(PATH, { url });
    expect(result).toMatchObject({ handled: true, status: 400, body: { code: 'VERSE_INVALID' } });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the existing dispatch and mutation gates ahead of the 405', async () => {
    const denied = await call(PATH, { method: 'POST' });
    expect(denied).toMatchObject({ handled: true, status: 404 });
    const unauthorized = await call(PATH, { method: 'POST', allowDispatch: true });
    expect(unauthorized).toMatchObject({ handled: true, status: 401 });

    const headers = { 'x-ashlr-token': 'test-token', 'content-type': 'application/json' };
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const result = await call(PATH, { method, allowDispatch: true, headers });
      expect(result).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('leaves neighboring paths on the normal unmatched-route path', async () => {
    for (const path of [`${PATH}/extra`, '/api/verse/fleet/peer-ledgerX']) {
      const result = await call(path, { url: path });
      expect(result).toMatchObject({ handled: true, status: 404 });
    }
    expect(read).not.toHaveBeenCalled();
  });
});
