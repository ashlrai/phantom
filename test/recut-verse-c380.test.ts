import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createFleetOrderStateApi, VERSE_FLEET_ORDER_STATE_PATH } from '../src/core/verse/fleet-order-state-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

it('reports live evidence unavailable after a trace read times out without reading workers', async () => {
  const live = vi.fn();
  const lanes = vi.fn();
  const handler = createFleetOrderStateApi({
    read: () => new Promise(() => {}),
    now: () => new Date('2026-11-14T10:00:00.000Z'),
    timeoutMs: 5,
    live,
    lanes,
  });
  let status = 0;
  let body = '';
  const response = {
    writeHead(code: number) { status = code; return this; },
    end(text: string) { body = text; },
  } as unknown as ServerResponse;
  const handled = await handler({} as VerseApiContext,
    { url: VERSE_FLEET_ORDER_STATE_PATH } as IncomingMessage,
    response, VERSE_FLEET_ORDER_STATE_PATH, 'GET');
  expect(handled).toBe(true);
  expect(status).toBe(200);
  expect(JSON.parse(body)).toEqual({
    v: 1, asOf: '2026-11-14T10:00:00.000Z', sources: 'unavailable',
    live: 'unavailable', orders: [],
  });
  expect(live).not.toHaveBeenCalled();
  expect(lanes).not.toHaveBeenCalled();
});
