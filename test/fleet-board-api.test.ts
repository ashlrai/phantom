/**
 * verse/fleet-board-api.ts — GET /api/verse/fleet/board. The handler is
 * invoked directly with injected deps; no server, no real files.
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createFleetBoardApi,
  VERSE_FLEET_BOARD_PATH as PATH,
  type FleetBoardApiDeps,
} from '../src/core/verse/fleet-board-api.js';
import type { FleetBoardV1 } from '../src/core/fleet/fleet-board-read.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const AT = '2026-11-07T12:02:30.000Z';
const NOW = Date.parse(AT);

const BOARD: FleetBoardV1 = {
  schema: 'fleet.leader-board.v1',
  generatedAt: '2026-11-07T12:00:00.000Z',
  lanes: [
    { lane: 'claude', ready: 4, parked: 1, running: 2, mergesLastHour: 3, oldestWaitSeconds: 540 },
    { lane: 'devin', ready: 0, parked: 0, running: 1, mergesLastHour: null, oldestWaitSeconds: null },
  ],
  queueDepthByTier: { frontier: 2, work: 5 },
  mergesLastHour: 3,
  conflictingPrs: {
    count: 2,
    delta: 1,
    trend: 'rising',
    history: [
      { at: '2026-11-07T11:00:00.000Z', count: 1 },
      { at: '2026-11-07T12:00:00.000Z', count: 2 },
    ],
  },
  needsMason: { status: 'available', count: 1, items: [{ id: 'nm-abc123def456', text: 'approve the domain renewal' }] },
  sources: { readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'available' },
};

const deps = (read: FleetBoardApiDeps['readBoard'] = async () => ({ status: 'ok' as const, board: BOARD })): FleetBoardApiDeps => ({
  readBoard: vi.fn(read),
  now: vi.fn(() => NOW),
});

const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;

async function call(method: string, url = PATH, d: FleetBoardApiDeps = deps()) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: {} });
  req.end();
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const handled = await createFleetBoardApi(d)(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, json: payload ? (JSON.parse(payload) as Record<string, unknown>) : null, deps: d };
}

describe('GET /api/verse/fleet/board', () => {
  it('returns the phm fleet board --json envelope around the recorded board', async () => {
    const result = await call('GET');
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      schema: 'fleet.leader-board.v1',
      status: 'ok',
      ageSeconds: 150,
      board: BOARD,
    });
    expect(result.deps.readBoard).toHaveBeenCalledOnce();
  });

  it('a missing board is 200 with status missing — not an HTTP error, not zero', async () => {
    const result = await call('GET', PATH, deps(async () => ({ status: 'missing' as const, board: null })));
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ schema: 'fleet.leader-board.v1', status: 'missing', ageSeconds: null, board: null });
  });

  it('an unreadable board is 200 with status unavailable', async () => {
    const result = await call('GET', PATH, deps(async () => ({ status: 'unavailable' as const, board: null })));
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ status: 'unavailable', board: null });
  });

  it('a throwing reader degrades to status unavailable — never leaks the error', async () => {
    const d = deps();
    d.readBoard = vi.fn(async () => { throw new Error('cannot read /private/runs-dir-path'); });
    const result = await call('GET', PATH, d);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ status: 'unavailable', board: null });
    expect(JSON.stringify(result.json)).not.toContain('/private/');
  });

  it('rejects unknown query parameters', async () => {
    const result = await call('GET', `${PATH}?bogus=1`);
    expect(result.status).toBe(400);
    expect(result.json).toMatchObject({ code: 'VERSE_INVALID' });
    expect(result.deps.readBoard).not.toHaveBeenCalled();
  });

  it('answers 405 for other methods on the path and false for other paths', async () => {
    expect((await call('POST')).status).toBe(405);
    expect((await call('DELETE')).status).toBe(405);
    expect((await call('GET', '/api/verse/fleet/board/extra')).handled).toBe(false);
    expect((await call('GET', '/api/verse/fleet/boards')).handled).toBe(false);
    expect((await call('GET', '/api/verse/other')).handled).toBe(false);
  });
});
