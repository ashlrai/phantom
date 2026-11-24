import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendClaimNoticeSent, readClaimNoticeSent, readClaimThreadBindings, readClaimThreadBindingsState,
  runClaimNoticePass, CLAIM_NOTICE_SENT_MAX_KEYS,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import type { ClaimThreadBinding, ClaimThreadSnapshot } from '../src/core/fleet/claim-thread-notice.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const claim = { id: 'claim-fake-1', repo: 'ashlrai/phantom', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 3_600_000 };
const binding: ClaimThreadBinding = { claimId: claim.id, repo: claim.repo,
  threadKey: 'T000FAKE/C000FAKE/1700000000.000001', pr: 123, head: 'abcdef1234567890' };
const board = (over: Partial<FleetBoard> = {}): FleetBoard =>
  ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0, ...over });
const emptyPrev = (): ClaimThreadSnapshot => ({ state: 'known', claims: [], messages: [], asOf: now - 60_000 });
const assignmentKey = JSON.stringify(['ASSIGNED', claim.repo, claim.id, claim.agent, claim.claimedAt, binding.head]);

function fakeDeps(over: Partial<ClaimNoticeSendDeps> = {}) {
  const sent = new Set<string>();
  const calls = {
    sends: [] as { threadKey: string; text: string; dedupeKey: string }[],
    appends: [] as string[],
    writes: [] as ClaimThreadSnapshot[],
  };
  let prev: ClaimThreadSnapshot | null = emptyPrev();
  const deps: ClaimNoticeSendDeps = {
    readBoard: () => board({ claims: [claim] }),
    readPrevSnapshot: () => prev,
    writePrevSnapshot: snapshot => { calls.writes.push(snapshot); prev = snapshot; },
    readBindings: () => [binding],
    readSentLedger: () => sent,
    appendSentLedger: key => { sent.add(key); calls.appends.push(key); },
    send: (threadKey, text, dedupeKey) => {
      calls.sends.push({ threadKey, text, dedupeKey });
      return { ok: true, receipt: 'fake-receipt' };
    },
    now: () => now,
    ...over,
  };
  return { deps, calls, sent, getPrev: () => prev, setPrev: (s: ClaimThreadSnapshot | null) => { prev = s; } };
}

describe('claim notice send pass', () => {
  it('baselines the first pass instead of replaying history', async () => {
    const { deps, calls, setPrev } = fakeDeps();
    setPrev(null);
    const result = await runClaimNoticePass(deps);
    expect(result).toMatchObject({ status: 'completed', baselined: true, planned: 0, sent: 0 });
    expect(calls.sends).toHaveLength(0);
    expect(calls.writes).toHaveLength(1);
  });

  it('posts ASSIGNED once and stays silent while nothing changes', async () => {
    const { deps, calls } = fakeDeps();
    const first = await runClaimNoticePass(deps);
    expect(first.status).toBe('completed');
    expect(first.sent).toBe(1);
    expect(calls.sends).toHaveLength(1);
    expect(calls.sends[0]).toMatchObject({ threadKey: binding.threadKey,
      dedupeKey: assignmentKey });
    expect(calls.sends[0]!.text).toContain('ASSIGNED');
    expect(calls.sends[0]!.text).toContain(claim.id);
    expect(calls.appends).toEqual([calls.sends[0]!.dedupeKey]);
    const second = await runClaimNoticePass(deps);
    expect(second.planned).toBe(0);
    expect(second.sent).toBe(0);
    expect(calls.sends).toHaveLength(1);
  });

  it('a failed send leaves prev unchanged so the next pass posts it exactly once', async () => {
    const { deps, calls, getPrev } = fakeDeps({ send: () => { throw new Error('transport down'); } });
    const failed = await runClaimNoticePass(deps);
    expect(failed.failed).toBe(1);
    expect(failed.deliveries[0]).toMatchObject({ result: 'failed', reason: 'send-threw' });
    expect(calls.writes).toHaveLength(0);
    expect(getPrev()).toMatchObject({ asOf: now - 60_000 });
    deps.send = (threadKey, text, dedupeKey) => {
      calls.sends.push({ threadKey, text, dedupeKey });
      return { ok: true, receipt: 'fake-receipt' };
    };
    const retried = await runClaimNoticePass(deps);
    expect(retried.sent).toBe(1);
    expect(getPrev()!.asOf).toBe(now);
    const quiet = await runClaimNoticePass(deps);
    expect(quiet.planned).toBe(0);
    expect(calls.sends).toHaveLength(1);
    expect(calls.appends).toHaveLength(1);
  });

  it('the ledger fences a replanned notice when the snapshot could not advance', async () => {
    const { deps, calls, sent } = fakeDeps({ appendSentLedger: () => { throw new Error('disk full'); } });
    const stuck = await runClaimNoticePass(deps);
    expect(stuck.failed).toBe(1);
    expect(stuck.deliveries[0]!.reason).toBe('ledger-append-failed');
    deps.appendSentLedger = key => { sent.add(key); calls.appends.push(key); };
    // prev never advanced, so the same transition re-plans; the transport's
    // deterministic id makes this retry a duplicate rather than a second post.
    const retried = await runClaimNoticePass(deps);
    expect(retried.deliveries.map(d => [d.result, d.dedupeKey])).toEqual(
      [['sent', assignmentKey]]);
    const again = await runClaimNoticePass(deps);
    expect(again.planned).toBe(0);
    expect(calls.appends).toHaveLength(1);
  });

  it('fences an already-delivered notice without sending again', async () => {
    const { deps, calls, sent } = fakeDeps();
    sent.add(assignmentKey);
    const result = await runClaimNoticePass(deps);
    expect(result).toMatchObject({ status: 'completed', sent: 0, skipped: 1 });
    expect(calls.sends).toHaveLength(0);
    expect(calls.writes).toHaveLength(1);
  });

  it('keeps historical assignment keys fenced without fresh acquisition evidence', async () => {
    const { deps, calls, sent } = fakeDeps({
      readPrevSnapshot: () => ({ ...emptyPrev(), asOf: claim.claimedAt }),
    });
    sent.add(JSON.stringify(['ASSIGNED', claim.id, binding.head]));
    const result = await runClaimNoticePass(deps);
    expect(result).toMatchObject({ status: 'completed', planned: 1, sent: 0, skipped: 1 });
    expect(calls.sends).toHaveLength(0);
    expect(calls.writes).toHaveLength(1);
  });

  it('sends nothing and writes nothing when the board read is not known', async () => {
    const { deps, calls } = fakeDeps({ readBoard: () => board({ state: 'unknown' }) });
    const result = await runClaimNoticePass(deps);
    expect(result).toMatchObject({ status: 'board-unavailable', reason: 'board-state-unknown', sent: 0 });
    expect(calls.sends).toHaveLength(0);
    expect(calls.appends).toHaveLength(0);
    expect(calls.writes).toHaveLength(0);
  });

  it('refuses to send when the ledger cannot be trusted', async () => {
    const { deps, calls } = fakeDeps({ readSentLedger: () => null });
    const result = await runClaimNoticePass(deps);
    expect(result).toMatchObject({ status: 'ledger-unavailable', sent: 0 });
    expect(calls.sends).toHaveLength(0);
    expect(calls.writes).toHaveLength(0);
  });

  it('dry-run plans without sending or writing', async () => {
    const { deps, calls, getPrev } = fakeDeps({ dryRun: true });
    const result = await runClaimNoticePass(deps);
    expect(result).toMatchObject({ status: 'dry-run', planned: 1, sent: 0 });
    expect(result.deliveries[0]).toMatchObject({ result: 'planned', threadKey: binding.threadKey });
    expect(calls.sends).toHaveLength(0);
    expect(calls.appends).toHaveLength(0);
    expect(calls.writes).toHaveLength(0);
    expect(getPrev()).toMatchObject({ asOf: now - 60_000 });
  });
});

describe('claim notice file state', () => {
  let dir: string;
  const paths = { sent: '', bindings: '' };
  const mkdir = () => { dir = mkdtempSync(join(tmpdir(), 'claim-notice-')); paths.sent = join(dir, 'claim-notice-sent.jsonl'); paths.bindings = join(dir, 'claim-thread-bindings.jsonl'); };
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes dedupe keys and timestamps to the ledger — never notice text', () => {
    mkdir();
    const dedupeKey = JSON.stringify(['ASSIGNED', claim.id, binding.head]);
    appendClaimNoticeSent(paths.sent, dedupeKey, now);
    const raw = readFileSync(paths.sent, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ v: 1, at: now, key: dedupeKey });
    // The ledger row must not carry the posted text, owners, threads or tokens.
    expect(raw).not.toContain('fake-owner');
    expect(raw).not.toContain('claim acquired');
    expect(raw).not.toContain(binding.threadKey);
    expect(raw).not.toContain('T000FAKE');
    expect(readClaimNoticeSent(paths.sent)!.has(dedupeKey)).toBe(true);
  });

  it('caps the ledger at the newest 5000 keys', () => {
    mkdir();
    writeFileSync(paths.sent,
      Array.from({ length: CLAIM_NOTICE_SENT_MAX_KEYS }, (_, i) => JSON.stringify({ v: 1, at: now, key: `key-${i}` })).join('\n') + '\n',
      { mode: 0o600 });
    for (let i = 0; i < 5; i++) appendClaimNoticeSent(paths.sent, `key-${CLAIM_NOTICE_SENT_MAX_KEYS + i}`, now + i);
    const sent = readClaimNoticeSent(paths.sent)!;
    expect(sent.size).toBe(CLAIM_NOTICE_SENT_MAX_KEYS);
    expect(sent.has('key-0')).toBe(false);
    expect(sent.has('key-4')).toBe(false);
    expect(sent.has('key-5')).toBe(true);
    expect(sent.has(`key-${CLAIM_NOTICE_SENT_MAX_KEYS + 4}`)).toBe(true);
  });

  it('reads thread bindings last-wins only after damaged rows are repaired', () => {
    mkdir();
    const validRows = [
      JSON.stringify({ v: 1, claimId: claim.id, repo: claim.repo, threadKey: binding.threadKey }),
      JSON.stringify({ v: 1, claimId: claim.id, repo: claim.repo, threadKey: 'T000FAKE/C000FAKE/1700000000.000009' }),
    ].join('\n') + '\n';
    for (const damaged of ['{not json', JSON.stringify({ v: 1, claimId: '', repo: claim.repo, threadKey: binding.threadKey })]) {
      writeFileSync(paths.bindings, `${validRows}${damaged}\n`, { mode: 0o600 });
      expect(readClaimThreadBindingsState(paths.bindings)).toBeNull();
      expect(readClaimThreadBindings(paths.bindings)).toEqual([]);
    }
    writeFileSync(paths.bindings, validRows, { mode: 0o600 });
    expect(readClaimThreadBindings(paths.bindings)).toEqual([
      { claimId: claim.id, repo: claim.repo, threadKey: 'T000FAKE/C000FAKE/1700000000.000009' },
    ]);
  });
});
