/** RQ-PHX-CLAIMNOTICEDURABLERESTART483S — proactive claim-owner notices must
 * survive a REAL file-backed restart, not just in-memory fakes. Every pass
 * below rebuilds all file-backed deps (fresh `claimNoticeFileDeps`, fresh
 * `readFleetBoard` closure), so only the durable files carry state between
 * passes: that IS the restart. The board is the real `readFleetBoard` over a
 * private coordination ledger written by the real claim / handoff / return /
 * release APIs, and bindings are appended by the real
 * `appendClaimThreadBinding`. Only final delivery (a synthetic receipt) and
 * the clock are stubbed. Where the in-memory suites substitute snapshot/sent
 * readers, this file asserts the persisted bytes and the exact thread/dedupe
 * identity, so a restarted pass can only under-post — never repeat an
 * assignment, lose a verified return, or manufacture a release out of an
 * unreadable board. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps,
} from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import type { ClaimThreadBinding } from '../src/core/fleet/claim-thread-notice.js';
import {
  claimFleetWork, handoffFleetClaim, postFleetMessage, readFleetBoard, releaseFleetClaim,
  type FleetCoordinationOptions, type FleetCoordinationResult,
} from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const T0 = Date.parse('2026-11-16T00:00:00.000Z');
const STEP_MS = 5_000;
const THREAD_A = 'T000FAKE/C000FAKE/1700000000.000001';
const THREAD_B = 'T000FAKE/C000FAKE/1700000000.000002';
const REPO_A = 'fake/durable';
const REPO_B = 'other/durable';
const HEAD_A = 'abcdef1234567';
const HEAD_B = '1234567abcdef';
const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claim-notice-restart-483s-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const ledgerPath = join(dir, 'coordination.jsonl');
  const runsRoot = join(dir, 'runs');
  const paths = claimNoticePaths(runsRoot);
  let now = T0;
  const sends: { threadKey: string; text: string; dedupeKey: string }[] = [];
  const send: ClaimNoticeSendDeps['send'] = (threadKey, text, dedupeKey) => {
    sends.push({ threadKey, text, dedupeKey });
    return { ok: true, receipt: `fake-receipt-${sends.length}` };
  };
  // Fresh deps per pass: the board read, prior snapshot, bindings and sent
  // ledger are all re-read from disk — nothing survives in memory except the
  // send capture and the fake clock.
  const deps = (): ClaimNoticeSendDeps => ({
    readBoard: () => readFleetBoard({ path: ledgerPath, now }),
    ...claimNoticeFileDeps(runsRoot),
    send, now: () => now,
  });
  const tick = () => { now += STEP_MS; return now; };
  const options = (): FleetCoordinationOptions => ({ path: ledgerPath, now: tick() });
  const pass = async () => {
    const at = tick();
    const result = await runClaimNoticePass(deps());
    return { ...result, at };
  };
  const bind = (binding: ClaimThreadBinding) => {
    const bound = appendClaimThreadBinding(paths.bindings, binding, now);
    if (!bound.ok) throw new Error(`binding write failed: ${bound.reason}`);
  };
  const sentRows = () => readFileSync(paths.sent, 'utf8').split('\n')
    .filter(line => line.trim()).map(line => JSON.parse(line) as { v: number; at: number; key: string });
  const prevFile = () => JSON.parse(readFileSync(paths.prev, 'utf8')) as Record<string, unknown>;
  return { ledgerPath, paths, sends, options, pass, bind, sentRows, prevFile };
}

describe('claim notice durable owner restart (RQ-PHX-CLAIMNOTICEDURABLERESTART483S)', () => {
  it('assignment, handoff and verified return post exactly once across file-backed restarts', async () => {
    const f = fixture();

    // A missing board manufactures nothing and advances nothing trusted:
    // readFleetBoard reports 'unknown' for an absent ledger, so the pass
    // refuses before the snapshot or ledger are even consulted.
    const missing = await f.pass();
    expect(missing).toMatchObject({ status: 'board-unavailable', planned: 0, sent: 0 });
    expect(f.sends).toHaveLength(0);
    expect(existsSync(f.paths.prev)).toBe(false);
    expect(existsSync(f.paths.sent)).toBe(false);

    // A real (expired) ledger event makes the board read 'known'-empty; the
    // first trusted pass baselines silently.
    must(postFleetMessage(
      { from: 'setup', to: 'all', body: 'fake seed marker', ttlMs: 1 }, f.options()));
    const first = await f.pass();
    expect(first).toMatchObject({ status: 'completed', baselined: true, planned: 0, sent: 0 });
    expect(existsSync(f.paths.prev)).toBe(true);
    expect(existsSync(f.paths.sent)).toBe(false);
    const baselinePrev = readFileSync(f.paths.prev);

    // Two real claims in two repositories, each bound to its own source thread
    // through the real binding writer.
    const claimA = must(claimFleetWork(
      { repo: REPO_A, task: 'fake durable task A', agent: 'agent-a' }, f.options()));
    const claimB = must(claimFleetWork(
      { repo: REPO_B, task: 'fake durable task B', agent: 'agent-c' }, f.options()));
    f.bind({ claimId: claimA.claim.id, repo: REPO_A, threadKey: THREAD_A, pr: 7, head: HEAD_A });
    f.bind({ claimId: claimB.claim.id, repo: REPO_B, threadKey: THREAD_B, pr: 9, head: HEAD_B });
    const keyAssignA = JSON.stringify(['ASSIGNED', claimA.claim.id, HEAD_A]);
    const keyAssignB = JSON.stringify(['ASSIGNED', claimB.claim.id, HEAD_B]);

    const assigned = await f.pass();
    expect(assigned).toMatchObject({ status: 'completed', planned: 2, sent: 2, failed: 0 });
    expect(f.sends).toHaveLength(2);
    expect(f.sends.find(s => s.threadKey === THREAD_A)).toMatchObject({ dedupeKey: keyAssignA });
    expect(f.sends.find(s => s.threadKey === THREAD_B)).toMatchObject({ dedupeKey: keyAssignB });
    expect(f.sends.every(s => s.text.includes('ASSIGNED'))).toBe(true);
    // Persisted bytes: the sent ledger holds exactly those keys stamped with
    // the pass clock, and the snapshot holds the real claims.
    expect(f.sentRows()).toEqual([
      { v: 1, at: assigned.at, key: keyAssignA },
      { v: 1, at: assigned.at, key: keyAssignB },
    ]);
    expect(f.prevFile()).toMatchObject({ v: 1, state: 'known', asOf: assigned.at });
    expect(f.prevFile().claims).toEqual([claimA.claim, claimB.claim]);

    // Restart with the snapshot write lost: the same transition replans but
    // the on-disk ledger fences it — a restart can only under-post, never
    // repeat the assignment.
    writeFileSync(f.paths.prev, baselinePrev, { mode: 0o600 });
    const replayed = await f.pass();
    expect(replayed).toMatchObject({ status: 'completed', planned: 2, sent: 0, skipped: 2 });
    expect(replayed.deliveries.every(d => d.result === 'ledgered')).toBe(true);
    expect(f.sends).toHaveLength(2);
    expect(f.prevFile()).toMatchObject({ state: 'known', asOf: replayed.at });

    // Reconstructed deps, unchanged board: plans nothing, sends nothing.
    const quiet = await f.pass();
    expect(quiet).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(f.sends).toHaveLength(2);

    // A legitimate handoff emits exactly one new owner acquisition on the same
    // thread; the unrelated claim's thread hears nothing.
    const handoff = must(handoffFleetClaim(
      { id: claimA.claim.id, agent: 'agent-a', lease: claimA.lease, to: 'agent-b' }, f.options()));
    const keyHandoff = JSON.stringify(
      ['ASSIGNED', REPO_A, claimA.claim.id, 'agent-b', handoff.claim.claimedAt, HEAD_A]);
    const handed = await f.pass();
    expect(handed).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(f.sends).toHaveLength(3);
    expect(f.sends.at(-1)).toMatchObject({ threadKey: THREAD_A, dedupeKey: keyHandoff });
    expect(f.sends.at(-1)!.text).toContain('agent-b');
    expect(f.sends.filter(s => s.threadKey === THREAD_B)).toHaveLength(1);
    expect(f.sentRows().map(row => row.key)).toEqual([keyAssignA, keyAssignB, keyHandoff]);

    // A real supported result receipt with the bound PR/head emits VERIFIED
    // once on the same thread.
    const returned = returnFleetClaim(
      { id: claimA.claim.id, agent: 'agent-b', lease: handoff.lease, pr: 7, head: HEAD_A },
      f.options());
    expect(returned).toMatchObject({ ok: true, outcome: 'returned' });
    const prevBeforeVerified = readFileSync(f.paths.prev);
    const keyVerified = JSON.stringify(['VERIFIED', claimA.claim.id, HEAD_A]);
    const verified = await f.pass();
    expect(verified).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(f.sends).toHaveLength(4);
    expect(f.sends.at(-1)).toMatchObject({ threadKey: THREAD_A, dedupeKey: keyVerified });
    expect(f.sends.at(-1)!.text).toContain('VERIFIED');
    expect(f.sends.at(-1)!.text).toContain(HEAD_A.slice(0, 7));
    expect(f.sends.filter(s => s.threadKey === THREAD_B)).toHaveLength(1);

    // Restart that lost the snapshot still cannot double-post the receipt:
    // the verified return is fenced by the ledger, never lost.
    writeFileSync(f.paths.prev, prevBeforeVerified, { mode: 0o600 });
    const verifiedReplay = await f.pass();
    expect(verifiedReplay).toMatchObject({ status: 'completed', planned: 1, sent: 0, skipped: 1 });
    expect(verifiedReplay.deliveries[0]).toMatchObject({ result: 'ledgered', dedupeKey: keyVerified });
    expect(f.sends).toHaveLength(4);
    expect(f.sentRows().map(row => row.key))
      .toEqual([keyAssignA, keyAssignB, keyHandoff, keyVerified]);

    // The unrelated claim's real release routes to its own thread only.
    must(releaseFleetClaim(
      { id: claimB.claim.id, agent: 'agent-c', lease: claimB.lease }, f.options()));
    const keyReleaseB = JSON.stringify(
      ['RELEASED', REPO_B, claimB.claim.id, 'agent-c', claimB.claim.claimedAt, HEAD_B]);
    const released = await f.pass();
    expect(released).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(f.sends.at(-1)).toMatchObject({ threadKey: THREAD_B, dedupeKey: keyReleaseB });
    expect(f.sends.at(-1)!.text).toContain('RELEASED');
    expect(f.sends.filter(s => s.threadKey === THREAD_A)).toHaveLength(3);

    // Steady state after reconstruction: nothing further is planned or sent.
    const steady = await f.pass();
    expect(steady).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(f.sends).toHaveLength(5);

    // An unreadable board manufactures nothing — no RELEASED, no VERIFIED —
    // and does not advance the trusted snapshot or touch the sent ledger.
    const prevBytes = readFileSync(f.paths.prev);
    const sentBytes = readFileSync(f.paths.sent);
    writeFileSync(f.ledgerPath, 'not a real ledger\n', { mode: 0o600 });
    const unavailable = await f.pass();
    expect(unavailable).toMatchObject({ status: 'board-unavailable', planned: 0, sent: 0 });
    expect(f.sends).toHaveLength(5);
    expect(readFileSync(f.paths.prev)).toEqual(prevBytes);
    expect(readFileSync(f.paths.sent)).toEqual(sentBytes);
  });

  it('a restart with no surviving notice state baselines instead of flooding, then emits the next real change once', async () => {
    const f = fixture();
    const claim = must(claimFleetWork(
      { repo: REPO_A, task: 'fake durable task', agent: 'agent-a' }, f.options()));
    f.bind({ claimId: claim.claim.id, repo: REPO_A, threadKey: THREAD_A, pr: 7, head: HEAD_A });
    // Live and bound but never observed by a prior pass: the restart
    // baselines rather than posting a late ASSIGNED into the thread.
    const first = await f.pass();
    expect(first).toMatchObject({ status: 'completed', baselined: true, planned: 0, sent: 0 });
    expect(f.sends).toHaveLength(0);
    expect(f.prevFile()).toMatchObject({ state: 'known', asOf: first.at });
    expect(f.prevFile().claims).toEqual([claim.claim]);
    // The next real owner change still posts exactly once.
    const handoff = must(handoffFleetClaim(
      { id: claim.claim.id, agent: 'agent-a', lease: claim.lease, to: 'agent-b' }, f.options()));
    const key = JSON.stringify(
      ['ASSIGNED', REPO_A, claim.claim.id, 'agent-b', handoff.claim.claimedAt, HEAD_A]);
    const second = await f.pass();
    expect(second).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(f.sends).toHaveLength(1);
    expect(f.sends.at(-1)).toMatchObject({ threadKey: THREAD_A, dedupeKey: key });
    expect(f.sends.at(-1)!.text).toContain('ASSIGNED');
    expect(f.sentRows().map(row => row.key)).toEqual([key]);
  });

  it('a corrupt snapshot halts until removed: baseline, then real transitions emit once', async () => {
    const f = fixture();
    const claim = must(claimFleetWork(
      { repo: REPO_A, task: 'fake durable task', agent: 'agent-a' }, f.options()));
    f.bind({ claimId: claim.claim.id, repo: REPO_A, threadKey: THREAD_A, pr: 7, head: HEAD_A });
    const baseline = await f.pass();
    expect(baseline).toMatchObject({ status: 'completed', baselined: true, sent: 0 });
    // Damage the snapshot between restarts: it must not replay history or
    // overwrite the unavailable state before an explicit repair.
    writeFileSync(f.paths.prev, '{"v":1,"state":"known","claims":[{torn', { mode: 0o600 });
    const corruptBytes = readFileSync(f.paths.prev);
    const unavailable = await f.pass();
    expect(unavailable).toMatchObject({ status: 'prev-unavailable', reason: 'prev-snapshot-unreadable', baselined: false, planned: 0, sent: 0 });
    expect(f.sends).toHaveLength(0);
    expect(readFileSync(f.paths.prev)).toEqual(corruptBytes);
    expect(existsSync(f.paths.sent)).toBe(false);
    rmSync(f.paths.prev);
    const recovered = await f.pass();
    expect(recovered).toMatchObject({ status: 'completed', baselined: true, planned: 0, sent: 0 });
    expect(f.sends).toHaveLength(0);
    expect(f.prevFile()).toMatchObject({ state: 'known', asOf: recovered.at });
    must(releaseFleetClaim({ id: claim.claim.id, agent: 'agent-a', lease: claim.lease }, f.options()));
    const key = JSON.stringify(
      ['RELEASED', REPO_A, claim.claim.id, 'agent-a', claim.claim.claimedAt, HEAD_A]);
    const released = await f.pass();
    expect(released).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(f.sends).toHaveLength(1);
    expect(f.sends.at(-1)).toMatchObject({ threadKey: THREAD_A, dedupeKey: key });
    expect(f.sentRows().map(row => row.key)).toEqual([key]);
  });
});
