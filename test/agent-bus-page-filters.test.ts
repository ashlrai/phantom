import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { appendBusInbox, inspectBusInbox, listBusInboxAfter, type BusInboxPage, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import {
  busPageAddressMatchers, busPageRowMatch, filterBusInboxPage, parseBusPageQuery,
  type BusPageFilters, type BusPageMatchers,
} from '../src/core/fleet/bus-page-filters.js';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import { handleVerseApi, setWorkbenchApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { readFleetEdges, type FleetEdges } from '../src/core/fleet/fleet-edges.js';

const PATH = '/api/verse/agent-bus';
const roots: string[] = [];
afterEach(() => {
  setWorkbenchApiModulesForTest(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const envelope = (id: string, over: Record<string, unknown> = {}) => ({
  id, from: 'alice', to: 'bob', priority: 'P1', ttl: 100_000,
  body: { text: `body of ${id}` }, ...over,
});
const receipt = (cursor: number, receivedAt: number, env: ReturnType<typeof envelope>): BusInboxReceipt =>
  ({ cursor, receivedAt, envelope: env as BusInboxReceipt['envelope'] });
const okPage = (messages: BusInboxReceipt[], nextCursor = 99): BusInboxPage =>
  ({ status: 'ok', messages, nextCursor });

describe('parseBusPageQuery', () => {
  it('defaults to the unfiltered first page', () => {
    expect(parseBusPageQuery({})).toEqual({ ok: true, after: 0, limit: 50, refs: {}, filters: {} });
  });
  it('parses every filter with the same rules the CLI and MCP reads apply', () => {
    const parsed = parseBusPageQuery({
      after: '10', limit: '5', to: 'agent-b', from: 'agent-a', excludeFrom: 'agent-c',
      id: 'm-1', inReplyTo: 'm-0', priority: 'P2', kind: 'task', topic: 'fleet.*',
      thread: 't-1', job: 'RQ-1', channel: 'eng', bodyKind: 'work.post',
      result: 'failed', since: '60000', before: '120000', contains: 'Deploy  Parser',
    });
    expect(parsed).toEqual({
      ok: true, after: 10, limit: 5,
      refs: { to: 'agent-b', from: 'agent-a', excludeFrom: 'agent-c' },
      filters: {
        id: 'm-1', inReplyTo: 'm-0', priority: 'P2', kind: 'task', topic: 'fleet.*',
        thread: 't-1', job: 'RQ-1', channel: 'eng', bodyKind: 'work.post',
        result: 'failed', since: 60_000, before: 120_000, contains: 'deploy parser',
      },
    });
  });
  it('rejects malformed cursors, limits and filter values', () => {
    for (const input of [
      { after: '-1' }, { after: '01' }, { after: '99999999999999999999' },
      { limit: '0' }, { limit: '101' }, { limit: 'abc' },
      { to: 'bad label' }, { from: 'x'.repeat(129) }, { excludeFrom: '' },
      { id: 'has space' }, { inReplyTo: 'tab\there' },
      { priority: 'P9' }, { kind: 'bogus' }, { topic: 'not a topic' }, { topic: 'fleet' },
      { thread: 'has space' }, { job: '' }, { bodyKind: 'bad kind' },
      { result: 'maybe' }, { channel: 'Bad_Channel' },
      { since: 'garbage' }, { since: '-5' }, { before: 'yesterdayish' },
      { contains: '' }, { contains: 'x'.repeat(513) },
    ]) {
      expect(parseBusPageQuery(input).ok, JSON.stringify(input)).toBe(false);
    }
  });
  it('accepts relative and absolute time cutoffs', () => {
    const parsed = parseBusPageQuery({ since: '15m', before: '2026-01-02T03:04:05Z' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.filters.since).toBeGreaterThan(0);
      expect(parsed.filters.before).toBe(Date.parse('2026-01-02T03:04:05Z'));
    }
  });
});

describe('busPageRowMatch / filterBusInboxPage', () => {
  const rows = [
    receipt(1, 1_000, envelope('m-1', {
      priority: 'P0', to: 'group:eng:general',
      body: { kind: 'note', thread: 't-1', inReplyTo: 'm-0', text: 'deploy parser fix' },
    })),
    receipt(2, 2_000, envelope('m-2', {
      from: 'carol', to: 'dave', priority: 'P2',
      body: { kind: 'work.result', outcome: 'failed', jobId: 'RQ-9', text: 'build failed' },
    })),
    receipt(3, 3_000, envelope('m-3', {
      from: 'dave', to: 'fleet.deploy',
      body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' }, text: 'ship it' },
    })),
    receipt(4, 4_000, envelope('m-4', {
      body: { kind: 'note', thread: 'job:RQ-7', text: 'job thread note' },
    })),
  ];
  const ids = (filters: BusPageFilters = {}, matchers: BusPageMatchers = {}) => {
    const page = filterBusInboxPage(okPage(rows), filters, matchers);
    return page.status === 'ok' ? page.messages.map(r => r.envelope.id) : [];
  };
  it('keeps only rows every filter accepts', () => {
    expect(ids({ id: 'm-2' })).toEqual(['m-2']);
    expect(ids({ priority: 'P0' })).toEqual(['m-1']);
    expect(ids({ inReplyTo: 'm-0' })).toEqual(['m-1']);
    expect(ids({ thread: 't-1' })).toEqual(['m-1']);
    expect(ids({ thread: 'job:RQ-7' })).toEqual(['m-4']);
    expect(ids({ job: 'RQ-9' })).toEqual(['m-2']);
    expect(ids({ job: 'RQ-7' })).toEqual(['m-4']);
    expect(ids({ job: 'RQ-1' })).toEqual([]);
    expect(ids({ bodyKind: 'work.result' })).toEqual(['m-2']);
    expect(ids({ bodyKind: 'note' })).toEqual(['m-1', 'm-4']);
    expect(ids({ result: 'failed' })).toEqual(['m-2']);
    expect(ids({ result: 'complete' })).toEqual([]);
    expect(ids({ channel: 'eng' })).toEqual(['m-1']);
    expect(ids({ kind: 'task' })).toEqual(['m-3']);
    expect(ids({ topic: 'fleet.deploy' })).toEqual(['m-3']);
    expect(ids({ topic: 'fleet.*' })).toEqual(['m-3']);
    expect(ids({ topic: 'repo.*' })).toEqual([]);
    expect(ids({ since: 2_000 })).toEqual(['m-2', 'm-3', 'm-4']);
    expect(ids({ before: 2_000 })).toEqual(['m-1']);
    expect(ids({ since: 1_000, before: 3_000 })).toEqual(['m-1', 'm-2']);
    expect(ids({ contains: 'parser' })).toEqual(['m-1']);
    expect(ids({ contains: 'fleet.deploy' })).toEqual(['m-3']);
    expect(ids({ contains: 'job thread' })).toEqual(['m-4']);
  });
  it('applies address matchers to the envelope routing labels', () => {
    expect(ids({}, { to: (v: string) => v === 'dave' })).toEqual(['m-2']);
    expect(ids({}, { from: (v: string) => v === 'carol' })).toEqual(['m-2']);
    expect(ids({}, { excludeFrom: (v: string) => v === 'alice' })).toEqual(['m-2', 'm-3']);
    expect(ids({ channel: 'eng' }, { from: (v: string) => v === 'carol' })).toEqual([]);
  });
  it('preserves nextCursor and passes non-ok pages through untouched', () => {
    const page = okPage(rows.slice(0, 1), 42);
    expect(filterBusInboxPage(page, { priority: 'P3' })).toEqual({ ...page, messages: [] });
    const empty = filterBusInboxPage(page, { id: 'nope' });
    expect(empty.status === 'ok' && empty.nextCursor).toBe(42);
    const broken: BusInboxPage = { status: 'unavailable' };
    expect(filterBusInboxPage(broken, { id: 'm-1' })).toBe(broken);
    expect(filterBusInboxPage(page, {})).toBe(page);
  });
  it('busPageRowMatch is the single row rule the page filter applies', () => {
    const row = rows[0]!;
    expect(busPageRowMatch(row, { id: 'm-1' })).toBe(true);
    expect(busPageRowMatch(row, { id: 'm-2' })).toBe(false);
    expect(busPageRowMatch(row, {}, { to: () => false })).toBe(false);
  });
});

describe('busPageAddressMatchers', () => {
  it('returns no matchers when no ref is present', () => {
    expect(busPageAddressMatchers({})).toEqual({});
  });
  it('keeps exact-label matching when the registry cannot resolve a ref', () => {
    const matchers = busPageAddressMatchers({ to: 'agent-b', from: 'agent-a', excludeFrom: 'agent-c' });
    expect(matchers.to!('agent-b')).toBe(true);
    expect(matchers.to!('agent-b2')).toBe(false);
    expect(matchers.from!('agent-a')).toBe(true);
    expect(matchers.excludeFrom!('agent-c')).toBe(true);
    expect(matchers.excludeFrom!('agent-c2')).toBe(false);
  });
});

describe('GET /api/verse/agent-bus filters', () => {
  const token = 'fake-mutation-token';
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'fake-bus-page-'));
    roots.push(root);
    let now = 1_000;
    const options = { root, now: () => now };
    const seed = (env: unknown, at?: number) => {
      if (at !== undefined) now = at;
      return appendBusInbox(env, options);
    };
    const handler = createAgentBusApi({
      append: (input: unknown) => appendBusInbox(input, options),
      list: (after?: number, limit?: number) => listBusInboxAfter(after, limit, options),
      inspect: () => inspectBusInbox(options),
    });
    setWorkbenchApiModulesForTest([{ id: 'agent-bus', load: async () => handler }]);
    return { seed };
  }
  async function get(url: string) {
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.url = url; req.method = 'GET'; req.headers = {};
    let status = 0; let wire: Record<string, unknown> = {};
    const res = {
      headersSent: false,
      writeHead(this: { headersSent: boolean }, code: number) { status = code; this.headersSent = true; },
      end(body: string) { wire = JSON.parse(body) as Record<string, unknown>; },
    } as unknown as ServerResponse;
    const ctx = { cfg: {}, token, allowDispatch: true,
      readSession: { id: 'fake-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
    const handled = await handleVerseApi(ctx, req, res, PATH, 'GET');
    return { handled, status, wire };
  }
  const ids = (wire: Record<string, unknown>) =>
    (wire['messages'] as { envelope: { id: string } }[]).map(m => m.envelope.id);

  it('serves the same filtered page the CLI and MCP reads apply', async () => {
    const { seed } = setup();
    seed(envelope('m-1', { priority: 'P0', to: 'group:eng:general', body: { kind: 'note', thread: 't-1', text: 'deploy parser fix' } }), 1_000);
    seed(envelope('m-2', { from: 'carol', to: 'dave', priority: 'P2', body: { kind: 'work.result', outcome: 'failed', jobId: 'RQ-9', text: 'build failed' } }), 2_000);
    seed(envelope('m-3', { from: 'dave', to: 'fleet.deploy', body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' }, text: 'ship it' } }), 3_000);

    const all = await get(`${PATH}?after=0`);
    expect(all.wire).toMatchObject({ status: 'ok' });
    expect(ids(all.wire)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(ids((await get(`${PATH}?to=dave`)).wire)).toEqual(['m-2']);
    expect(ids((await get(`${PATH}?from=carol`)).wire)).toEqual(['m-2']);
    expect(ids((await get(`${PATH}?excludeFrom=alice`)).wire)).toEqual(['m-2', 'm-3']);
    expect(ids((await get(`${PATH}?priority=P0`)).wire)).toEqual(['m-1']);
    expect(ids((await get(`${PATH}?id=m-3`)).wire)).toEqual(['m-3']);
    expect(ids((await get(`${PATH}?thread=t-1`)).wire)).toEqual(['m-1']);
    expect(ids((await get(`${PATH}?job=RQ-9`)).wire)).toEqual(['m-2']);
    expect(ids((await get(`${PATH}?channel=eng`)).wire)).toEqual(['m-1']);
    expect(ids((await get(`${PATH}?kind=task`)).wire)).toEqual(['m-3']);
    expect(ids((await get(`${PATH}?topic=fleet.*`)).wire)).toEqual(['m-3']);
    expect(ids((await get(`${PATH}?bodyKind=work.result`)).wire)).toEqual(['m-2']);
    expect(ids((await get(`${PATH}?result=failed`)).wire)).toEqual(['m-2']);
    expect(ids((await get(`${PATH}?contains=parser`)).wire)).toEqual(['m-1']);
    expect(ids((await get(`${PATH}?since=2000`)).wire)).toEqual(['m-2', 'm-3']);
    expect(ids((await get(`${PATH}?before=2000`)).wire)).toEqual(['m-1']);
    expect(ids((await get(`${PATH}?from=alice&priority=P0`)).wire)).toEqual(['m-1']);
  });
  it('advances nextCursor through filtered-out rows without replay', async () => {
    const { seed } = setup();
    seed(envelope('m-1'), 1_000);
    seed(envelope('m-2'), 2_000);
    const page = await get(`${PATH}?limit=1&contains=absent`);
    expect(page.status).toBe(200);
    expect(page.wire).toMatchObject({ status: 'ok', messages: [], nextCursor: 1 });
    const next = await get(`${PATH}?after=1&limit=1&contains=absent`);
    expect(next.wire).toMatchObject({ status: 'ok', messages: [], nextCursor: 2 });
  });
  it('rejects malformed filter values and unknown keys before reading', async () => {
    const { seed } = setup();
    seed(envelope('m-1'), 1_000);
    for (const query of [
      '?after=-1', '?limit=0', '?limit=101', '?priority=P9', '?kind=bogus',
      '?topic=bad topic', '?result=maybe', '?channel=Bad', '?since=garbage',
      '?contains=', '?to=bad label', '?root=fake', '?limit=1&limit=2',
    ]) {
      const res = await get(PATH + query);
      expect(res.status, query).toBe(400);
    }
  });
});

describe('GET /api/verse/agent-bus/edges filters', () => {
  const EDGES = '/api/verse/agent-bus/edges';
  const token = 'fake-mutation-token';
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'fake-bus-edges-'));
    roots.push(root);
    let now = 1_000;
    const options = { root, now: () => now };
    const seed = (env: unknown, at?: number) => {
      if (at !== undefined) now = at;
      return appendBusInbox(env, options);
    };
    const handler = createAgentBusApi({
      edges: edgeOptions => readFleetEdges({ ...edgeOptions, root, now: () => now }),
    });
    return { seed, handler };
  }
  async function get(handler: ReturnType<typeof createAgentBusApi>, url: string) {
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.url = url; req.method = 'GET'; req.headers = {};
    let status = 0; let wire: Record<string, unknown> = {};
    const res = {
      headersSent: false,
      writeHead(this: { headersSent: boolean }, code: number) { status = code; this.headersSent = true; },
      end(body: string) { wire = JSON.parse(body) as Record<string, unknown>; },
    } as unknown as ServerResponse;
    const ctx = { cfg: {}, token, allowDispatch: true,
      readSession: { id: 'fake-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
    const handled = await handler(ctx, req, res, EDGES, 'GET');
    return { handled, status, wire };
  }
  const links = (wire: Record<string, unknown>) =>
    ((wire['edges'] as FleetEdges['edges']) ?? [])
      .map(edge => `${edge.from.address}->${edge.to.address}`).sort();

  it('serves the same filtered link read the CLI and MCP edges reads apply', async () => {
    const { seed, handler } = setup();
    // One edge per pair keeps the assertions exact; the long-lived 'ab'
    // receipt stays retained at the read clock so only the window can drop it.
    expect(seed(envelope('ab', { from: 'a', to: 'b', ttl: 9_000_000 }), 1_000).status).toBe('posted');
    expect(seed(envelope('ba', { from: 'b', to: 'a' }), 200_000).status).toBe('posted');
    expect(seed(envelope('og', { from: 'c', to: 'group:ops:general' }), 200_000).status).toBe('posted');
    expect(seed(envelope('oa', { from: 'd', to: 'group:ops:alerts' }), 200_000).status).toBe('posted');
    expect(seed(envelope('eg', { from: 'e', to: 'group:eng:general' }), 200_000).status).toBe('posted');
    expect(seed(envelope('lead', { from: 'f', to: 'leaders' }), 200_000).status).toBe('posted');

    const all = await get(handler, EDGES);
    expect(all.status).toBe(200);
    expect(all.wire).toMatchObject({ schema: 'fleet.edges.v1', source: 'available' });
    // 'leaders' broadcasts are never agent-to-agent links.
    expect(links(all.wire)).toEqual(['a->b', 'b->a', 'c->group:ops:general',
      'd->group:ops:alerts', 'e->group:eng:general']);

    expect(links((await get(handler, `${EDGES}?from=a`)).wire)).toEqual(['a->b']);
    expect(links((await get(handler, `${EDGES}?to=a`)).wire)).toEqual(['b->a']);
    expect(links((await get(handler, `${EDGES}?from=a&to=b`)).wire)).toEqual(['a->b']);
    expect(links((await get(handler, `${EDGES}?channel=ops`)).wire))
      .toEqual(['c->group:ops:general', 'd->group:ops:alerts']);
    expect(links((await get(handler, `${EDGES}?topic=general`)).wire))
      .toEqual(['c->group:ops:general', 'e->group:eng:general']);
    expect(links((await get(handler, `${EDGES}?channel=ops&topic=alerts`)).wire))
      .toEqual(['d->group:ops:alerts']);
    expect(links((await get(handler, `${EDGES}?channel=missing`)).wire)).toEqual([]);

    // windowMinutes keeps only links inside the trailing window: the 'ab'
    // receipt at t=1_000 is outside a one-minute window ending at 200_000.
    const windowed = await get(handler, `${EDGES}?windowMinutes=1`);
    expect(windowed.status).toBe(200);
    expect(links(windowed.wire)).toEqual(['b->a', 'c->group:ops:general',
      'd->group:ops:alerts', 'e->group:eng:general']);
    const day = await get(handler, `${EDGES}?windowMinutes=1440`);
    expect(links(day.wire)).toHaveLength(5);
  });

  it('keeps a missing store honest — null edges, never an invented empty list', async () => {
    const { handler } = setup();
    const res = await get(handler, EDGES);
    expect(res.status).toBe(200);
    expect(res.wire).toMatchObject({ schema: 'fleet.edges.v1', source: 'missing', edges: null });
  });

  it('rejects malformed filter values, unknown keys and duplicate params before reading', async () => {
    const { handler } = setup();
    for (const query of [
      '?windowMinutes=0', '?windowMinutes=1441', '?windowMinutes=1.5', '?windowMinutes=abc',
      '?windowMinutes=', '?from=has%20space', '?from=', '?to=bad%20label',
      '?channel=Bad%20Room', '?channel=', '?topic=has%20space', '?topic=UPPER',
      '?after=0', '?limit=5', '?bogus=1', '?windowMinutes=1&windowMinutes=2',
      '?from=a&from=b',
    ]) {
      const res = await get(handler, EDGES + query);
      expect(res.status, query).toBe(400);
    }
  });

  it('requires a read session and refuses non-GET methods', async () => {
    const { handler } = setup();
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.url = EDGES; req.method = 'GET'; req.headers = {};
    let status = 0;
    const res = { headersSent: false, writeHead(this: { headersSent: boolean }, code: number) { status = code; this.headersSent = true; },
      end() { return this; } } as unknown as ServerResponse;
    const ctx = { cfg: {}, token, allowDispatch: true } as VerseApiContext;
    expect(await handler(ctx, req, res, EDGES, 'GET')).toBe(true);
    expect(status).toBe(401);
    const postReq = Readable.from([]) as unknown as IncomingMessage;
    postReq.url = EDGES; postReq.method = 'POST'; postReq.headers = {};
    status = 0;
    expect(await handler(ctx, postReq, res, EDGES, 'POST')).toBe(true);
    expect(status).toBe(404);
  });
});
