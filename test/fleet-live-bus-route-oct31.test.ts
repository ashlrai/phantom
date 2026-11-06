import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleFleetLiveApi } from '../src/core/verse/fleet-live-api.js';
import { VERSE_FLEET_LIVE_BUS_PATH } from '../src/core/fleet/bus-feed.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function request(method = 'GET', query = '', path = VERSE_FLEET_LIVE_BUS_PATH) {
  let status = 0;
  let body = '';
  const res = { writeHead(code: number) { status = code; return this; },
    end(value: string) { body = value; return this; } } as unknown as ServerResponse;
  const req = { url: path + query } as IncomingMessage;
  const handled = await handleFleetLiveApi({} as VerseApiContext, req, res, path, method);
  return { status, body: body ? JSON.parse(body) : null, handled };
}

describe('fleet live bus HTTP edge', () => {
  it('serves the versioned read-only feed', async () => {
    const result = await request('GET', '?limit=2');
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ v: 1, hops: [], events: [] });
  });
  it('rejects POST', async () => { expect((await request('POST')).status).toBe(405); });
  it.each(['?unknown=1', '?limit=no', '?limit=1.5', '?limit=1&limit=2', '?limit='])('rejects invalid query %s', async (query) => {
    expect((await request('GET', query)).status).toBe(400);
  });
  it('leaves unrelated paths to other modules', async () => {
    expect(await request('GET', '', '/api/unrelated')).toEqual({ handled: false, status: 0, body: null });
  });
});
