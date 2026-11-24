import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('delivers all 55 bound VERIFIED returns beyond the UI cap, once across durable replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-return-burst-490s-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const root = join(dir, 'runs');
  const paths = claimNoticePaths(root);
  const ledger = join(dir, 'coordination.jsonl');
  let now = Date.parse('2026-11-16T00:00:00Z');
  const options = () => ({ path: ledger, now: now += 1_000 });
  const sends: { threadKey: string; text: string; dedupeKey: string }[] = [];
  const send: ClaimNoticeSendDeps['send'] = (threadKey, text, dedupeKey) => {
    sends.push({ threadKey, text, dedupeKey });
    return { ok: true, receipt: `fake-burst-receipt-${sends.length}` };
  };
  // Fresh file dependencies and a fresh real board reader on every pass.
  const pass = () => {
    now += 1_000;
    return runClaimNoticePass({ ...claimNoticeFileDeps(root),
      readBoard: () => readFleetBoard({ path: ledger, now }), send, now: () => now });
  };
  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, options()));
  expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0, sent: 0 });
  expect(readFleetBoard({ path: ledger, now })).toMatchObject({ state: 'known', claims: [], messages: [] });
  expect(sends).toEqual([]);

  const claims = Array.from({ length: 55 }, (_, i) => {
    const owned = must(claimFleetWork({ repo: 'fake/burst', task: `fake burst task ${i}`,
      agent: `fake-owner-${i}` }, options()));
    const binding = { claimId: owned.claim.id, repo: owned.claim.repo, pr: i + 1,
      head: (i + 1).toString(16).padStart(40, '0'),
      threadKey: `T000FAKE/C000FAKE/1700000000.${String(i + 1).padStart(6, '0')}` };
    expect(appendClaimThreadBinding(paths.bindings, binding, now)).toMatchObject({ ok: true, status: 'bound' });
    return { ...owned, ...binding };
  });
  const keys = (state: string) => claims.map(c => JSON.stringify([state, c.claim.id, c.head]));
  const identities = (state: string) => claims.map(c =>
    JSON.stringify([c.threadKey, JSON.stringify([state, c.claim.id, c.head])])).sort();
  const sentIdentities = (rows: typeof sends) => rows.map(s => JSON.stringify([s.threadKey, s.dedupeKey])).sort();
  const assigned = await pass();
  const assignedAt = now;
  expect(assigned).toMatchObject({ status: 'completed', planned: 55, sent: 55, failed: 0, skipped: 0 });
  expect(sentIdentities(sends)).toEqual(identities('ASSIGNED'));
  const beforeDelivery = readFileSync(paths.prev);
  expect(JSON.parse(beforeDelivery.toString()).claims.map((c: { id: string }) => c.id).sort())
    .toEqual(claims.map(c => c.claim.id).sort());

  // All real returns arrive between passes; none may turn into RELEASED.
  for (const c of claims) {
    expect(returnFleetClaim({ id: c.claim.id, agent: c.claim.agent, lease: c.lease,
      pr: c.pr, head: c.head }, options())).toMatchObject({ ok: true, outcome: 'returned' });
  }
  const board = readFleetBoard({ path: ledger, now });
  expect(board).toMatchObject({ state: 'known', claims: [] });
  expect(board.messages.map(m => m.id).sort()).toEqual(claims.map(c => `return-${c.claim.id}`).sort());
  const view = projectCoordinationReturns(board, now);
  expect(view).toMatchObject({ state: 'known', unparsed: 0 });
  expect(view.returns.map(r => r.claimId).sort()).toEqual(claims.slice(5).map(c => c.claim.id).sort());
  const verified = await pass();
  const verifiedAt = now;
  expect(verified).toMatchObject({ status: 'completed', planned: 55, sent: 55, failed: 0, skipped: 0 });
  expect(sentIdentities(sends.slice(55))).toEqual(identities('VERIFIED'));
  expect(verified.deliveries.map(d => d.state)).toEqual(claims.map(() => 'VERIFIED'));
  for (const c of claims) {
    const delivered = sends.slice(55).find(s => s.threadKey === c.threadKey)!;
    expect(delivered.text).toContain(`VERIFIED: ${c.claim.agent} ${c.repo}#${c.pr}@${c.head.slice(0, 7)}`);
    expect(delivered.text).toContain(`claim ${c.claim.id}; pr #${c.pr} head ${c.head};`);
  }
  const sentBytes = readFileSync(paths.sent);
  const persisted = sentBytes.toString().trim().split('\n').map(line => JSON.parse(line));
  expect(persisted).toEqual([
    ...keys('ASSIGNED').map(key => ({ v: 1, at: assignedAt, key })),
    ...keys('VERIFIED').map(key => ({ v: 1, at: verifiedAt, key })),
  ]);

  // Lose only the snapshot update; retain the real sent ledger across restart.
  writeFileSync(paths.prev, beforeDelivery, { mode: 0o600 });
  const replay = await pass();
  expect(replay).toMatchObject({ status: 'completed', planned: 55, sent: 0, failed: 0, skipped: 55 });
  expect(sentIdentities(replay.deliveries)).toEqual(identities('VERIFIED'));
  expect(replay.deliveries.every(d => d.state === 'VERIFIED' && d.result === 'ledgered')).toBe(true);
  expect(sends).toHaveLength(110);
  expect(readFileSync(paths.sent)).toEqual(sentBytes);
  expect(await pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0, deliveries: [] });
  expect(sends).toHaveLength(110);
  expect(readFileSync(paths.sent)).toEqual(sentBytes);
});
