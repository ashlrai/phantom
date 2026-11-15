/** RQ-PHX-RESULTROOTISOLATION348S — the supported cloud-agent return
 * route across two independent fleet stores: `fleet work-result` must
 * land on the root its explicit `--root` flag names even when the
 * programmatic/default options point at a different store, so a
 * same-named request on another host can never contaminate the result.
 * Two real temporary durable bus roots carry the SAME fake request id
 * with distinct Slack channel_ref threads and bodies. A blocked result
 * posted with `--root` A while options root is B changes only A — B's
 * snapshot bytes stay identical — and fresh readers prove A reports the
 * original source-bound BLOCKED receipt while B stays RECEIVED. The
 * exact retry on A is a bus 'duplicate' with unchanged durable bytes;
 * the same reply id with distinct valid evidence on B is an independent
 * 'posted' VERIFIED receipt that contaminates neither root. A third
 * empty root reports request-not-found and writes nothing. Receipts
 * are evidence only: no owner, claim or completion is manufactured.
 * Deterministic clock, captured output only, no network. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { inspectBusWorkClaims } from '../src/core/fleet/bus-work-claims.js';

const ID = 'RQ-PHX-FAKE-348';
const REPLY = 'fake-reply-348-shared';
const TS_A = 'T0FAKEDT/C0FAKEDT/1700000000.000348a';
const TS_B = 'T0FAKEDT/C0FAKEDT/1700000000.000348b';
const DEP = 'fake-dep-348-owner-signoff';
const TESTS = 'fake suite green 348';
const TTL = 10_000_000;

const request = (channelRef: string, note: string): BusEnvelope => ({
  id: ID, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  channel: 'slack', channel_ref: channelRef,
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'work', note },
});

let now: number;
const inboxFile = (root: string) => join(root, 'bus-inbox', 'messages.json');
const snapshot = (root: string) => readFileSync(inboxFile(root), 'utf8');
const inboxIds = (root: string) => {
  const page = listBusInboxAfter(0, 100, { root, now: () => now });
  return page.status === 'ok' ? page.messages.map(m => m.envelope.id) : [];
};
const replyBody = (root: string) => {
  const page = listBusInboxAfter(0, 100, { root, now: () => now });
  return page.status === 'ok' ? page.messages.find(m => m.envelope.id === REPLY)?.envelope.body : undefined;
};

describe('fleet work-result root isolation', { timeout: 60_000 }, () => {
  let rootA: string, rootB: string, rootC: string;

  /** argv --root always names the target store; the injected options root
   * is a decoy, proving flag-over-options precedence through the real
   * parser and postBusReply — nothing is mocked. */
  const workResult = async (target: string, decoy: string, extra: string[]) => {
    const output: string[] = [];
    const code = await cmdFleetWorkResult(
      ['--request-id', ID, '--reply-id', REPLY, ...extra, '--root', target],
      { root: decoy, now: () => now }, { output: text => output.push(text) });
    return { code, result: JSON.parse(output.join('')) as { outcome: string; transport: string | null } };
  };

  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), 'work-result-root-a-348-'));
    rootB = mkdtempSync(join(tmpdir(), 'work-result-root-b-348-'));
    rootC = mkdtempSync(join(tmpdir(), 'work-result-root-c-348-'));
    for (const root of [rootA, rootB, rootC]) chmodSync(root, 0o700);
    now = 1_760_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // Identical request id in both stores, distinct threads and bodies.
    expect(appendBusInbox(request(TS_A, 'fake-note-a'), { root: rootA, now: () => now }).status).toBe('posted');
    expect(appendBusInbox(request(TS_B, 'fake-note-b'), { root: rootB, now: () => now }).status).toBe('posted');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of [rootA, rootB, rootC]) rmSync(root, { recursive: true, force: true });
  });

  it('explicit --root isolates the result; same reply id stays independent per store', async () => {
    const bBefore = snapshot(rootB);
    const aBefore = snapshot(rootA);

    // Blocked result aimed at A by flag while options point at B.
    const posted = await workResult(rootA, rootB, ['--blocked', DEP]);
    expect(posted.code).toBe(0);
    expect(posted.result.outcome).toBe('posted');
    // Only A changed: B's durable bytes are identical, A gained exactly the reply.
    expect(snapshot(rootB)).toBe(bBefore);
    expect(inboxIds(rootA)).toEqual([ID, REPLY]);
    expect(inboxIds(rootB)).toEqual([ID]);
    expect(replyBody(rootA)).toEqual({ blocked: { dependency: DEP }, inReplyTo: ID });

    // Reinstantiate every reader: fresh module instances re-read the
    // durable stores — no cached projection survives the post.
    vi.resetModules();
    const freshInbox = await import('../src/core/fleet/bus-inbox.js');
    const freshBoard = await import('../src/core/comms/work-board.js');
    const freshEvidence = await import('../src/core/comms/work-item-bus-evidence.js');
    const freshClaims = await import('../src/core/fleet/bus-work-claims.js');
    const pageA = freshInbox.listBusInboxAfter(0, 100, { root: rootA, now: () => now });
    expect(pageA.status).toBe('ok');
    const pageB = freshInbox.listBusInboxAfter(0, 100, { root: rootB, now: () => now });
    expect(pageB.status).toBe('ok');
    const boardA = freshBoard.listWorkBoard({ root: rootA, now }).items.find(i => i.id === ID);
    const boardB = freshBoard.listWorkBoard({ root: rootB, now }).items.find(i => i.id === ID);
    expect(boardA).toMatchObject({
      state: 'BLOCKED', channelRef: TS_A, owner: null, claimReceipt: null,
      source: `bus-reply:${REPLY}`,
    });
    expect(boardA!.result).toEqual({ kind: 'blocked', dependency: DEP });
    expect(boardB).toMatchObject({
      state: 'RECEIVED', channelRef: TS_B, owner: null, claimReceipt: null,
    });
    expect(boardB!.result).toBeUndefined();
    const evidenceA = freshEvidence.collectBusWorkItemEvidence(ID, { root: rootA, now });
    expect(evidenceA.evidence.blocker).toMatchObject({ dependency: DEP, source: `bus-reply:${REPLY}` });
    expect(evidenceA.evidence.owner).toBeUndefined();
    expect(evidenceA.sources.claims).toBe('missing');
    const evidenceB = freshEvidence.collectBusWorkItemEvidence(ID, { root: rootB, now });
    expect(evidenceB.evidence.blocker).toBeUndefined();
    expect(evidenceB.evidence.owner).toBeUndefined();
    expect(freshClaims.inspectBusWorkClaims(rootA).claims).toEqual([]);
    expect(freshClaims.inspectBusWorkClaims(rootB).claims).toEqual([]);

    // Exact retry of the same reply id and body on A: bus 'duplicate',
    // durable bytes untouched — no timestamp or TTL refresh.
    const aAfterPost = snapshot(rootA);
    const retry = await workResult(rootA, rootC, ['--blocked', DEP]);
    expect(retry.code).toBe(0);
    expect(retry.result.outcome).toBe('duplicate');
    expect(snapshot(rootA)).toBe(aAfterPost);
    expect(inboxIds(rootA)).toEqual([ID, REPLY]);
    expect(snapshot(rootB)).toBe(bBefore);

    // Same reply id, distinct valid evidence, aimed at B by flag while
    // options point at A: B has no prior row under that id, so it posts
    // as an independent VERIFIED receipt. A stays byte-identical.
    const postedB = await workResult(rootB, rootA, ['--tests', TESTS]);
    expect(postedB.code).toBe(0);
    expect(postedB.result.outcome).toBe('posted');
    expect(snapshot(rootA)).toBe(aAfterPost);
    expect(inboxIds(rootB)).toEqual([ID, REPLY]);
    expect(replyBody(rootB)).toEqual({ verified: { tests: TESTS }, inReplyTo: ID });
    // The two stores now hold different bodies under the same reply id.
    expect(replyBody(rootA)).toEqual({ blocked: { dependency: DEP }, inReplyTo: ID });

    // Fresh readers again: each root reports only its own source-bound
    // result — A BLOCKED on DEP, B VERIFIED on the tests evidence.
    const boardA2 = listWorkBoard({ root: rootA, now }).items.find(i => i.id === ID);
    const boardB2 = listWorkBoard({ root: rootB, now }).items.find(i => i.id === ID);
    expect(boardA2).toMatchObject({ state: 'BLOCKED', owner: null, claimReceipt: null });
    expect(boardA2!.result).toEqual({ kind: 'blocked', dependency: DEP });
    expect(boardB2).toMatchObject({ state: 'VERIFIED', owner: null, claimReceipt: null });
    expect(boardB2!.result).toEqual({ kind: 'verified', pr: null, head: null, tests: TESTS, artifact: null });
    expect(collectBusWorkItemEvidence(ID, { root: rootA, now }).evidence.blocker)
      .toMatchObject({ dependency: DEP, source: `bus-reply:${REPLY}` });
    expect(collectBusWorkItemEvidence(ID, { root: rootB, now }).evidence.verified)
      .toMatchObject({ tests: TESTS, source: `bus-reply:${REPLY}` });

    // Third empty root: the request id does not exist there, so the post
    // is refused as request-not-found and nothing is written anywhere.
    const aFinal = snapshot(rootA);
    const bFinal = snapshot(rootB);
    const missing = await workResult(rootC, rootB, ['--blocked', DEP]);
    expect(missing.code).toBe(3);
    expect(missing.result.outcome).toBe('request-not-found');
    expect(existsSync(inboxFile(rootC))).toBe(false);
    expect(inboxIds(rootC)).toEqual([]);
    expect(snapshot(rootA)).toBe(aFinal);
    expect(snapshot(rootB)).toBe(bFinal);

    // Evidence is not authority: across both stores the receipts
    // manufactured no owner, no claim row and no completed claim; the
    // claims table stays empty and neither board item was ever assigned.
    for (const root of [rootA, rootB]) {
      expect(inspectBusWorkClaims(root).claims).toEqual([]);
      const item = listWorkBoard({ root, now }).items.find(i => i.id === ID);
      expect(item).toMatchObject({ owner: null, claimReceipt: null });
    }
    expect(aBefore).not.toBe(snapshot(rootA));
  });
});
