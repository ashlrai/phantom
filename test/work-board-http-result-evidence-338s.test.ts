/** RQ-PHX-BOARDHTTPRESULTPROOF338S — the desktop work-board HTTP read
 * (GET /api/verse/fleet/work-board) served by createFleetWorkBoardApi with
 * its DEFAULT real board reader against a temporary ASHLR_HOME holding real
 * persisted bus requests, a real durable claim row and real work-result
 * replies posted through `fleet work-result`. No WorkBoardResult is ever
 * fabricated: every state on the wire is derived by listWorkBoard from the
 * same inbox scan and claims inspection the CLI uses. A routing lane alone
 * stays RECEIVED, a named durable claim shows ASSIGNED with its
 * bus-claim receipt, a blocked reply shows the exact bounded dependency, a
 * verified reply carries its tests evidence, and two distinct channel_refs
 * stay isolated under the thread query. Reads never mutate the claim ledger
 * or the inbox, asOf comes from the injected clock, and a failed store
 * reports 'unavailable', never a successful empty board. Fake ids only; no
 * network sends. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VERSE_FLEET_WORK_BOARD_PATH as PATH,
  createFleetWorkBoardApi,
} from '../src/core/verse/fleet-work-board-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';

const T0 = Date.parse('2026-11-14T04:00:00.000Z');
const T_BOARD = T0 + 180_000;
const TTL = 10_000_000;

const ID_RECV = 'RQ-PHX-FAKE-338-RECV';
const ID_CLAIM = 'RQ-PHX-FAKE-338-CLAIM';
const ID_BLOCKED = 'RQ-PHX-FAKE-338-BLOCKED';
const ID_VERIFIED = 'RQ-PHX-FAKE-338-VERIFIED';
const TS_A = 'T0FAKEDT/C0FAKEDT/1700000000.000338a';
const TS_B = 'T0FAKEDT/C0FAKEDT/1700000000.000338b';
const DEPENDENCY = 'fake-dep-338-owner-signoff';
const TESTS = 'fake-338-suite-green';
const OWNER = 'fake-worker-338';

const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'work', note: `CANARY-338-${id}` },
});

async function call(api: ApiModule, url = PATH) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api(
    { cfg: {}, allowDispatch: true } as VerseApiContext,
    { url } as IncomingMessage,
    res,
    url.split('?')[0]!,
    'GET',
  );
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('fleet work-board http result evidence', { timeout: 60_000 }, () => {
  let home: string, fleetRoot: string, now: number, previousAshlr: string | undefined;
  let api: ApiModule;

  const postRequest = (id: string, ref: string) =>
    expect(appendBusInbox(slackRequest(id, ref), { root: fleetRoot, now: () => now }).status).toBe('posted');
  const workResult = async (requestId: string, replyId: string, extra: string[]) => {
    const output: string[] = [];
    const code = await cmdFleetWorkResult(
      ['--request-id', requestId, '--reply-id', replyId, '--root', fleetRoot, ...extra],
      { now: () => now }, { output: text => output.push(text) });
    return { code, result: JSON.parse(output.join('')) as { outcome: string } };
  };
  const itemById = (body: { items: { id: string }[] }, id: string) =>
    body.items.find(i => i.id === id) as Record<string, unknown> | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'board-http-338-'));
    fleetRoot = join(home, 'fleet');
    previousAshlr = process.env['ASHLR_HOME'];
    process.env['ASHLR_HOME'] = home;
    now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // Default real reader only: the injected clock is the sole seam.
    api = createFleetWorkBoardApi({ now: () => new Date(T_BOARD) });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (previousAshlr === undefined) delete process.env['ASHLR_HOME'];
    else process.env['ASHLR_HOME'] = previousAshlr;
    rmSync(home, { recursive: true, force: true });
  });

  it('serves real bus claim/result evidence per request, isolated by thread', async () => {
    postRequest(ID_RECV, TS_A);
    postRequest(ID_CLAIM, TS_B);
    postRequest(ID_BLOCKED, TS_A);
    postRequest(ID_VERIFIED, TS_B);

    // A real durable claim on ID_CLAIM through the actual claims store; its
    // lease lapses inside the freshness window before the board read, which
    // is exactly the ASSIGNED (not RUNNING) evidence shape.
    const acquired = mutateBusWorkClaim({
      action: 'acquire', id: ID_CLAIM, owner: OWNER, leaseMs: 60_000, root: fleetRoot,
    });
    expect(acquired.status).toBe('acquired');
    now = T0 + 120_000;

    const blocked = await workResult(ID_BLOCKED, 'fake-reply-338-blocked', ['--blocked', DEPENDENCY]);
    expect(blocked.code).toBe(0);
    expect(blocked.result.outcome).toBe('posted');
    const verified = await workResult(ID_VERIFIED, 'fake-reply-338-verified', ['--tests', TESTS]);
    expect(verified.code).toBe(0);
    expect(verified.result.outcome).toBe('posted');

    const inboxFile = join(fleetRoot, 'bus-inbox', 'messages.json');
    const claimsFile = join(fleetRoot, 'bus-work-claims', 'claims.json');
    const inboxBefore = readFileSync(inboxFile);
    const claimsBefore = readFileSync(claimsFile);
    const inspection = inspectBusWorkClaims(fleetRoot);
    expect(inspection.source).toBe('available');
    expect(inspection.claims).toHaveLength(1);
    const claim = inspection.claims.find(c => c.id === ID_CLAIM)!;
    expect(claim.owner).toBe(OWNER);

    const r = await call(api);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body.asOf).toBe(new Date(T_BOARD).toISOString());
    expect(r.body.inbox).toBe('ok');
    expect(r.body.claims).toBe('available');
    expect(r.body.items.map((i: { id: string }) => i.id).sort())
      .toEqual([ID_BLOCKED, ID_CLAIM, ID_RECV, ID_VERIFIED].sort());
    // Message bodies never leave the board: the per-request canary stays
    // out. Reply envelope ids do appear, but only as the `source` citation
    // of the verified/blocked evidence, never as body text.
    expect(r.text).not.toContain('CANARY-338');

    const recv = itemById(r.body, ID_RECV)!;
    expect(recv).toMatchObject({
      channel: 'slack', channelRef: TS_A, state: 'RECEIVED',
      owner: null, claimReceipt: null,
    });
    expect(recv['missing']).toEqual(expect.arrayContaining(['named owner', 'durable claim receipt']));
    expect(recv['result']).toBeUndefined();

    const claimed = itemById(r.body, ID_CLAIM)!;
    expect(claimed).toMatchObject({
      channel: 'slack', channelRef: TS_B, state: 'ASSIGNED',
      owner: OWNER,
      claimReceipt: `bus-claim:${ID_CLAIM}:${claim.cursor}:${claim.receivedAt}`,
    });
    expect(claimed['missing']).toEqual([]);

    const blockedItem = itemById(r.body, ID_BLOCKED)!;
    expect(blockedItem).toMatchObject({ channelRef: TS_A, state: 'BLOCKED', owner: null, claimReceipt: null });
    expect(blockedItem['result']).toEqual({ kind: 'blocked', dependency: DEPENDENCY });

    const verifiedItem = itemById(r.body, ID_VERIFIED)!;
    expect(verifiedItem).toMatchObject({ channelRef: TS_B, state: 'VERIFIED' });
    expect(verifiedItem['result']).toEqual({
      kind: 'verified', pr: null, head: null, tests: TESTS, artifact: null,
    });

    // Thread query isolation: each channel_ref returns only its own requests.
    const onA = await call(api, `${PATH}?thread=${encodeURIComponent(TS_A)}`);
    expect(onA.status).toBe(200);
    expect(onA.body.asOf).toBe(new Date(T_BOARD).toISOString());
    expect(onA.body.items.map((i: { id: string }) => i.id).sort()).toEqual([ID_BLOCKED, ID_RECV].sort());
    for (const i of onA.body.items as { channelRef: string }[]) expect(i.channelRef).toBe(TS_A);
    const onB = await call(api, `${PATH}?thread=${encodeURIComponent(TS_B)}`);
    expect(onB.body.items.map((i: { id: string }) => i.id).sort()).toEqual([ID_CLAIM, ID_VERIFIED].sort());
    for (const i of onB.body.items as { channelRef: string }[]) expect(i.channelRef).toBe(TS_B);
    expect(onA.text).not.toContain(ID_CLAIM);
    expect(onA.text).not.toContain(ID_VERIFIED);
    expect(onB.text).not.toContain(ID_RECV);
    expect(onB.text).not.toContain(ID_BLOCKED);

    // Reads are read-only: the claim ledger and inbox bytes are unchanged.
    expect(readFileSync(inboxFile)).toEqual(inboxBefore);
    expect(readFileSync(claimsFile)).toEqual(claimsBefore);
  });

  it('reports an unreadable store as unavailable, never a successful empty board', async () => {
    const brokenHome = mkdtempSync(join(tmpdir(), 'board-http-338-broken-'));
    try {
      const brokenFleet = join(brokenHome, 'fleet');
      mkdirSync(join(brokenFleet, 'bus-inbox'), { recursive: true, mode: 0o700 });
      writeFileSync(join(brokenFleet, 'bus-inbox', 'messages.json'), '{corrupt', { mode: 0o600 });
      process.env['ASHLR_HOME'] = brokenHome;
      const r = await call(api);
      expect(r.status).toBe(200);
      expect(r.body.asOf).toBe(new Date(T_BOARD).toISOString());
      expect(r.body.items).toEqual([]);
      expect(r.body.inbox).toBe('unavailable');
      expect(r.body.claims).toBe('missing');
    } finally {
      process.env['ASHLR_HOME'] = home;
      rmSync(brokenHome, { recursive: true, force: true });
    }
  });
});
