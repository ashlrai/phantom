import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { handleLeaderApi } from './leader-api.js';
import type { VerseApiContext } from './verse-api.js';

vi.mock('../fleet/order-trace.js', () => ({
  readOrderTrace: async () => ({ v: 1, generatedAt: new Date(0).toISOString(), sources: { inbox: 'missing', prompts: 'missing', publishes: 'missing' }, orders: [] }),
}));
it.each([['GET', '', 200], ['POST', '', 405], ['GET', '?x=1', 400], ['GET', '?', 400]])('orders %s %s returns %i', async (method, query, expected) => {
  let status = 0;
  let body = '';
  const response = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(chunk: string) { body = chunk; },
  } as unknown as ServerResponse;
  const path = '/api/verse/leader/orders';
  expect(await handleLeaderApi({} as VerseApiContext, { url: path + query } as IncomingMessage, response, path, method)).toBe(true);
  expect(status).toBe(expected);
  if (expected === 200) expect(JSON.parse(body)).toMatchObject({ v: 1, orders: [], sources: { inbox: 'missing', prompts: 'missing', publishes: 'missing' } });
});
