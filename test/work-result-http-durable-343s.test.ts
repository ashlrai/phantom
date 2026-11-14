/** RQ-PHX-RESULTHTTPDURABLE343S — POST /api/verse/fleet/work-board/result
 * against REAL durable bus state with production-default read/postReply on
 * a temp ASHLR_HOME fleet root; a fresh API instance proves restart
 * durability, exact retry is 'duplicate' with no new row, changed content
 * under the same reply id is HTTP 409 leaving the receipt byte-identical,
 * and a second Slack request stays independent. Evidence only, fake ids. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VERSE_FLEET_WORK_BOARD_PATH as BOARD,
  VERSE_FLEET_WORK_RESULT_PATH as RESULT,
  createFleetWorkBoardApi,
} from '../src/core/verse/fleet-work-board-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { appendBusInbox, listBusInboxAfter, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';

const ID_A = 'RQ-PHX-FAKE-343-A';
const ID_B = 'RQ-PHX-FAKE-343-B';
const REPLY = 'fake-reply-343-blocked';
const TS_A = 'T0FAKEDT/C0FAKEDT/1700000000.000343a';
const TS_B = 'T0FAKEDT/C0FAKEDT/1700000000.000343b';
const DEP = 'fake-dep-343-owner-signoff';

const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: 10_000_000,
  channel: 'slack', channel_ref: ref, external: false, body: { kind: 'work' },
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
});

async function call(api: ApiModule, method: string, path: string, raw?: string) {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), { url: path }) as unknown as IncomingMessage;
  const pending = api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, path.split('?')[0]!, method);
  if (raw !== undefined) {
    await Promise.resolve();
    req.emit('data', Buffer.from(raw, 'utf8'));
    req.emit('end');
  }
  await pending;
  return { status, body: text ? JSON.parse(text) : null };
}

const postResult = (api: ApiModule, blocked: string) =>
  call(api, 'POST', RESULT, JSON.stringify({ requestId: ID_A, replyId: REPLY, result: { blocked } }));
const inboxIds = (root: string) => {
  const page = listBusInboxAfter(0, 100, { root });
  return page.status === 'ok' ? page.messages.map(m => m.envelope.id) : [];
};

describe('work-board result http durable', { timeout: 60_000 }, () => {
  let home: string, fleetRoot: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'result-http-durable-343-'));
    fleetRoot = join(home, 'fleet');
    vi.stubEnv('ASHLR_HOME', home);
    for (const [id, ref] of [[ID_A, TS_A], [ID_B, TS_B]] as const)
      expect(appendBusInbox(slackRequest(id, ref)).status).toBe('posted');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('persists across restart; exact retry duplicates; changed body conflicts at 409', async () => {
    const api1 = createFleetWorkBoardApi();
    const posted = await postResult(api1, DEP);
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ outcome: 'posted', schema: 'fleet.bus-reply.v1' });
    const snapshotFile = join(fleetRoot, 'bus-inbox', 'messages.json');
    const snapshot = readFileSync(snapshotFile, 'utf8');

    // Restart: a fresh module instance serves the same durable store.
    const api2 = createFleetWorkBoardApi();
    expect(inboxIds(fleetRoot)).toEqual([ID_A, ID_B, REPLY]);
    const board = await call(api2, 'GET', BOARD);
    expect(board.status).toBe(200);
    expect(board.body.inbox).toBe('ok');
    const items = board.body.items as { id: string; state: string; channelRef: string | null; owner: unknown; result?: unknown }[];
    expect(items.map(i => i.id).sort()).toEqual([ID_A, ID_B]);
    const a = items.find(i => i.id === ID_A)!;
    expect(a).toMatchObject({ state: 'BLOCKED', channelRef: TS_A, owner: null });
    expect(a.result).toEqual({ kind: 'blocked', dependency: DEP });
    const b = items.find(i => i.id === ID_B)!;
    expect(b).toMatchObject({ state: 'RECEIVED', channelRef: TS_B, owner: null });
    expect(b.result).toBeUndefined();

    // Thread isolation: each channel_ref returns only its own request.
    for (const [ref, id] of [[TS_A, ID_A], [TS_B, ID_B]] as const) {
      const r = await call(api2, 'GET', `${BOARD}?thread=${encodeURIComponent(ref)}`);
      expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([id]);
    }

    // Exact retry: 'duplicate', no extra bus row, snapshot bytes unchanged.
    const retry = await postResult(api2, DEP);
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('duplicate');
    expect(inboxIds(fleetRoot)).toEqual([ID_A, ID_B, REPLY]);
    expect(readFileSync(snapshotFile, 'utf8')).toBe(snapshot);

    // Same reply id, changed evidence: HTTP 409, receipt untouched.
    const conflict = await postResult(api2, 'fake-dep-343-other');
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ outcome: 'transport-refused', transport: 'conflict' });
    expect(inboxIds(fleetRoot)).toEqual([ID_A, ID_B, REPLY]);
    expect(readFileSync(snapshotFile, 'utf8')).toBe(snapshot);

    // Request B stays independent; A still reports the original receipt.
    const again = (await call(api2, 'GET', BOARD)).body.items as typeof items;
    expect(again.find(i => i.id === ID_B)).toMatchObject({ state: 'RECEIVED', owner: null });
    const a2 = again.find(i => i.id === ID_A)!;
    expect(a2).toMatchObject({ state: 'BLOCKED', owner: null });
    expect(a2.result).toEqual({ kind: 'blocked', dependency: DEP });
  });
});
