/** RQ-PHX-RESULTCLAIMATTRIBUTION346S — truthful claim attribution across the
 * work-result return path (Nov13 13:13 fresh shared claims and supported
 * cloud-agent return; Nov12 22:29 honest assignment reporting). A bus
 * request whose `to` is only a lane label is claimed through the real
 * durable claims store by a differently named fake agent; `fleet
 * work-result` then returns blocked and verified receipts through the real
 * CLI entry point. The work board and collectBusWorkItemEvidence must keep
 * owner/claimReceipt bound to that claim's exact receipt coordinates — the
 * request's routing recipient and the reply's sender labels are routing
 * data only and never substitute for the durable named owner. Retrying the
 * same explicit result id dedupes without renewing the lease, rewriting
 * ownership or completing the claim; past the lease the retained result
 * evidence still classifies while no fresh running evidence is invented;
 * and a separate unclaimed request keeps null owner/claimReceipt. Real
 * temporary inbox and claims stores with a fixed injected clock, plainly
 * fake labels, no fencing token printed; receipts stay evidence, never
 * authority. */
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter, type BusEnvelope, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard, type WorkBoardItem } from '../src/core/comms/work-board.js';
import { RUNNING_FRESH_MS } from '../src/core/comms/work-item-state.js';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';

const T0 = Date.parse('2026-11-13T18:13:00.000Z');
const TTL = 10_000_000;
const LEASE_MS = 120_000;
const ID = 'RQ-PHX-FAKE-346S-CLAIMED';
const ID_B = 'RQ-PHX-FAKE-346S-UNCLAIMED';
const LANE = 'fake-lane-346s';
const REQUESTER = 'fake-cloud-agent-346s';
const OWNER = 'fake-agent-346s';
const REPLY_BLOCKED = 'fake-reply-346s-blocked';
const REPLY_VERIFIED = 'fake-reply-346s-verified';
const REPLY_B = 'fake-reply-346s-b-tests';
const DEP = 'fake-dep-346s-review';
const ARTIFACT = 'fake-artifact-346s.txt';
const TESTS_B = 'fake-346s-suite-green';

let root: string, now: number;
const iso = (ms: number) => new Date(ms).toISOString();
const claimsFile = () => join(root, 'bus-work-claims', 'claims.json');
const inboxFile = () => join(root, 'bus-inbox', 'messages.json');

const request = (id: string): BusEnvelope => ({
  id, from: REQUESTER, to: LANE, priority: 'P1', ttl: TTL, body: { kind: 'work' },
});
const postRequest = (id: string) => {
  expect(appendBusInbox(request(id), { root, now: () => now }).status).toBe('posted');
};
const receiptOf = (id: string): BusInboxReceipt => {
  const page = listBusInboxAfter(0, 100, { root, now: () => now });
  if (page.status !== 'ok') throw new Error('bus inbox unavailable');
  const row = page.messages.find(m => m.envelope.id === id);
  if (!row) throw new Error(`receipt missing: ${id}`);
  return row;
};
const workResult = async (requestId: string, replyId: string, extra: string[]) => {
  const output: string[] = [];
  const code = await cmdFleetWorkResult(
    ['--request-id', requestId, '--reply-id', replyId, '--root', root, ...extra],
    { now: () => now }, { output: text => output.push(text) });
  return { code, result: JSON.parse(output.join('')) as { outcome: string; transport: string | null } };
};
const boardItem = (id: string): WorkBoardItem => {
  const board = listWorkBoard({ root, now });
  expect(board.inbox).toBe('ok');
  const item = board.items.find(i => i.id === id);
  if (!item) throw new Error(`board item missing: ${id}`);
  return item;
};
const evidence = (id: string) => collectBusWorkItemEvidence(id, { root, now }).evidence;
const claimView = () => {
  const inspection = inspectBusWorkClaims(root);
  expect(inspection.source).toBe('available');
  return inspection.claims;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-result-claim-attribution-346s-'));
  chmodSync(root, 0o700);
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('work-result claim attribution', { timeout: 60_000 }, () => {
  it('binds owner and claimReceipt to the durable claim across result returns, dedupe and lease expiry', async () => {
    // Routing labels only: the request is addressed to a lane, never an agent.
    postRequest(ID);
    postRequest(ID_B);
    const coordinates = receiptOf(ID);
    const claimReceipt = `bus-claim:${ID}:${coordinates.cursor}:${coordinates.receivedAt}`;
    expect(coordinates.receivedAt).toBe(T0);

    // The real durable claim belongs to a differently named fake agent.
    const acquired = mutateBusWorkClaim({ action: 'acquire', id: ID, owner: OWNER, leaseMs: LEASE_MS, root });
    expect(acquired.status).toBe('acquired');
    const claims = claimView();
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim).toMatchObject({ id: ID, owner: OWNER, completedAt: null });
    expect(claim.cursor).toBe(coordinates.cursor);
    expect(claim.receivedAt).toBe(coordinates.receivedAt);
    const leaseUntil = claim.leaseUntil;
    expect(leaseUntil).toBe(T0 + LEASE_MS);
    expect(OWNER).not.toBe(LANE);
    expect(OWNER).not.toBe(REQUESTER);

    // Live lease, no result yet: RUNNING under the claim owner — the lane
    // label and requester label never appear as owner anywhere.
    expect(boardItem(ID)).toMatchObject({ state: 'RUNNING', owner: OWNER, claimReceipt });
    const running = evidence(ID);
    expect(running.owner).toBe(OWNER);
    expect(running.claimReceipt).toBe(claimReceipt);
    expect(running.runningEvidence).toEqual({
      source: `bus-work-claims lease-until ${iso(leaseUntil)}`, at: iso(now),
    });

    // A blocked result return through the real work-result entry point.
    now += 30_000;
    const blocked = await workResult(ID, REPLY_BLOCKED, ['--blocked', DEP]);
    expect(blocked.code).toBe(0);
    expect(blocked.result).toMatchObject({ outcome: 'posted' });

    // The reply envelope carries only routing labels: from the lane the
    // request was addressed to, back to the requester — never the owner.
    const blockedReply = receiptOf(REPLY_BLOCKED);
    expect(blockedReply.envelope.from).toBe(LANE);
    expect(blockedReply.envelope.to).toBe(REQUESTER);
    expect(blockedReply.envelope.body).toMatchObject({ inReplyTo: ID, blocked: { dependency: DEP } });

    const blockedItem = boardItem(ID);
    expect(blockedItem).toMatchObject({
      state: 'BLOCKED', owner: OWNER, claimReceipt,
      result: { kind: 'blocked', dependency: DEP },
    });
    expect(blockedItem.source).toBe(`bus-reply:${REPLY_BLOCKED}`);
    const blockedEvidence = evidence(ID);
    expect(blockedEvidence).toMatchObject({ owner: OWNER, claimReceipt });
    expect(blockedEvidence.blocker).toMatchObject({
      dependency: DEP, source: `bus-reply:${REPLY_BLOCKED}`,
    });
    expect(blockedEvidence.verified).toBeUndefined();

    // Replaying the same explicit result id is a dedupe: the durable claims
    // store is byte-identical — no lease renewal, no ownership or completion
    // change — and the reply receipt is not refreshed.
    const claimsBeforeBlocked = readFileSync(claimsFile(), 'utf8');
    const inboxBeforeBlocked = readFileSync(inboxFile(), 'utf8');
    now += 1_000;
    const blockedRetry = await workResult(ID, REPLY_BLOCKED, ['--blocked', DEP]);
    expect(blockedRetry.code).toBe(0);
    expect(blockedRetry.result).toMatchObject({ outcome: 'duplicate' });
    expect(readFileSync(claimsFile(), 'utf8')).toBe(claimsBeforeBlocked);
    expect(readFileSync(inboxFile(), 'utf8')).toBe(inboxBeforeBlocked);
    expect(claimView()).toEqual(claims);

    // The verified return supersedes blocked on the board while the blocked
    // reply stays retained as evidence; owner/claimReceipt still bind to the
    // same claim coordinates.
    now += 30_000;
    const verified = await workResult(ID, REPLY_VERIFIED, ['--artifact', ARTIFACT]);
    expect(verified.code).toBe(0);
    expect(verified.result).toMatchObject({ outcome: 'posted' });
    const verifiedReply = receiptOf(REPLY_VERIFIED);
    expect(verifiedReply.envelope.from).toBe(LANE);
    expect(verifiedReply.envelope.to).toBe(REQUESTER);
    expect(verifiedReply.envelope.body).toMatchObject({ inReplyTo: ID, verified: { artifact: ARTIFACT } });

    const item = boardItem(ID);
    expect(item).toMatchObject({
      state: 'VERIFIED', owner: OWNER, claimReceipt,
      result: { kind: 'verified', pr: null, head: null, tests: null, artifact: ARTIFACT },
    });
    expect(item.source).toBe(`bus-reply:${REPLY_VERIFIED}`);
    const verifiedEvidence = evidence(ID);
    expect(verifiedEvidence).toMatchObject({ owner: OWNER, claimReceipt });
    expect(verifiedEvidence.verified).toMatchObject({
      artifact: ARTIFACT, source: `bus-reply:${REPLY_VERIFIED}`,
    });
    expect(verifiedEvidence.blocker).toMatchObject({
      dependency: DEP, source: `bus-reply:${REPLY_BLOCKED}`,
    });

    // The same dedupe guarantee on the verified result id: byte-identical
    // claims and inbox stores, unchanged owner/lease/completion view.
    const claimsBeforeVerified = readFileSync(claimsFile(), 'utf8');
    const inboxBeforeVerified = readFileSync(inboxFile(), 'utf8');
    now += 1_000;
    const verifiedRetry = await workResult(ID, REPLY_VERIFIED, ['--artifact', ARTIFACT]);
    expect(verifiedRetry.code).toBe(0);
    expect(verifiedRetry.result).toMatchObject({ outcome: 'duplicate' });
    expect(readFileSync(claimsFile(), 'utf8')).toBe(claimsBeforeVerified);
    expect(readFileSync(inboxFile(), 'utf8')).toBe(inboxBeforeVerified);
    expect(claimView()).toEqual(claims);

    // A separate unclaimed request returns a result too: the evidence cites
    // the actual posted reply, but owner and claimReceipt stay null — a
    // result receipt never invents ownership.
    now += 30_000;
    const replyB = await workResult(ID_B, REPLY_B, ['--tests', TESTS_B]);
    expect(replyB.code).toBe(0);
    expect(replyB.result).toMatchObject({ outcome: 'posted' });
    expect(boardItem(ID_B)).toMatchObject({
      state: 'VERIFIED', owner: null, claimReceipt: null,
      result: { kind: 'verified', pr: null, head: null, tests: TESTS_B, artifact: null },
    });
    const evidenceB = evidence(ID_B);
    expect(evidenceB.owner).toBeUndefined();
    expect(evidenceB.claimReceipt).toBeUndefined();
    expect(evidenceB.verified).toMatchObject({ tests: TESTS_B, source: `bus-reply:${REPLY_B}` });

    // Just past the lease (inside the freshness window) the verified result
    // is still retained and classified, but no running evidence exists —
    // nothing invents a live worker.
    now = leaseUntil + 1;
    const lapsed = evidence(ID);
    expect(lapsed).toMatchObject({ owner: OWNER, claimReceipt });
    expect(lapsed.verified).toMatchObject({ artifact: ARTIFACT, source: `bus-reply:${REPLY_VERIFIED}` });
    expect(lapsed.runningEvidence).toBeUndefined();
    expect(boardItem(ID)).toMatchObject({ state: 'VERIFIED', owner: OWNER, claimReceipt });

    // Well past the freshness window the stale lease citation is retained —
    // it names the ORIGINAL lease end, never a renewed or fresh timestamp.
    now = leaseUntil + RUNNING_FRESH_MS + 1;
    const stale = evidence(ID);
    expect(stale.runningEvidence).toEqual({
      source: `bus-work-claims lease-until ${iso(leaseUntil)}`,
      at: iso(leaseUntil),
    });
    expect(stale.runningEvidence!.at).not.toBe(iso(now));
    expect(stale).toMatchObject({ owner: OWNER, claimReceipt });
    expect(stale.verified).toMatchObject({ artifact: ARTIFACT });
    expect(boardItem(ID)).toMatchObject({ state: 'VERIFIED', owner: OWNER, claimReceipt });

    // The claims table itself was never touched by any result return: still
    // exactly one row, same owner, same lease end, never completed.
    const finalClaims = claimView();
    expect(finalClaims).toHaveLength(1);
    expect(finalClaims[0]).toEqual(claim);

    // The unclaimed comparison holds at the same late clock: null ownership.
    expect(boardItem(ID_B)).toMatchObject({ state: 'VERIFIED', owner: null, claimReceipt: null });
    expect(evidence(ID_B).owner).toBeUndefined();

    // No fencing token or other 64-hex secret ever leaves the evidence
    // surface, at any point in the trace.
    const surfaced = JSON.stringify({
      items: listWorkBoard({ root, now }).items,
      claimed: evidence(ID), unclaimed: evidence(ID_B),
    });
    expect(surfaced).not.toMatch(/[a-f0-9]{64}/);
  });
});
