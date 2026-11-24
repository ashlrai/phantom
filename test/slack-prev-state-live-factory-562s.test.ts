import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const thread = 'T000FAKE/C000FAKE/1700000000.000001';
const claim = { id: 'fake-claim', repo: 'acme/app', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 3600000 };
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [claim],
  messages: [], proposals: [], expiredClaims: 0 };
const previous = { state: 'known' as const, claims: [], messages: [], asOf: now - 1000 };

describe('claim notice live dependency factory', () => {
  const root = mkdtempSync(join(tmpdir(), 'claim-prev-factory-'));
  const runsRoot = join(root, 'runs');
  const busRoot = join(root, 'bus');
  const paths = claimNoticePaths(runsRoot);
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('retains corrupt history across restarts, then resumes once after repair', async () => {
    const files = claimNoticeFileDeps(runsRoot);
    files.writePrevSnapshot(previous);
    writeFileSync(paths.bindings, JSON.stringify({ v: 1, claimId: claim.id, repo: claim.repo, threadKey: thread }) + '\n');
    const corrupt = '{ malformed prior history\n';
    writeFileSync(paths.prev, corrupt);
    const send = vi.fn().mockReturnValue({ ok: true, receipt: 'fake-receipt' });
    const factory = () => claimNoticePassDeps({ runsRoot, busRoot, readBoard: () => board, now: () => now, send });
    for (let restart = 0; restart < 2; restart++) {
      expect(await runClaimNoticePass(factory())).toMatchObject({ status: 'prev-unavailable', sent: 0 });
      expect(readFileSync(paths.prev, 'utf8')).toBe(corrupt);
      expect(existsSync(paths.sent)).toBe(false);
      expect(send).not.toHaveBeenCalled();
    }
    files.writePrevSnapshot(previous);
    const result = await runClaimNoticePass(factory());
    expect(result).toMatchObject({ status: 'completed', planned: 1, sent: 1 });
    expect(result.deliveries[0]).toMatchObject({ state: 'ASSIGNED', threadKey: thread });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(thread);
    const ledger = readFileSync(paths.sent, 'utf8');
    expect(files.readSentLedger()?.size).toBe(1);
    expect(await runClaimNoticePass(factory())).toMatchObject({ status: 'completed', sent: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(readFileSync(paths.sent, 'utf8')).toBe(ledger);
  });

  it('honors an explicit state reader even with a legacy reader', async () => {
    const state = vi.fn(() => ({ state: 'unavailable' as const }));
    const legacy = vi.fn(() => previous);
    const result = await runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readBoard: () => board,
      now: () => now, readPrevSnapshot: legacy, readPrevSnapshotState: state }));
    expect(result.status).toBe('prev-unavailable');
    expect(state).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });

  it('uses a legacy reader alone without consulting the default corrupt history', async () => {
    const files = claimNoticeFileDeps(runsRoot);
    files.writePrevSnapshot(previous);
    writeFileSync(paths.prev, '{bad');
    const legacy = vi.fn(() => previous);
    const result = await runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readBoard: () => board,
      now: () => now, readPrevSnapshot: legacy, readBindings: () => [], writePrevSnapshot: () => undefined }));
    expect(result).toMatchObject({ status: 'completed', baselined: false });
    expect(legacy).toHaveBeenCalledOnce();
    expect(readFileSync(paths.prev, 'utf8')).toBe('{bad');
  });

  it('baselines a genuinely absent default snapshot', async () => {
    const result = await runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readBoard: () => board, now: () => now }));
    expect(result).toMatchObject({ status: 'completed', baselined: true, sent: 0 });
    expect(claimNoticeFileDeps(runsRoot).readPrevSnapshot()).toMatchObject({ state: 'known', claims: [claim] });
  });
});
