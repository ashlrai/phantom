import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import type { BusWorkFeedJob, BusWorkFeedReadResult } from '../src/core/agents/bus-work-feed-read.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';

const PATH = '/api/verse/agent-bus';
const FEED = `${PATH}/work-feed`;
const token = 'fake-mutation-token';
const post = { kind: 'work.post', jobId: 'fake-job', title: 'Review', repo: 'fake/repo',
  claimKeys: ['repo:fake/repo'], provider: 'devin' };
const envelope = (body: unknown, id = 'fake-message-1') => ({
  id, from: 'fake-agent', to: 'leaders', priority: 'P2', ttl: 60_000, body,
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fake-work-feed-api-'));
  vi.stubEnv('ASHLR_HOME', join(home, 'ashlr'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

async function request(url: string, opts: { method?: string; session?: boolean } = {}) {
  const method = opts.method ?? 'GET';
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = url; req.method = method;
  req.headers = { 'content-type': 'application/json' };
  let status = 0, wire: Record<string, unknown> = {};
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
    end(body: string) { wire = JSON.parse(body) as Record<string, unknown>; } } as unknown as ServerResponse;
  const ctx = { cfg: {}, token, allowDispatch: true,
    ...(opts.session === false ? {} : { readSession: { id: 'fake-session', expiresAt: Date.now() + 60_000 } }) } as VerseApiContext;
  const api = createAgentBusApi();
  const handled = await api(ctx, req, res, url.split('?')[0]!, method);
  return { handled, status, wire };
}

describe('GET /api/verse/agent-bus/work-feed', () => {
  it('is owned by the agent-bus route family', () => {
    expect(workbenchFamilyFor(FEED)?.id).toBe('agent-bus');
  });

  it('requires a read session and refuses non-GET methods and unknown or malformed query params', async () => {
    expect((await request(FEED, { session: false })).status).toBe(401);
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      expect((await request(FEED, { method })).status, method).toBe(404);
    }
    for (const query of ['?after=0', '?limit=0', '?limit=201', '?limit=abc', '?limit=', '?limit=1.5', '?limit=-1',
      '?claims=1', '?claims=false', '?claims', '?claims=true&claims=true',
      '?status=bogus', '?status=QUEUED', '?job=', '?repo=not-a-repo', '?provider=bogus', '?provider=DEVIN',
      '?tier=bogus', '?tier=FAST', '?to=', '?owner=', '?since=not-a-time', '?before=not-a-time', '?before=', '?contains=', '?channel=', '?channel=Bad%20Name', '?channel=UPPER', '?open=false', '?claimable=1',
      '?status=queued&status=done', '?bogus=1']) {
      expect((await request(`${FEED}${query}`)).status, query).toBe(400);
    }
    expect((await request(`${FEED}/extra`)).handled).toBe(false);
  });

  it('maps every projection status to its HTTP answer', async () => {
    const asOf = '2026-11-18T00:00:00.000Z';
    const cases: Array<[BusWorkFeedReadResult, number]> = [
      [{ status: 'ok', jobs: [], receipts: 0, asOf }, 200],
      [{ status: 'refused', reason: 'duplicate-job', receipts: 2, asOf }, 200],
      [{ status: 'unavailable', asOf }, 503],
      [{ status: 'retryable', asOf }, 503],
      [{ status: 'invalid', asOf }, 503],
    ];
    for (const [result, httpStatus] of cases) {
      const api = createAgentBusApi({ workFeed: () => result });
      const req = Readable.from([]) as unknown as IncomingMessage;
      req.url = FEED; req.method = 'GET'; req.headers = {};
      let status = 0, wire: Record<string, unknown> = {};
      const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
        end(body: string) { wire = JSON.parse(body) as Record<string, unknown>; } } as unknown as ServerResponse;
      const ctx = { cfg: {}, token, allowDispatch: true,
        readSession: { id: 'fake-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
      expect(await api(ctx, req, res, FEED, 'GET')).toBe(true);
      expect(status, result.status).toBe(httpStatus);
      expect(wire).toEqual({ v: 1, ...result });
    }
  });

  it('serves the real projection over the same store the CLI reads', async () => {
    const root = join(home, 'ashlr', 'fleet');
    expect(appendBusInbox(envelope(post), { root }).status).toBe('posted');
    const result = await request(FEED);
    expect(result.status).toBe(200);
    expect(result.wire).toMatchObject({ v: 1, status: 'ok', receipts: 1,
      jobs: [{ id: 'fake-job', owner: 'fake-agent', provider: 'devin', repo: 'fake/repo',
        claimKeys: ['repo:fake/repo'], status: 'queued' }] });
  });

  it('passes claims=true through to the work-feed reader', async () => {
    const asOf = '2026-11-18T00:00:00.000Z';
    const result: BusWorkFeedReadResult = { status: 'ok', jobs: [], receipts: 0, asOf,
      claims: { source: 'missing', holds: [], truncated: false } };
    const workFeed = vi.fn(() => result);
    const api = createAgentBusApi({ workFeed });
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.url = `${FEED}?claims=true`; req.method = 'GET'; req.headers = {};
    let status = 0, wire: Record<string, unknown> = {};
    const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
      end(body: string) { wire = JSON.parse(body) as Record<string, unknown>; } } as unknown as ServerResponse;
    const ctx = { cfg: {}, token, allowDispatch: true,
      readSession: { id: 'fake-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
    expect(await api(ctx, req, res, FEED, 'GET')).toBe(true);
    expect(status).toBe(200);
    expect(workFeed).toHaveBeenCalledWith({ claims: true });
    expect(wire).toEqual({ v: 1, ...result });
  });

  it('joins live coordination holds only when claims=true', async () => {
    const root = join(home, 'ashlr', 'fleet');
    expect(appendBusInbox(envelope(post), { root }).status).toBe('posted');
    const now = Date.now();
    expect(acquireCoordination({ root, origin: 'resource', key: 'repo:fake/repo', owner: 'other-seat',
      sourceId: 'hold-1', leaseMs: 60_000, leaseUntil: now + 60_000, now }).status).toBe('acquired');
    const plain = await request(FEED);
    expect(plain.status).toBe(200);
    expect(plain.wire).not.toHaveProperty('claims');
    const joined = await request(`${FEED}?claims=true`);
    expect(joined.status).toBe(200);
    expect(joined.wire).toMatchObject({ v: 1, status: 'ok',
      claims: { source: 'available', truncated: false,
        holds: [{ jobId: 'fake-job', claimKey: 'repo:fake/repo', owner: 'other-seat',
          origin: 'resource', sourceId: 'hold-1' }] } });
  });

  it('reports an unreadable store as 503 unavailable, never an empty feed', async () => {
    const root = join(home, 'ashlr', 'fleet');
    expect(appendBusInbox(envelope(post), { root }).status).toBe('posted');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'bus-inbox'), { recursive: true });
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), 'invalid JSON');
    const result = await request(FEED);
    expect(result.status).toBe(503);
    expect(result.wire).toMatchObject({ v: 1, status: 'unavailable' });
  });
});

describe('GET /api/verse/agent-bus/work-feed filters', () => {
  const asOf = '2026-11-18T00:00:00.000Z';
  const job = (over: Partial<BusWorkFeedJob>): BusWorkFeedJob => ({
    id: 'job-a', owner: 'fake-agent', to: 'leaders', provider: 'devin',
    repo: 'fake/repo', title: 'Review the parser', claimKeys: ['repo:fake/repo'],
    status: 'queued', updatedAt: 1_000, postId: 'post-1', statusId: null,
    ...over,
  });
  const jobs = [
    job({ id: 'job-a', title: 'Review the parser', status: 'queued', updatedAt: 1_000,
      dispatch: { tier: 'fast', scope: 'docs only', acceptance: 'links pass' } }),
    job({ id: 'job-b', owner: 'other-agent', to: 'group:release:deploy', provider: 'codex-cmp',
      repo: 'other/repo', title: 'Fix the flake', status: 'done', updatedAt: 2_000,
      detail: 'retry budget exhausted', statusId: 'status-9' }),
  ];
  const feedResult: BusWorkFeedReadResult = { status: 'ok', jobs, receipts: 2, asOf };

  async function feedRequest(query: string, result: BusWorkFeedReadResult = feedResult) {
    const workFeed = vi.fn(() => result);
    const api = createAgentBusApi({ workFeed });
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.url = `${FEED}${query}`; req.method = 'GET'; req.headers = {};
    let status = 0, wire: Record<string, unknown> = {};
    const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
      end(body: string) { wire = JSON.parse(body) as Record<string, unknown>; } } as unknown as ServerResponse;
    const ctx = { cfg: {}, token, allowDispatch: true,
      readSession: { id: 'fake-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
    expect(await api(ctx, req, res, FEED, 'GET')).toBe(true);
    return { status, wire, workFeed };
  }
  const ids = (wire: Record<string, unknown>) => (wire.jobs as Array<{ id: string }>).map(item => item.id);

  it('narrows the feed by status, job id, repo, provider, tier, address, owner, since, before and contains', async () => {
    expect(ids((await feedRequest('?status=done')).wire)).toEqual(['job-b']);
    expect(ids((await feedRequest('?job=job-b')).wire)).toEqual(['job-b']);
    expect(ids((await feedRequest('?repo=Fake/Repo')).wire)).toEqual(['job-a']);
    expect(ids((await feedRequest('?provider=codex-cmp')).wire)).toEqual(['job-b']);
    expect(ids((await feedRequest('?tier=fast')).wire)).toEqual(['job-a']);
    expect(ids((await feedRequest('?to=leaders')).wire)).toEqual(['job-a']);
    expect(ids((await feedRequest('?owner=other-agent')).wire)).toEqual(['job-b']);
    expect(ids((await feedRequest('?since=1500')).wire)).toEqual(['job-b']);
    // before is the exclusive upper bound on the same updatedAt field.
    expect(ids((await feedRequest('?before=1500')).wire)).toEqual(['job-a']);
    expect(ids((await feedRequest('?before=2000')).wire)).toEqual(['job-a']);
    expect(ids((await feedRequest('?since=1500&before=2500')).wire)).toEqual(['job-b']);
    expect(ids((await feedRequest('?since=1500&before=2000')).wire)).toEqual([]);
    expect(ids((await feedRequest('?contains=parser')).wire)).toEqual(['job-a']);
    expect(ids((await feedRequest('?contains=retry%20budget')).wire)).toEqual(['job-b']);
    expect(ids((await feedRequest('?channel=release')).wire)).toEqual(['job-b']);
    expect(ids((await feedRequest('?channel=ops')).wire)).toEqual([]);
    expect(ids((await feedRequest('?status=queued&provider=devin&contains=docs')).wire)).toEqual(['job-a']);
  });

  it('serves jobs newest-first, the same order the feed CLIs print', async () => {
    const { wire } = await feedRequest('');
    expect(ids(wire)).toEqual(['job-b', 'job-a']);
  });

  it('pages the filtered view with limit and reports matched/omitted', async () => {
    const { wire } = await feedRequest('?limit=1');
    expect(ids(wire)).toEqual(['job-b']);
    expect(wire).toMatchObject({ matched: 2, omitted: 1 });
    // A page wider than the match reports zero omitted; filters narrow before the slice.
    const wide = await feedRequest('?limit=200&status=done');
    expect(ids(wide.wire)).toEqual(['job-b']);
    expect(wide.wire).toMatchObject({ matched: 1, omitted: 0 });
    // Without limit the whole filtered view answers, with no page fields.
    const full = await feedRequest('');
    expect(ids(full.wire)).toEqual(['job-b', 'job-a']);
    expect(full.wire).not.toHaveProperty('matched');
    expect(full.wire).not.toHaveProperty('omitted');
  });

  it('implies the claims join for open and claimable and keeps only provably open or claimable jobs', async () => {
    const claimed: BusWorkFeedReadResult = { ...feedResult,
      claims: { source: 'missing', holds: [], truncated: false },
      jobs: jobs.map(item => ({ ...item, claimable: item.status === 'queued' })) };
    const open = await feedRequest('?open=true', claimed);
    expect(open.workFeed).toHaveBeenCalledWith({ claims: true });
    expect(ids(open.wire)).toEqual(['job-a']);
    const claimable = await feedRequest('?claimable=true', claimed);
    expect(claimable.workFeed).toHaveBeenCalledWith({ claims: true });
    expect(ids(claimable.wire)).toEqual(['job-a']);
    const plain = await feedRequest('?status=done', claimed);
    expect(plain.workFeed).toHaveBeenCalledWith();
    expect(ids(plain.wire)).toEqual(['job-b']);
  });

  it('passes non-ok projections through untouched by the view', async () => {
    const refused: BusWorkFeedReadResult = { status: 'refused', reason: 'duplicate-job', receipts: 3, asOf };
    const { status, wire } = await feedRequest('?status=done&contains=anything', refused);
    expect(status).toBe(200);
    expect(wire).toEqual({ v: 1, ...refused });
  });
});
