import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const must = <T>(result: FleetCoordinationResult<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

for (const store of ['bindings', 'prev'] as const) {
  it(`retains the ${store} outage and sends the pending transition once after repair`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slack-store-559s-'));
    chmodSync(dir, 0o700);
    dirs.push(dir);
    const root = join(dir, 'runs');
    const paths = claimNoticePaths(root);
    const ledger = join(dir, 'coordination.jsonl');
    let now = Date.parse('2026-11-16T00:00:00Z');
    const sends: { thread: string; key: string }[] = [];
    const send: ClaimNoticeSendDeps['send'] = (thread, _text, key) => {
      sends.push({ thread, key });
      return { ok: true, receipt: 'synthetic-receipt' };
    };
    const makeTick = () => {
      const files = claimNoticeFileDeps(root);
      return createClaimNoticeTick({ now: () => now, killed: () => false,
        pass: () => runClaimNoticePass({ ...files, readBoard: () => readFleetBoard({ path: ledger, now }),
          send, now: () => now }) });
    };
    must(postFleetMessage({ from: 'setup', to: 'all', body: 'seed', ttlMs: 1 }, { path: ledger, now }));
    expect(await makeTick().maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0 });
    now += 5_000;
    const claim = must(claimFleetWork({ repo: 'fake/outage', task: 'task', agent: 'agent-a' }, { path: ledger, now })).claim;
    const thread = 'T000FAKE/C000FAKE/1700000000.000001';
    const head = 'abcdef1234567';
    expect(appendClaimThreadBinding(paths.bindings, { claimId: claim.id, repo: claim.repo, threadKey: thread, head }, now).ok).toBe(true);
    const original = readFileSync(paths[store]);
    const other = readFileSync(paths[store === 'prev' ? 'bindings' : 'prev']);
    // An oversized binding file and malformed snapshot are both existing, untrusted stores.
    const broken = store === 'bindings' ? Buffer.alloc(4 * 1024 * 1024 + 1, 0x20) : Buffer.from('{');
    writeFileSync(paths[store], broken, { mode: 0o600 });
    const boardBefore = readFileSync(ledger);
    const tick = makeTick();
    expect(await tick.maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0,
      status: store === 'bindings' ? 'bindings-unavailable' : 'prev-unavailable',
      reason: store === 'bindings' ? 'claim-bindings-unreadable' : 'prev-snapshot-unreadable' });
    expect(sends).toEqual([]);
    expect(readFileSync(paths[store]).equals(broken)).toBe(true);
    expect(readFileSync(paths[store === 'prev' ? 'bindings' : 'prev'])).toEqual(other);
    expect(readFileSync(ledger)).toEqual(boardBefore);
    expect(existsSync(paths.sent)).toBe(false);
    expect(await tick.maybeRun()).toEqual({ ran: false, reason: 'interval' });

    writeFileSync(paths[store], original, { mode: 0o600 });
    now += 30_000;
    const restarted = makeTick();
    expect(await restarted.maybeRun()).toEqual({ ran: true, sent: 1, deduped: 0, failed: 0 });
    expect(sends).toEqual([{ thread, key: JSON.stringify(['ASSIGNED', claim.repo, claim.id, claim.agent, claim.claimedAt, head]) }]);
    const sent = readFileSync(paths.sent);
    now += 30_000;
    expect(await restarted.maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0 });
    expect(sends).toHaveLength(1);
    expect(readFileSync(paths.sent)).toEqual(sent);
  });
}
