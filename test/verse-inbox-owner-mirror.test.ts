import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import type { OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { readOwnerThread } from '../src/core/comms/owner-thread.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_INBOX_PATH as INBOX } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const TOKEN = 'fleet-test-token';
const roots: string[] = [];
// The inbox route lazy-imports the mirror; load it once up front so a cold
// import on a busy machine does not count against the first case's timeout.
beforeAll(async () => { await import('../src/core/verse/owner-thread-api.js'); }, 60_000);
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

const settings: OwnerThreadSettings = {
  owners: { desktop: 'local-owner' }, secretHandles: {}, imessageBridge: 'off', confirmed: true,
  team: [{ channel: 'bus', id: 'local-owner' }, { channel: 'bus', id: 'leader' }],
};

function fixture(ownerSettings: OwnerThreadSettings = settings) {
  const home = mkdtempSync(join(tmpdir(), 'inbox-mirror-'));
  roots.push(home);
  mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
  vi.stubEnv('HOME', home);
  const runsDir = join(home, 'runs');
  const ownerThread = { runsDir: join(home, 'owner-runs'), busRoot: join(home, 'bus'), settings: ownerSettings,
    mailbox: { async accept(m: { idempotencyKey: string }) { return { status: 'accepted' as const, requestId: m.idempotencyKey }; } } };
  const api = createFleetRunsApi({ runsDir, ownerThread });
  const post = async (text: string, extraHeaders: Record<string, string> = {}) => {
    const req = Readable.from([JSON.stringify({ text })]) as unknown as IncomingMessage;
    req.url = INBOX; req.method = 'POST';
    req.headers = { 'content-type': 'application/json', 'x-ashlr-token': TOKEN, ...extraHeaders };
    let status = 0; let wire: any = null;
    const res = { headersSent: false, writeHead(c: number) { status = c; }, end(t: string) { wire = JSON.parse(t); } } as unknown as ServerResponse;
    await api({ cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true } as VerseApiContext, req, res, INBOX, 'POST');
    return { status, wire };
  };
  return { home, post, messages: () => readOwnerThread(ownerThread).messages };
}

describe('inbox post mirrors onto the owner thread', () => {
  it('mirrors once and dedupes a repost', async () => {
    const f = fixture();
    const first = await f.post('ship the thing');
    expect(first.status).toBe(201);
    expect(first.wire.ownerThread).toEqual({ status: 'accepted' });
    expect(f.messages()).toHaveLength(1);
    expect(f.messages()[0]).toMatchObject({ channel: 'desktop', senderId: 'local-owner', text: 'ship the thing', direction: 'inbound' });
    const again = await f.post('ship the thing');
    expect(again.status).toBe(200);
    expect(again.wire.duplicate).toBe(true);
    expect(again.wire.ownerThread).toEqual({ status: 'duplicate' });
    expect(f.messages()).toHaveLength(1);
  });

  it('still succeeds with KILL armed and leaves the thread unchanged', async () => {
    const f = fixture();
    writeFileSync(join(f.home, '.ashlr', 'KILL'), 'kill switch active\n', { mode: 0o600 });
    const res = await f.post('while killed');
    expect([200, 201]).toContain(res.status);
    expect(res.wire.ok).toBe(true);
    expect(res.wire.ownerThread).toEqual({ status: 'halted' });
    expect(f.messages()).toHaveLength(0);
  });

  it('does not file a mobile post as a desktop thread message', async () => {
    const f = fixture();
    const res = await f.post('from the phone', { 'x-ashlr-channel': 'mobile' });
    expect(res.status).toBe(201);
    expect(res.wire.ok).toBe(true);
    expect(res.wire).not.toHaveProperty('ownerThread');
    expect(f.messages()).toHaveLength(0);
  });

  it('reports unavailable without failing the post when no desktop owner is set', async () => {
    const f = fixture({ ...settings, owners: {} });
    const res = await f.post('no owner yet');
    expect(res.status).toBe(201);
    expect(res.wire.ok).toBe(true);
    expect(res.wire.ownerThread).toEqual({ status: 'unavailable' });
    expect(f.messages()).toHaveLength(0);
  });
});
