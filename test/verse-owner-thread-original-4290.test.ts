/**
 * Preservation of original PR #4290's (RQ-PHX-OWNERTHREADDESKAPI09) missing
 * test/verse-owner-thread-api.test.ts through TODAY's real API:
 *
 *   - OWNER_THREAD_API_PATH is now VERSE_OWNER_THREAD_PATH
 *     ('/api/verse/comms/owner-thread'); createOwnerThreadApi(deps) is the
 *     current factory (the original called a handler export directly).
 *   - The response now carries `status: { kill, paused, adapters }` (schema
 *     comms.owner-thread.status.v1 lives in readOwnerCommsStatus, not on the
 *     wire body); `unavailable: true` is reserved for an unreadable store.
 *   - limit is strict: only a plain integer 1..200 is accepted (the original's
 *     permissive clamp of 99999/-4 to "all messages" is now a 400).
 *   - GET answers only inside a dispatch session (ctx.allowDispatch), which
 *     the original predates; asserted here as a no-leak 404.
 *
 * Original scenarios kept: unconfigured channel state answers truthfully,
 * three desktop inbound messages read back in order with channel
 * attribution, limit bounds the result, unrelated paths are unhandled, POST
 * is rejected. No function under test is mocked; no transport is built.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound } from '../src/core/comms/owner-thread.js';
import { createOwnerThreadApi, VERSE_OWNER_THREAD_PATH, type OwnerThreadApiDeps } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

const NOW = 1_700_000_000_000;

/** The original fixture verbatim: plainly fake identities, no secret handles. */
const settings: OwnerThreadSettings = {
  owners: { desktop: 'local-owner' }, secretHandles: {}, imessageBridge: 'off', confirmed: true,
  team: [{ channel: 'bus', id: 'local-owner' }],
};

const mailbox = { async accept() { return { status: 'accepted' as const, requestId: 'req-test-1' }; } };

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owner-thread-api-4290-'));
  roots.push(dir);
  return dir;
}

async function get(deps: OwnerThreadApiDeps, url = VERSE_OWNER_THREAD_PATH, method = 'GET', allowDispatch = true) {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = url; req.method = method; req.headers = {};
  let status = 0; let text = '';
  const res = {
    headersSent: false,
    writeHead(code: number, _headers?: Record<string, string>) { status = code; return this; },
    end(body?: unknown) { text = typeof body === 'string' ? body : ''; },
  } as unknown as ServerResponse;
  const handled = await createOwnerThreadApi(deps)(
    { cfg: {}, allowDispatch } as VerseApiContext, req, res, url.split('?')[0]!, method);
  return { handled, status, wire: text ? JSON.parse(text) : null };
}

describe('owner thread api — original #4290 scenarios on the current contract', () => {
  it('answers truthfully when no channel is configured', async () => {
    const runsDir = temp();
    const deps: OwnerThreadApiDeps = {
      runsDir, busRoot: join(runsDir, 'bus'), now: () => NOW,
      settings: { ...settings, owners: {}, confirmed: false },
    };
    const { status, wire } = await get(deps);
    expect(status).toBe(200);
    expect(wire).toMatchObject({ schema: 'comms.owner-thread.v1', threadId: 'owner', messages: [] });
    // A readable empty store is not "unavailable"; the truthful signal is that
    // every adapter reports itself unconfigured and disabled.
    expect(wire.unavailable).toBeUndefined();
    expect(wire.status.adapters.length).toBeGreaterThan(0);
    for (const adapter of wire.status.adapters) {
      expect(adapter.configured).toBe(false);
      expect(adapter.enabled).toBe(false);
    }
  });

  it('returns three desktop inbound messages in order with channel attribution', async () => {
    const runsDir = temp();
    const deps: OwnerThreadApiDeps = {
      runsDir, busRoot: join(runsDir, 'bus'), settings, mailbox, now: () => NOW,
    };
    for (const n of [1, 2, 3]) {
      const r = await acceptOwnerInbound(
        { channel: 'desktop', senderId: 'local-owner', text: `hello ${n}`, idempotencyKey: `desktop-msg-${n}`, at: NOW + n },
        { runsDir, busRoot: join(runsDir, 'bus'), settings, mailbox, now: () => NOW });
      expect(r.status).toBe('accepted');
    }
    const all = await get(deps);
    expect(all.handled).toBe(true);
    expect(all.status).toBe(200);
    expect(all.wire.schema).toBe('comms.owner-thread.v1');
    expect(all.wire.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3]);
    expect(all.wire.messages.map((m: { text: string }) => m.text)).toEqual(['hello 1', 'hello 2', 'hello 3']);
    for (const m of all.wire.messages) {
      expect(m).toMatchObject({ channel: 'desktop', senderId: 'local-owner', direction: 'inbound' });
    }
    expect(all.wire.unavailable).toBeUndefined();
  });

  it('bounds the result with limit=2 and rejects malformed, negative and over-max limits', async () => {
    const runsDir = temp();
    const deps: OwnerThreadApiDeps = {
      runsDir, busRoot: join(runsDir, 'bus'), settings, mailbox, now: () => NOW,
    };
    for (const n of [1, 2, 3]) {
      await acceptOwnerInbound(
        { channel: 'desktop', senderId: 'local-owner', text: `hello ${n}`, idempotencyKey: `desktop-msg-${n}`, at: NOW + n },
        { runsDir, busRoot: join(runsDir, 'bus'), settings, mailbox, now: () => NOW });
    }
    const two = await get(deps, `${VERSE_OWNER_THREAD_PATH}?limit=2`);
    expect(two.status).toBe(200);
    expect(two.wire.messages.map((m: { text: string }) => m.text)).toEqual(['hello 2', 'hello 3']);
    for (const bad of ['99999', '-4', 'abc', '0', '201', '1.5', '']) {
      const r = await get(deps, `${VERSE_OWNER_THREAD_PATH}?limit=${bad}`);
      expect(r.status, `limit=${bad}`).toBe(400);
      expect(JSON.stringify(r.wire)).not.toContain('hello');
    }
  });

  it('leaks nothing without a dispatch session', async () => {
    const runsDir = temp();
    const deps: OwnerThreadApiDeps = {
      runsDir, busRoot: join(runsDir, 'bus'), settings, mailbox, now: () => NOW,
    };
    await acceptOwnerInbound(
      { channel: 'desktop', senderId: 'local-owner', text: 'private owner line', idempotencyKey: 'desktop-msg-9', at: NOW + 9 },
      { runsDir, busRoot: join(runsDir, 'bus'), settings, mailbox, now: () => NOW });
    const denied = await get(deps, VERSE_OWNER_THREAD_PATH, 'GET', false);
    expect(denied.status).toBe(404);
    expect(JSON.stringify(denied.wire)).not.toContain('private owner line');
    const statusDenied = await get(deps, `${VERSE_OWNER_THREAD_PATH}/status`, 'GET', false);
    expect(statusDenied.status).toBe(404);
  });

  it('ignores other paths and rejects POST', async () => {
    expect((await get({}, '/api/verse/other')).handled).toBe(false);
    const runsDir = temp();
    const post = await get({ runsDir, busRoot: join(runsDir, 'bus'), settings, mailbox, now: () => NOW }, VERSE_OWNER_THREAD_PATH, 'POST');
    expect(post.handled).toBe(true);
    expect(post.status).toBe(405);
    expect(post.wire).toMatchObject({ error: 'The owner thread is read only here.' });
  });
});
