import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass, type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';

it('inspecting a failed claim notice preserves it for delivery after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-notice-dryrun-486s-'));
  chmodSync(dir, 0o700);
  try {
    const ledger = join(dir, 'coordination.jsonl');
    const root = join(dir, 'runs');
    const paths = claimNoticePaths(root);
    const threadKey = 'T000FAKE/C000FAKE/1700000000.000001';
    const head = 'abcdef1234567';
    let now = Date.parse('2026-11-16T00:00:00Z');
    const sends: { threadKey: string; text: string; dedupeKey: string }[] = [];
    let fail = true;
    const send: ClaimNoticeSendDeps['send'] = (thread, text, dedupeKey) => {
      sends.push({ threadKey: thread, text, dedupeKey });
      return fail ? { ok: false, reason: 'synthetic-failure' } : { ok: true, receipt: 'fake-receipt' };
    };
    const pass = (dryRun = false) => runClaimNoticePass({
      readBoard: () => readFleetBoard({ path: ledger, now, reap: false }),
      ...claimNoticeFileDeps(root), send, now: () => now, dryRun,
    });
    expect(postFleetMessage({ from: 'setup', to: 'all', body: 'fake seed', ttlMs: 1 },
      { path: ledger, now: now++ }).ok).toBe(true);
    expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0 });
    const claim = claimFleetWork({ repo: 'fake/recovery', task: 'fake task', agent: 'agent-a' },
      { path: ledger, now: ++now });
    if (!claim.ok) throw new Error(claim.error);
    expect(appendClaimThreadBinding(paths.bindings,
      { claimId: claim.value.claim.id, repo: 'fake/recovery', threadKey, pr: 7, head }, now).ok).toBe(true);
    const acquired = claim.value.claim;
    const key = JSON.stringify(['ASSIGNED', acquired.repo, acquired.id, acquired.agent, acquired.claimedAt, head]);
    const failed = await pass();
    expect(failed).toMatchObject({ status: 'completed', planned: 1, sent: 0, failed: 1,
      deliveries: [{ threadKey, state: 'ASSIGNED', dedupeKey: key, result: 'failed' }] });
    const bytes = () => [paths.prev, paths.sent, paths.bindings].map(path =>
      existsSync(path) ? readFileSync(path) : null);
    const before = bytes();
    expect(before[0]).not.toBeNull();
    expect(before[1]).toBeNull();
    expect(before[2]).not.toBeNull();
    for (let i = 0; i < 2; i++) {
      now++;
      const inspection = await pass(true);
      expect(inspection).toMatchObject({ status: 'dry-run', planned: 1, sent: 0, failed: 0,
        deliveries: [{ threadKey, state: 'ASSIGNED', dedupeKey: key, result: 'planned' }] });
      expect(inspection.deliveries.map(delivery => delivery.state)).toEqual(['ASSIGNED']);
      expect(sends).toHaveLength(1);
      expect(bytes()).toEqual(before);
    }
    fail = false;
    now++;
    expect(await pass()).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0,
      deliveries: [{ threadKey, state: 'ASSIGNED', dedupeKey: key, result: 'sent', receipt: 'fake-receipt' }] });
    expect(sends).toHaveLength(2);
    expect(sends.map(({ threadKey: thread, dedupeKey }) => ({ thread, dedupeKey })))
      .toEqual([{ thread: threadKey, dedupeKey: key }, { thread: threadKey, dedupeKey: key }]);
    expect(JSON.parse(readFileSync(paths.sent, 'utf8').trim())).toEqual({ v: 1, at: now, key });
    expect(JSON.parse(readFileSync(paths.prev, 'utf8')).claims).toEqual([claim.value.claim]);
    expect(await pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(await pass(true)).toMatchObject({ status: 'dry-run', planned: 0, sent: 0, deliveries: [] });
    expect(sends).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
