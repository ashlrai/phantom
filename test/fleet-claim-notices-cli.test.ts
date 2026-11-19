import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetClaimNotices } from '../src/cli/fleet-claim-notices.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const claim = { id: 'claim-fake-1', repo: 'ashlrai/phantom', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 3_600_000 };
const threadKey = 'T000FAKE/C000FAKE/1700000000.000001';
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [claim],
  messages: [], proposals: [], expiredClaims: 0 };
// A fresh acquisition (claimedAt after the previous snapshot) earns the
// qualified [state, repo, id, agent, claimedAt, head] identity so owner
// handoffs and distinct acquisitions cannot collide on the sent ledger.
const dedupeKey = JSON.stringify(['ASSIGNED', claim.repo, claim.id, claim.agent, claim.claimedAt, 'abcdef1234567890']);

describe('fleet claim-notices', () => {
  let root: string;
  const paths = () => ({
    bindings: join(root, 'claim-thread-bindings.jsonl'),
    sent: join(root, 'claim-notice-sent.jsonl'),
    prev: join(root, 'claim-notice-prev.json'),
  });
  const seed = () => {
    const p = paths();
    writeFileSync(p.bindings, JSON.stringify({ v: 1, claimId: claim.id, repo: claim.repo,
      threadKey, pr: 123, head: 'abcdef1234567890' }) + '\n', { mode: 0o600 });
    writeFileSync(p.prev, JSON.stringify({ v: 1, state: 'known', claims: [], messages: [],
      asOf: now - 60_000 }), { mode: 0o600 });
  };
  const run = (flags: string[], deps: Parameters<typeof cmdFleetClaimNotices>[1] = {}) =>
    cmdFleetClaimNotices(flags, { runsRoot: root, readBoard: () => board, now: () => now, killed: false, ...deps });
  const lastJson = () => JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0])) as Record<string, unknown>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claim-notices-cli-'));
    seed();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('--dry-run --json prints planned notices and touches no file', async () => {
    const p = paths();
    const prevBytes = readFileSync(p.prev);
    expect(await run(['--dry-run', '--json'])).toBe(0);
    const report = lastJson();
    expect(report).toMatchObject({ status: 'dry-run', planned: 1, sent: 0, failed: 0 });
    expect((report.notices as Record<string, unknown>[])[0]).toMatchObject(
      { state: 'ASSIGNED', threadKey, result: 'planned', dedupeKey });
    expect(readFileSync(p.prev)).toEqual(prevBytes);
    expect(existsSync(p.sent)).toBe(false);
  });

  it('a live pass posts ASSIGNED once through the sender and advances state', async () => {
    const send = vi.fn().mockReturnValue({ ok: true, receipt: 'fake-receipt' });
    expect(await run(['--json'], { send })).toBe(0);
    expect(lastJson()).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(threadKey);
    expect(String(send.mock.calls[0]![1])).toContain('ASSIGNED');
    const raw = readFileSync(paths().sent, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ v: 1, key: dedupeKey });
    // The ledger stores the opaque dedupeKey and timestamp only — never the
    // message text or the thread reference the notice was delivered to.
    expect(raw).not.toContain(threadKey);
    expect(raw).not.toContain('claim acquired');
    expect(JSON.parse(readFileSync(paths().prev, 'utf8'))).toMatchObject({ v: 1, state: 'known', asOf: now });
    send.mockClear();
    expect(await run(['--json'], { send })).toBe(0);
    expect(lastJson()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('exits 1 and preserves the snapshot when the send fails', async () => {
    const prevBytes = readFileSync(paths().prev);
    const send = vi.fn().mockReturnValue({ ok: false, reason: 'slack-unconfigured' });
    expect(await run(['--json'], { send })).toBe(1);
    expect(lastJson()).toMatchObject({ status: 'completed', planned: 1, sent: 0, failed: 1 });
    expect((lastJson().notices as Record<string, unknown>[])[0])
      .toMatchObject({ result: 'failed', reason: 'slack-unconfigured' });
    expect(readFileSync(paths().prev)).toEqual(prevBytes);
    expect(existsSync(paths().sent)).toBe(false);
  });

  it('halts sends when KILL is armed', async () => {
    const send = vi.fn();
    expect(await run(['--json'], { send, killed: true })).toBe(0);
    expect(lastJson()).toMatchObject({ status: 'halted' });
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(paths().sent)).toBe(false);
  });
});
