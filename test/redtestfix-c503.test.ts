import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-17T00:00:00Z');
const claim = { id: 'fake-c503-claim', repo: 'fake/project', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 60_000 };
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known',
  claims: [claim], messages: [], proposals: [], expiredClaims: 0 };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'redtestfix-c503-'));
  dirs.push(root);
  return root;
}

it.each(['directory', 'file-symlink', 'dangling-symlink'] as const)(
  'halts before transport for a %s sent ledger and replays once after repair', async kind => {
    const root = fixture();
    const paths = claimNoticePaths(root);
    const state = claimNoticeFileDeps(root);
    const previous = { state: 'known' as const, claims: [], messages: [], asOf: now - 2000 };
    state.writePrevSnapshot(previous);
    expect(appendClaimThreadBinding(paths.bindings, { claimId: claim.id, repo: claim.repo,
      threadKey: 'TFAKE/CFAKE/1700000000.000001' }, now).ok).toBe(true);
    const prevBytes = readFileSync(paths.prev);
    const bindingBytes = readFileSync(paths.bindings);
    const target = join(root, 'fake-evidence.jsonl');
    const evidence = `${JSON.stringify({ v: 1, at: now - 1000, key: 'fake-previous-notice' })}\n`;
    if (kind === 'directory') {
      mkdirSync(paths.sent);
      writeFileSync(join(paths.sent, 'evidence'), evidence);
    } else {
      if (kind === 'file-symlink') writeFileSync(target, evidence, { mode: 0o600 });
      symlinkSync(target, paths.sent);
    }
    const inode = lstatSync(paths.sent).ino;
    const send = vi.fn(() => ({ ok: true as const, receipt: 'fake-receipt' }));
    const pass = () => runClaimNoticePass({ ...state, readBoard: () => board, send, now: () => now });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await pass()).toEqual({ status: 'ledger-unavailable', reason: 'sent-ledger-unreadable',
        baselined: false, planned: 0, sent: 0, failed: 0, skipped: 0, deliveries: [] });
      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(paths.prev)).toEqual(prevBytes);
      expect(readFileSync(paths.bindings)).toEqual(bindingBytes);
      expect(lstatSync(paths.sent).ino).toBe(inode);
    }
    if (kind === 'directory') expect(readFileSync(join(paths.sent, 'evidence'), 'utf8')).toBe(evidence);
    else {
      expect(readlinkSync(paths.sent)).toBe(target);
      if (kind === 'file-symlink') expect(readFileSync(target, 'utf8')).toBe(evidence);
      else expect(() => lstatSync(target)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    }
    rmSync(paths.sent, { recursive: true });
    writeFileSync(paths.sent, evidence, { mode: 0o600 });
    expect(await pass()).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const ledger = readFileSync(paths.sent, 'utf8');
    expect(ledger.startsWith(evidence)).toBe(true);
    expect(ledger.trim().split('\n')).toHaveLength(2);
    // Replay the old snapshot as after a failed snapshot write: the repaired
    // ledger must fence the delivered notice independently of the snapshot.
    state.writePrevSnapshot(previous);
    expect(await pass()).toMatchObject({ status: 'completed', planned: 1, sent: 0, skipped: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(readFileSync(paths.sent, 'utf8')).toBe(ledger);
  });

it('treats an invalid parent component as unavailable rather than absent', async () => {
  const root = fixture();
  const blockedRoot = join(root, 'fake-parent');
  writeFileSync(blockedRoot, 'fake evidence', { mode: 0o600 });
  const send = vi.fn(() => ({ ok: true as const }));
  expect(await runClaimNoticePass({ ...claimNoticeFileDeps(blockedRoot),
    readBoard: () => board, send, now: () => now }))
    .toMatchObject({ status: 'ledger-unavailable', reason: 'sent-ledger-unreadable', deliveries: [] });
  expect(send).not.toHaveBeenCalled();
  expect(readFileSync(blockedRoot, 'utf8')).toBe('fake evidence');
});
