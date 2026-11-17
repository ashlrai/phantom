import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';
import { recordDelivery } from '../src/core/leader/delivery-receipts.js';
import { createOwnerThreadApi, VERSE_OWNER_THREAD_PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'recut-c381-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function read(allowDispatch: boolean, query = '') {
  const req = Object.assign(new PassThrough(), {
    url: `${VERSE_OWNER_THREAD_PATH}${query}`, method: 'GET',
  }) as IncomingMessage;
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    end(text: string) { body = JSON.parse(text) as Record<string, unknown>; },
  } as unknown as ServerResponse;
  const api = createOwnerThreadApi({
    runsDir: root, busRoot: join(root, 'bus'), settings: emptyOwnerSettings(),
  });
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext,
    req, res, VERSE_OWNER_THREAD_PATH, 'GET');
  return { handled, status, body };
}

it('keeps owner-thread receipts behind the dispatch-session read gate', async () => {
  recordDelivery(root, 'synthetic-outbound', 'desktop', 'delivered');
  expect(await read(false)).toEqual({ handled: true, status: 404, body: { error: 'not found' } });
});

it('does not expose orphan receipts or fabricate receipts for an empty thread', async () => {
  recordDelivery(root, 'synthetic-outbound', 'desktop', 'delivered');
  const result = await read(true);
  expect(result.handled).toBe(true);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ schema: 'comms.owner-thread.v1', messages: [], receipts: {} });
});

it('rejects an invalid read limit before returning any receipt data', async () => {
  const result = await read(true, '?limit=201');
  expect(result.status).toBe(400);
  expect(result.body).toEqual({ error: 'limit must be an integer from 1 to 200.' });
});
