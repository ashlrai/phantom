/** GET /api/verse/comms/mason-thread: the Mason panel's read. Temp dirs, no transports, nothing sent. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { acceptOwnerInbound } from '../src/core/comms/owner-thread.js';
import { createOwnerThreadApi, VERSE_MASON_THREAD_PATH as PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const settings = { owners: { desktop: 'local-owner' }, secretHandles: {}, confirmed: true, team: [{ channel: 'bus' as const, id: 'local-owner' }] };
let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'mason-api-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

async function call(query = '', method = 'GET', allowDispatch = true) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH + query, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const api = createOwnerThreadApi({ runsDir, busRoot: join(runsDir, 'bus'), settings, now: () => NOW });
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

it('answers an empty thread with the schema id and no items', async () => {
  const r = await call();
  expect(r).toMatchObject({ handled: true, status: 200, body: { schema: 'phantom.mason.thread.v1', items: [] } });
});

it('serves a message as Received and refuses writes and bad windows', async () => {
  await acceptOwnerInbound({ channel: 'desktop', senderId: 'local-owner', text: 'hello leader', idempotencyKey: 'desk-api-1', at: NOW - 60_000 },
    { runsDir, busRoot: join(runsDir, 'bus'), now: () => NOW, settings, halted: false, paused: false, mailbox: { async accept() { return { status: 'accepted' as const }; } } });
  expect((await call('?since=1h')).body.items).toMatchObject([{ dir: 'in', channel: 'desktop', text: 'hello leader', state: 'RECEIVED' }]);
  expect((await call('', 'POST')).status).toBe(405);
  expect((await call('?since=soon')).status).toBe(400);
  expect((await call('', 'GET', false)).status).toBe(404);
});
