import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, handoffFleetClaim, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('retains a real pending handoff across an unreadable sent ledger and repair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-notice-repair-487s-'));
  dirs.push(dir);
  chmodSync(dir, 0o700);
  const ledgerPath = join(dir, 'coordination.jsonl');
  const runsRoot = join(dir, 'runs');
  const paths = claimNoticePaths(runsRoot);
  const threadA = 'T000FAKE/C000FAKE/1700000000.000001';
  const threadB = 'T000FAKE/C000FAKE/1700000000.000002';
  const headA = 'abcdef1234567';
  const headB = '1234567abcdef';
  let now = Date.parse('2026-11-16T00:00:00Z');
  const tick = () => { now += 5000; return now; };
  const options = () => ({ path: ledgerPath, now: tick() });
  const sends: { threadKey: string; text: string; dedupeKey: string }[] = [];
  const send: ClaimNoticeSendDeps['send'] = (threadKey, text, dedupeKey) => {
    sends.push({ threadKey, text, dedupeKey });
    return { ok: true, receipt: `fake-receipt-${sends.length}` };
  };
  const pass = async () => {
    const at = tick();
    const result = await runClaimNoticePass({ readBoard: () => readFleetBoard({ path: ledgerPath, now }),
      ...claimNoticeFileDeps(runsRoot), send, now: () => now });
    return { ...result, at };
  };
  const claimA = must(claimFleetWork({ repo: 'fake/alpha', task: 'synthetic A', agent: 'agent-a' }, options()));
  const claimB = must(claimFleetWork({ repo: 'fake/beta', task: 'synthetic B', agent: 'agent-c' }, options()));
  expect(appendClaimThreadBinding(paths.bindings,
    { claimId: claimA.claim.id, repo: claimA.claim.repo, threadKey: threadA, pr: 7, head: headA }, now).ok).toBe(true);
  expect(appendClaimThreadBinding(paths.bindings,
    { claimId: claimB.claim.id, repo: claimB.claim.repo, threadKey: threadB, pr: 9, head: headB }, now).ok).toBe(true);
  expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0, sent: 0 });

  // Produce a real prior ledger row before the outage, using an unrelated owner change.
  const handoffB = must(handoffFleetClaim({ id: claimB.claim.id, agent: 'agent-c',
    lease: claimB.lease, to: 'agent-d' }, options()));
  const keyB = JSON.stringify(['ASSIGNED', claimB.claim.repo, claimB.claim.id, 'agent-d', handoffB.claim.claimedAt, headB]);
  const initial = await pass();
  expect(initial).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
  expect(initial.deliveries[0]).toMatchObject({ threadKey: threadB, state: 'ASSIGNED', dedupeKey: keyB, result: 'sent' });
  const sentBefore = readFileSync(paths.sent);
  expect(sentBefore.toString()).toBe(`${JSON.stringify({ v: 1, at: initial.at, key: keyB })}\n`);
  const prevBefore = readFileSync(paths.prev);
  const bindingsBefore = readFileSync(paths.bindings);

  const handoffA = must(handoffFleetClaim({ id: claimA.claim.id, agent: 'agent-a',
    lease: claimA.lease, to: 'agent-b' }, options()));
  const keyA = JSON.stringify(['ASSIGNED', claimA.claim.repo, claimA.claim.id, 'agent-b', handoffA.claim.claimedAt, headA]);
  const boardBefore = readFileSync(ledgerPath);
  rmSync(paths.sent);
  mkdirSync(paths.sent, { mode: 0o700 });
  const marker = Buffer.from('synthetic damaged evidence\n');
  writeFileSync(join(paths.sent, 'evidence'), marker, { mode: 0o600 });
  const damaged = lstatSync(paths.sent);

  const refused = await pass();
  expect(refused).toMatchObject({ status: 'ledger-unavailable', reason: 'sent-ledger-unreadable',
    planned: 0, sent: 0, failed: 0, skipped: 0, deliveries: [] });
  expect(sends).toHaveLength(1);
  expect(readFileSync(paths.prev)).toEqual(prevBefore);
  expect(readFileSync(paths.bindings)).toEqual(bindingsBefore);
  expect(readFileSync(ledgerPath)).toEqual(boardBefore);
  expect(lstatSync(paths.sent).isDirectory()).toBe(true);
  expect(lstatSync(paths.sent).ino).toBe(damaged.ino);
  expect(readdirSync(paths.sent)).toEqual(['evidence']);
  expect(readFileSync(join(paths.sent, 'evidence'))).toEqual(marker);

  rmSync(paths.sent, { recursive: true });
  writeFileSync(paths.sent, sentBefore, { mode: 0o600 });
  expect(readFileSync(paths.sent)).toEqual(sentBefore);
  const repaired = await pass();
  expect(repaired).toMatchObject({ status: 'completed', baselined: false, planned: 1, sent: 1, failed: 0, skipped: 0 });
  expect(repaired.deliveries).toHaveLength(1);
  expect(repaired.deliveries[0]).toMatchObject({ threadKey: threadA, state: 'ASSIGNED', dedupeKey: keyA,
    result: 'sent', receipt: 'fake-receipt-2' });
  expect(sends).toHaveLength(2);
  expect(sends[1]).toMatchObject({ threadKey: threadA, dedupeKey: keyA });
  expect(sends[1]!.text).toContain('agent-b');
  expect(sends.filter(item => item.threadKey === threadB)).toHaveLength(1);
  const sentAfter = Buffer.concat([sentBefore, Buffer.from(`${JSON.stringify({ v: 1, at: repaired.at, key: keyA })}\n`)]);
  expect(readFileSync(paths.sent)).toEqual(sentAfter);
  expect(JSON.parse(readFileSync(paths.prev, 'utf8'))).toMatchObject({ v: 1, state: 'known',
    asOf: repaired.at, claims: [handoffA.claim, handoffB.claim] });
  const prevAfter = readFileSync(paths.prev);
  const quiet = await pass();
  expect(quiet).toMatchObject({ status: 'completed', planned: 0, sent: 0, failed: 0, deliveries: [] });
  expect(sends).toHaveLength(2);
  expect(readFileSync(paths.sent)).toEqual(sentAfter);
  expect(JSON.parse(readFileSync(paths.prev, 'utf8'))).toMatchObject({ v: 1, state: 'known', asOf: quiet.at,
    claims: [handoffA.claim, handoffB.claim] });
  expect(readFileSync(paths.prev)).not.toEqual(prevAfter);
});
