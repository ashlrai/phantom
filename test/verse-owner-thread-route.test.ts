/** GET /api/verse/comms/owner-thread: synthetic ids, temp runsDir, no transports. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { handleOwnerThreadApi, OWNER_THREAD_PATH } from '../src/core/verse/owner-thread-api.js';
import { handleVerseApi, type VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { parseOwnerThreadRead } from '../src/web-ui/routes/verse/leader-thread/owner-thread-queries.js';

const settings: OwnerThreadSettings = {
  owners: { telegram: 'owner-test-1', desktop: 'local-owner' },
  secretHandles: { telegram: 'phm_TELEGRAM_BOT_TOKEN' },
  imessageBridge: 'off',
  confirmed: true,
  team: [{ channel: 'bus', id: 'local-owner' }, { channel: 'telegram', id: 'owner-test-1' }],
};
let runsDir: string;
let file: string;
const accepted = { async accept() { return { status: 'accepted' as const, requestId: 'req-test-1' }; } };

beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'owner-thread-route-'));
  file = join(runsDir, 'leader', 'owner-thread.json');
  const options: OwnerThreadOptions = { runsDir, busRoot: join(runsDir, 'bus'), now: () => 1_700_000_000_000, settings, halted: false, paused: false, mailbox: accepted };
  await acceptOwnerInbound({ channel: 'telegram', senderId: 'owner-test-1', text: 'first fake line', idempotencyKey: 'telegram-test-0001', at: 1_700_000_000_000 }, options);
  await acceptOwnerInbound({ channel: 'telegram', senderId: 'owner-test-1', text: 'second fake line', idempotencyKey: 'telegram-test-0002', at: 1_700_000_001_000 }, options);
});
afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

async function call(method: string, query = '') {
  let status = 0; let body = ''; let writes = 0;
  const res = { writeHead(code: number) { status = code; writes++; }, end(v: string) { body = v; } } as unknown as ServerResponse;
  const handled = await handleOwnerThreadApi({ url: OWNER_THREAD_PATH + query } as IncomingMessage, res, OWNER_THREAD_PATH, method, { runsDir, settings });
  return { handled, status, writes, body: body ? JSON.parse(body) : null };
}

describe('GET /api/verse/comms/owner-thread', () => {
  it('returns the schema, messages in seq order and adapter status', async () => {
    const r = await call('GET');
    expect(r.status).toBe(200);
    expect(r.body.schema).toBe('comms.owner-thread.v1');
    expect(r.body.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    expect(r.body.status.kill).toBe(false);
    expect(r.body.status.paused).toBe(false);
    expect(Array.isArray(r.body.status.adapters)).toBe(true);
  });

  it('limit=1 returns only the newest message', async () => {
    const r = await call('GET', '?limit=1');
    expect(r.body.messages.map((m: { seq: number }) => m.seq)).toEqual([2]);
  });

  it.each(['0', '201', 'abc', '-1', '1.5'])('rejects limit=%s with 400', async limit => {
    expect((await call('GET', `?limit=${limit}`)).status).toBe(400);
  });

  it('answers POST with 405 and leaves the thread bytes unchanged', async () => {
    const before = readFileSync(file);
    const r = await call('POST');
    expect(r.status).toBe(405);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('serves a corrupt thread as 200 unavailable with no messages', async () => {
    writeFileSync(file, '{not json');
    const r = await call('GET');
    expect(r.status).toBe(200);
    expect(r.body.unavailable).toBe(true);
    expect(r.body.messages).toEqual([]);
  });

  it('is parsed by the Leader pane reader', async () => {
    const read = parseOwnerThreadRead((await call('GET')).body);
    expect(read.lines).toHaveLength(2);
    expect(read.paused).toBe(false);
  });

  it('404s unknown children through handleVerseApi', async () => {
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end() {} } as unknown as ServerResponse;
    const path = `${OWNER_THREAD_PATH}/x`;
    const ctx = { cfg: { version: 1 } as AshlrConfig, token: 'fixture', allowDispatch: false } as VerseApiContext;
    expect(await handleVerseApi(ctx, { url: path } as IncomingMessage, res, path, 'GET')).toBe(true);
    expect(status).toBe(404);
  });
});
