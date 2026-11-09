/** GET /api/verse/comms/owner-thread: the desktop read of the owner thread. Synthetic ids, temp dirs, no transports. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveOwnerTransports } from '../src/core/comms/owner-live-transport.js';
import type { OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { createOwnerThreadApi, VERSE_OWNER_THREAD_PATH as PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { parseOwnerThreadRead } from '../src/web-ui/routes/verse/leader-thread/owner-thread-queries.js';

const transport = vi.hoisted(() => ({ pull: vi.fn(), send: vi.fn() }));
vi.mock('../src/core/comms/owner-live-transport.js', () => ({
  liveOwnerTransports: vi.fn(() => ({ telegram: transport, email: transport, slack: transport, imessage: transport })),
}));

const NOW = 1_700_000_000_000;
const settings: OwnerThreadSettings = {
  owners: { telegram: 'owner-test-1', desktop: 'local-owner' },
  secretHandles: { telegram: 'phm_TELEGRAM_BOT_TOKEN' },
  imessageBridge: 'off',
  confirmed: true,
  team: [{ channel: 'bus', id: 'local-owner' }, { channel: 'telegram', id: 'owner-test-1' }],
};
const mailbox = { async accept() { return { status: 'accepted' as const, requestId: 'req-test-1' }; } };

let runsDir: string;
let configDir: string;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'owner-thread-api-'));
  configDir = mkdtempSync(join(tmpdir(), 'owner-thread-cfg-'));
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

async function call(method = 'GET', query = '', allowDispatch = true) {
  const url = PATH + query;
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const api = createOwnerThreadApi({ runsDir, configDir, now: () => NOW });
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, PATH, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

async function seed(count: number): Promise<void> {
  const options: OwnerThreadOptions = { runsDir, busRoot: join(runsDir, 'bus'), now: () => NOW, settings, halted: false, paused: false, mailbox };
  for (let i = 1; i <= count; i++) {
    const result = await acceptOwnerInbound({ channel: 'telegram', senderId: 'owner-test-1', text: `fake line ${i}`, idempotencyKey: `telegram-test-${String(i).padStart(4, '0')}`, at: NOW + i }, options);
    expect(result.status).toBe('accepted');
  }
}

describe('GET /api/verse/comms/owner-thread', () => {
  it('an empty dir answers 200 with no messages and a parseable status', async () => {
    const r = await call();
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body.schema).toBe('comms.owner-thread.v1');
    expect(r.body.messages).toEqual([]);
    const read = parseOwnerThreadRead(r.body);
    expect(read.lines).toEqual([]);
    expect(read.channels.length).toBeGreaterThan(0);
    expect(read.paused).toBe(false);
  });

  it('serves a seeded thread that the desktop parser reads as lines', async () => {
    await seed(2);
    const r = await call();
    expect(r.body.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    const read = parseOwnerThreadRead(r.body);
    expect(read.lines.map(line => line.text)).toEqual(['fake line 1', 'fake line 2']);
    expect(read.lines[0]).toMatchObject({ channel: 'telegram', direction: 'inbound', senderId: 'owner-test-1' });
  });

  it('clamps the limit to the newest lines and rejects a bad one with 400', async () => {
    await seed(3);
    expect((await call('GET', '?limit=2')).body.messages.map((m: { seq: number }) => m.seq)).toEqual([2, 3]);
    expect((await call('GET', '?limit=200')).status).toBe(200);
    for (const bad of ['0', '201', '-1', '1.5', 'abc', '', '1e2']) {
      const r = await call('GET', `?limit=${bad}`);
      expect(r.status, `limit=${bad}`).toBe(400);
    }
  });

  it('answers non-GET with 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await call(method)).status).toBe(405);
  });

  it('is 404 without a local dispatch session', async () => {
    await seed(1);
    const r = await call('GET', '', false);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('fake line');
  });

  it('never returns a secret handle', async () => {
    await seed(1);
    const r = await call();
    const keys = (value: unknown): string[] => value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]) : [];
    expect(keys(r.body)).not.toContain('secretHandle');
    expect(Object.keys(r.body.status.adapters[0]).sort()).toEqual(['configured', 'enabled', 'halted', 'id', 'nextStep', 'reason']);
    expect(r.body.status).toMatchObject({ kill: false, paused: false });
  });

  it('ignores other paths and never builds a live transport', async () => {
    const api = createOwnerThreadApi({ runsDir, configDir, now: () => NOW });
    const res = { writeHead() { return this; }, end() {} } as unknown as ServerResponse;
    expect(await api({ cfg: {}, allowDispatch: true } as VerseApiContext, { url: '/api/verse/other' } as IncomingMessage, res, '/api/verse/other', 'GET')).toBe(false);
    await seed(1);
    await call();
    expect(liveOwnerTransports).not.toHaveBeenCalled();
    expect(transport.pull).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });
});
