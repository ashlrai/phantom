import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'claim-snapshot-563s-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl');
  const root = join(dir, 'runs');
  const paths = claimNoticePaths(root);
  const thread = 'T000FAKE/C000FAKE/1700000000.000001';
  const receipt = 'fake-receipt-563s';
  let now = Date.parse('2026-11-16T00:00:00Z');
  let failSend = false;
  const calls: { thread: string; text: string; key: string; outcome: { ok: boolean; receipt?: string; reason?: string } }[] = [];
  const send: ClaimNoticeSendDeps['send'] = (target, text, key) => {
    const outcome = failSend ? { ok: false as const, reason: 'fake-send-failure' }
      : { ok: true as const, receipt };
    calls.push({ thread: target, text, key, outcome });
    return outcome;
  };
  const options = () => ({ path: ledger, now: now += 5_000 });
  const pass = (failSnapshot = false) => {
    now += 5_000;
    const deps = claimNoticeFileDeps(root);
    return runClaimNoticePass({ ...deps,
      ...(failSnapshot ? { writePrevSnapshot: () => { throw new Error('fake snapshot write failure'); } } : {}),
      readBoard: () => readFleetBoard({ path: ledger, now }), send, now: () => now });
  };
  const seed = () => must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, options()));
  const acquire = () => {
    const claim = must(claimFleetWork({ repo: 'fake/alpha', task: 'fake task', agent: 'fake-owner' }, options())).claim;
    const binding = { claimId: claim.id, repo: 'fake/alpha', threadKey: thread, pr: 7, head: 'abcdef1234567' };
    expect(appendClaimThreadBinding(paths.bindings, binding, now).ok).toBe(true);
    expect(JSON.parse(readFileSync(paths.bindings, 'utf8').trim())).toMatchObject(binding);
    return { claim, key: JSON.stringify(['ASSIGNED', claim.repo, claim.id, claim.agent, claim.claimedAt, binding.head]) };
  };
  return { paths, thread, receipt, calls, pass, seed, acquire,
    setFailSend: (value: boolean) => { failSend = value; }, clock: () => now };
}

it('fences a successful source-thread notice when snapshot persistence fails and recovers on restart', async () => {
  const s = setup();
  s.seed();
  expect(await s.pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0 });
  const baseline = readFileSync(s.paths.prev);
  const { claim, key } = s.acquire();
  const first = await s.pass(true);
  expect(first).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 1, reason: 'snapshot-write-failed', skipped: 0,
    deliveries: [{ threadKey: s.thread, state: 'ASSIGNED', dedupeKey: key, result: 'sent', receipt: s.receipt }] });
  expect(s.calls).toHaveLength(1);
  expect(s.calls[0]).toMatchObject({ thread: s.thread, key, outcome: { ok: true, receipt: s.receipt } });
  expect(s.calls[0]!.text).toContain('fake-owner');
  expect(readFileSync(s.paths.prev)).toEqual(baseline);
  const sent = readFileSync(s.paths.sent);
  expect(JSON.parse(sent.toString().trim())).toEqual({ v: 1, at: s.clock(), key });

  const recovered = await s.pass();
  expect(recovered).toMatchObject({ status: 'completed', planned: 1, sent: 0, failed: 0, skipped: 1,
    deliveries: [{ threadKey: s.thread, state: 'ASSIGNED', dedupeKey: key, result: 'ledgered' }] });
  expect(s.calls).toHaveLength(1);
  expect(readFileSync(s.paths.sent)).toEqual(sent);
  expect(readFileSync(s.paths.prev)).not.toEqual(baseline);
  expect(JSON.parse(readFileSync(s.paths.prev, 'utf8'))).toMatchObject({ v: 1, state: 'known', asOf: s.clock(), claims: [claim] });
  expect(await s.pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0, failed: 0, deliveries: [] });
  expect(s.calls).toHaveLength(1);
  expect(readFileSync(s.paths.sent)).toEqual(sent);
  expect(JSON.parse(readFileSync(s.paths.prev, 'utf8')).claims).toEqual([claim]);
});

it('retries a failed send exactly once after reconstructing file dependencies', async () => {
  const s = setup();
  s.seed();
  expect(await s.pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0 });
  const baseline = readFileSync(s.paths.prev);
  const { claim, key } = s.acquire();
  s.setFailSend(true);
  expect(await s.pass()).toMatchObject({ status: 'completed', planned: 1, sent: 0, failed: 1,
    deliveries: [{ threadKey: s.thread, state: 'ASSIGNED', dedupeKey: key, result: 'failed', reason: 'fake-send-failure' }] });
  expect(s.calls).toHaveLength(1);
  expect(s.calls[0]).toMatchObject({ thread: s.thread, key, outcome: { ok: false, reason: 'fake-send-failure' } });
  expect(existsSync(s.paths.sent)).toBe(false);
  expect(readFileSync(s.paths.prev)).toEqual(baseline);

  s.setFailSend(false);
  expect(await s.pass()).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0,
    deliveries: [{ threadKey: s.thread, state: 'ASSIGNED', dedupeKey: key, result: 'sent', receipt: s.receipt }] });
  expect(s.calls).toHaveLength(2);
  expect(s.calls[1]).toMatchObject({ thread: s.thread, key, outcome: { ok: true, receipt: s.receipt } });
  const sent = readFileSync(s.paths.sent);
  expect(JSON.parse(sent.toString().trim())).toEqual({ v: 1, at: s.clock(), key });
  expect(JSON.parse(readFileSync(s.paths.prev, 'utf8'))).toMatchObject({ v: 1, state: 'known', asOf: s.clock(), claims: [claim] });
  expect(await s.pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0, failed: 0, deliveries: [] });
  expect(s.calls).toHaveLength(2);
  expect(readFileSync(s.paths.sent)).toEqual(sent);
});


it('reports a failed baseline checkpoint and preserves success semantics after recovery', async () => {
  const s = setup();
  s.seed();
  expect(await s.pass(true)).toMatchObject({ status: 'completed', baselined: true, planned: 0,
    sent: 0, skipped: 0, failed: 1, reason: 'snapshot-write-failed', deliveries: [] });
  expect(existsSync(s.paths.prev)).toBe(false);
  const recovered = await s.pass();
  expect(recovered).toMatchObject({ status: 'completed', baselined: true, planned: 0,
    sent: 0, skipped: 0, failed: 0, deliveries: [] });
  expect(recovered.reason).toBeUndefined();
  expect(existsSync(s.paths.prev)).toBe(true);
});
