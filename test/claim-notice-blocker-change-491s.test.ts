import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { appendClaimNoticeSent, claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const must = <T>(r: FleetCoordinationResult<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'blocker-change-491s-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const path = join(dir, 'coordination.jsonl'), root = join(dir, 'runs');
  const paths = claimNoticePaths(root);
  let now = Date.parse('2026-11-16T12:00:00Z');
  const options = () => ({ path, now: ++now });
  const made = must(claimFleetWork({ repo: 'fake/blocker', task: 'fake task', agent: 'fake-owner' }, options()));
  const binding = { claimId: made.claim.id, repo: made.claim.repo,
    head: 'abcdef1234567', pr: 7, threadKey: 'T000FAKE/C000FAKE/1700000000.000001' };
  expect(appendClaimThreadBinding(paths.bindings, binding, now).ok).toBe(true);
  const sends: { thread: string; text: string; key: string }[] = [];
  const send: ClaimNoticeSendDeps['send'] = (thread, text, key) => {
    sends.push({ thread, text, key });
    return { ok: true, receipt: 'fake-delivery' };
  };
  // Every pass reconstructs dependencies; only real files carry notice state.
  const pass = () => {
    now++;
    return runClaimNoticePass({ ...claimNoticeFileDeps(root),
      readBoard: () => readFleetBoard({ path, now }), send, now: () => now });
  };
  expect(await pass()).toMatchObject({ baselined: true, sent: 0 });
  const returned = returnFleetClaim({ id: made.claim.id, agent: made.claim.agent,
    lease: made.lease, blocked: 'fake dependency A', ttlMs: 1000 }, options());
  expect(returned).toMatchObject({ ok: true, outcome: 'returned' });
  const message = returned.message!;
  // The real post writer accepts replacement of the same RESULT id after TTL.
  // Reuse the real return writer's envelope; only the dependency evidence changes.
  const replace = (dependency: string) => {
    now += 1001;
    must(postFleetMessage({ id: message.id, from: message.from, to: message.to,
      body: message.body.replace('fake dependency A', dependency), ttlMs: 1000 }, options()));
  };
  return { paths, sends, pass, replace, binding, at: () => now };
}

it('delivers A then changed B once to the exact thread across durable restarts and replays', async () => {
  const f = await fixture();
  const baseline = readFileSync(f.paths.prev);
  const a = await f.pass();
  expect(a).toMatchObject({ sent: 1, failed: 0, deliveries: [{ state: 'BLOCKED' }] });
  const afterA = readFileSync(f.paths.prev);
  expect(await f.pass()).toMatchObject({ planned: 0, sent: 0 });
  f.replace('fake dependency B');
  const b = await f.pass();
  expect(b).toMatchObject({ sent: 1, failed: 0, deliveries: [{ state: 'BLOCKED' }] });
  expect(b.deliveries[0]!.text).toContain('dependency fake dependency B');
  expect(f.sends.map(s => s.thread)).toEqual([f.binding.threadKey, f.binding.threadKey]);
  expect(new Set(f.sends.map(s => s.key)).size).toBe(2);
  expect(f.sends.map(s => s.text)).toEqual([
    expect.stringContaining('dependency fake dependency A'), expect.stringContaining('dependency fake dependency B')]);
  expect(f.sends.every(s => !/VERIFIED|RELEASED|ASSIGNED/.test(s.text))).toBe(true);
  // Lost snapshot write: durable keys must fence the replanned B delivery.
  writeFileSync(f.paths.prev, afterA);
  expect(await f.pass()).toMatchObject({ sent: 0, skipped: 1,
    deliveries: [{ state: 'BLOCKED', dedupeKey: b.deliveries[0]!.dedupeKey, result: 'ledgered' }] });
  expect(await f.pass()).toMatchObject({ planned: 0, sent: 0 });
  // Same evidence with a new receipt clock is still the same durable identity.
  f.replace('fake dependency A');
  writeFileSync(f.paths.prev, baseline);
  expect(await f.pass()).toMatchObject({ sent: 0, skipped: 1,
    deliveries: [{ dedupeKey: a.deliveries[0]!.dedupeKey, result: 'ledgered' }] });
  expect(f.sends).toHaveLength(2);
});

it('does not replay an unchanged historical blocker stored with a legacy notice key', async () => {
  const f = await fixture();
  expect(await f.pass()).toMatchObject({ sent: 1 });
  const legacy = JSON.stringify(['BLOCKED', f.binding.claimId, f.binding.head]);
  writeFileSync(f.paths.sent, '', { mode: 0o600 });
  appendClaimNoticeSent(f.paths.sent, legacy, f.at());
  expect(await f.pass()).toMatchObject({ planned: 0, sent: 0 });
  f.replace('fake dependency B');
  expect(await f.pass()).toMatchObject({ sent: 1, deliveries: [{ state: 'BLOCKED' }] });
  expect(await f.pass()).toMatchObject({ planned: 0, sent: 0 });
  expect(f.sends).toHaveLength(2);
});
