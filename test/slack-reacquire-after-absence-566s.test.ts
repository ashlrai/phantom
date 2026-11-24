import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { appendClaimNoticeSent, claimNoticeFileDeps, claimNoticePaths, readClaimNoticePrev,
  readClaimNoticeSent, runClaimNoticePass, writeClaimNoticePrev } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { planClaimThreadNotices, type ClaimThreadSnapshot } from '../src/core/fleet/claim-thread-notice.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';

const T = Date.parse('2026-11-18T00:00:00Z');
const head = 'abcdef1234567';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const claim = (repo: string, claimedAt: number, agent = 'fake-a'): FleetClaim =>
  ({ repo, id: 'fake-claim', task: 'fake task', agent, claimedAt, expiresAt: T + 100_000 });
const key = (c: FleetClaim) => JSON.stringify(['ASSIGNED', c.repo, c.id, c.agent, c.claimedAt, head]);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slack-reacquire-566s-'));
  roots.push(root);
  const paths = claimNoticePaths(root);
  const bindings = ['fake/one', 'fake/two'].map((repo, i) => ({ repo, claimId: 'fake-claim', head,
    threadKey: `T0FAKE/C0FAKE/1700000000.00000${i + 1}` }));
  for (const binding of bindings) expect(appendClaimThreadBinding(paths.bindings, binding, T).ok).toBe(true);
  const sends: { threadKey: string; text: string; dedupeKey: string }[] = [];
  const messages: FleetBoard['messages'] = [{ id: 'return-fake-history', from: 'fake-a', to: 'all',
    at: T - 1, expiresAt: T + 100_000,
    body: `RESULT VERIFIED fake/one claim fake-history task "fake task": pr #7 head ${head}` }];
  const snapshot = (claims: FleetClaim[], asOf: number): ClaimThreadSnapshot =>
    ({ state: 'known', claims, messages, asOf });
  const pass = (claims: FleetClaim[], now: number) => runClaimNoticePass({
    ...claimNoticeFileDeps(root), // A new reader each pass; only files survive restart.
    readBoard: () => ({ schema: 'fleet.coordination.v1', ...snapshot(claims, now), proposals: [], expiredClaims: 0 }),
    now: () => now,
    send: (threadKey, text, dedupeKey) => {
      sends.push({ threadKey, text, dedupeKey });
      return { ok: true, receipt: 'fake-receipt' };
    },
  });
  return { paths, bindings, sends, snapshot, pass };
}

it.each(['released', 'expired'])('reacquires after a persisted %s absence with durable replay fencing', async mode => {
  const f = fixture();
  expect(await f.pass([], T)).toMatchObject({ baselined: true, sent: 0 });
  const a = claim('fake/one', T + 1);
  if (mode === 'expired') a.expiresAt = T + 3;
  expect(await f.pass([a], T + 2)).toMatchObject({ sent: 1 });
  expect(f.sends[0]!.dedupeKey).toBe(key(a));
  expect(await f.pass(mode === 'expired' ? [a] : [], T + 4)).toMatchObject({ sent: 1 });
  expect(f.sends[1]!.dedupeKey).toBe(JSON.stringify(['RELEASED', a.repo, a.id, a.agent, a.claimedAt, head]));
  expect(await f.pass([], T + 5)).toMatchObject({ sent: 0 });
  const absent = readClaimNoticePrev(f.paths.prev)!;
  expect(absent.claims).toEqual([]);
  for (const [offset, agent] of [[6, 'fake-a'], [10, 'fake-b']] as const) {
    const acquired = claim('fake/one', T + offset, agent);
    const other = claim('fake/two', acquired.claimedAt, agent);
    const before = readClaimNoticePrev(f.paths.prev)!;
    const planned = planClaimThreadNotices(before, f.snapshot([acquired, other], T + offset + 1), f.bindings, T + offset + 1);
    expect(planned.map(n => n.dedupeKey)).toEqual([key(acquired), key(other)]);
    expect(await f.pass([acquired, other], T + offset + 1)).toMatchObject({ sent: 2, failed: 0 });
    // Replay the exact absence-to-acquisition diff, forcing the durable ledger fence.
    writeClaimNoticePrev(f.paths.prev, before);
    expect(await f.pass([acquired, other], T + offset + 2)).toMatchObject({ sent: 0, skipped: 2 });
    expect(readClaimNoticePrev(f.paths.prev)!.claims).toEqual([acquired, other]);
    expect(await f.pass([acquired, other], T + offset + 2)).toMatchObject({ planned: 0, sent: 0 });
    expect(await f.pass([], T + offset + 3)).toMatchObject({ sent: 2 });
  }
  expect(f.sends.filter(s => s.text.startsWith('ASSIGNED')).map(s => s.dedupeKey))
    .toEqual([key(a), ...[6, 10].flatMap(n => ['fake/one', 'fake/two'].map(repo => key(claim(repo, T + n, n === 6 ? 'fake-a' : 'fake-b'))))]);
  expect(f.sends.every(s => s.threadKey === f.bindings.find(b => s.text.includes(b.repo))!.threadKey)).toBe(true);
  expect(f.sends.some(s => s.text.startsWith('VERIFIED'))).toBe(false);
  expect(readClaimNoticeSent(f.paths.sent)).toEqual(new Set(f.sends.map(s => s.dedupeKey)));
});

it.each([T - 1, T])('retains legacy fencing for a historical acquisition clock %s', async claimedAt => {
  const f = fixture();
  const historical = claim('fake/one', claimedAt);
  const legacy = JSON.stringify(['ASSIGNED', historical.id, head]);
  appendClaimNoticeSent(f.paths.sent, legacy, T);
  const ledger = readFileSync(f.paths.sent, 'utf8');
  const before = f.snapshot([], T);
  writeClaimNoticePrev(f.paths.prev, before);
  expect(planClaimThreadNotices(before, f.snapshot([historical], T + 1), f.bindings, T + 1))
    .toMatchObject([{ state: 'ASSIGNED', dedupeKey: legacy }]);
  expect(await f.pass([historical, { ...claim('fake/unbound', T + 1), id: 'fake-unbound' }], T + 2)).toMatchObject({ sent: 0, skipped: 1 });
  writeClaimNoticePrev(f.paths.prev, before);
  expect(await f.pass([historical], T + 3)).toMatchObject({ sent: 0, skipped: 1 });
  expect(f.sends).toEqual([]);
  expect(readFileSync(f.paths.sent, 'utf8')).toBe(ledger);
});
