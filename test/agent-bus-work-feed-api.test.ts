import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusWorkFeedReadResult } from '../src/core/agents/bus-work-feed-read.js';
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

  it('requires a read session and refuses non-GET methods and query params', async () => {
    expect((await request(FEED, { session: false })).status).toBe(401);
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      expect((await request(FEED, { method })).status, method).toBe(404);
    }
    for (const query of ['?status=queued', '?after=0', '?limit=10', '?claims=1']) {
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
