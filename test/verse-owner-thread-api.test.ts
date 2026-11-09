import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound } from '../src/core/comms/owner-thread.js';
import { createOwnerThreadApi, OWNER_THREAD_API_PATH, type OwnerThreadApiDeps } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

const settings: OwnerThreadSettings = {
  owners: { desktop: 'local-owner' }, secretHandles: {}, imessageBridge: 'off', confirmed: true,
  team: [{ channel: 'bus', id: 'local-owner' }],
};

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owner-thread-api-'));
  roots.push(dir);
  return dir;
}

async function get(deps: OwnerThreadApiDeps, url = OWNER_THREAD_API_PATH, method = 'GET') {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = url; req.method = method; req.headers = {};
  let status = 0; let wire: any = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; },
    end(text: string) { wire = JSON.parse(text); },
  } as unknown as ServerResponse;
  const handled = await createOwnerThreadApi(deps)({} as VerseApiContext, req, res, url.split('?')[0]!, method);
  return { handled, status, wire };
}

describe('owner thread api', () => {
  it('answers unavailable with 200 when nothing is configured', async () => {
    const runsDir = temp();
    const { status, wire } = await get({ runsDir, busRoot: join(runsDir, 'bus'), settings: { ...settings, owners: {}, confirmed: false } });
    expect(status).toBe(200);
    expect(wire).toMatchObject({ messages: [], unavailable: true, status: { schema: 'comms.owner-thread.status.v1' } });
  });

  it('returns desktop messages and clamps limit', async () => {
    const runsDir = temp();
    const deps = { runsDir, busRoot: join(runsDir, 'bus'), settings, now: () => 1_700_000_000_000 };
    for (const n of [1, 2, 3]) {
      const r = await acceptOwnerInbound({ channel: 'desktop', senderId: 'local-owner', text: `hello ${n}`, idempotencyKey: `desktop-msg-${n}`, at: 1_700_000_000_000 + n },
        { ...deps, mailbox: { async accept(m) { return { status: 'accepted', requestId: m.idempotencyKey }; } } });
      expect(r.status).toBe('accepted');
    }
    const all = await get(deps);
    expect(all.wire.messages.map((m: any) => m.text)).toEqual(['hello 1', 'hello 2', 'hello 3']);
    expect(all.wire.messages[0].channel).toBe('desktop');
    expect(all.wire.unavailable).toBeUndefined();
    expect((await get(deps, `${OWNER_THREAD_API_PATH}?limit=2`)).wire.messages).toHaveLength(2);
    expect((await get(deps, `${OWNER_THREAD_API_PATH}?limit=99999`)).wire.messages).toHaveLength(3);
    expect((await get(deps, `${OWNER_THREAD_API_PATH}?limit=-4`)).wire.messages).toHaveLength(3);
  });

  it('ignores other paths and rejects other methods', async () => {
    expect((await get({}, '/api/verse/other')).handled).toBe(false);
    expect((await get({}, OWNER_THREAD_API_PATH, 'POST')).status).toBe(405);
  });
});
