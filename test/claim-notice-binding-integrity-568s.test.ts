import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimNoticeFileDeps, claimNoticePaths, readClaimThreadBindings, readClaimThreadBindingsState,
  runClaimNoticePass, type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const claim = { id: 'fake-568', repo: 'fake/repo', task: 'fake task', agent: 'fake-agent',
  claimedAt: now - 1000, expiresAt: now + 60000 };
const binding = { v: 1, claimId: claim.id, repo: claim.repo, threadKey: 'fake/old', head: 'fake-head' };
const corrected = { ...binding, threadKey: 'fake/corrected' };
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [claim],
  messages: [], proposals: [], expiredClaims: 0 };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'binding-integrity-568-'));
  chmodSync(root, 0o700);
  dirs.push(root);
  const paths = claimNoticePaths(root);
  writeFileSync(paths.prev, JSON.stringify({ v: 1, state: 'known', claims: [], messages: [], asOf: now - 1000 }), { mode: 0o600 });
  writeFileSync(paths.sent, `${JSON.stringify({ v: 1, at: now - 1000, key: 'earlier' })}\n`, { mode: 0o600 });
  const calls: string[] = [];
  const send: ClaimNoticeSendDeps['send'] = (threadKey) => { calls.push(threadKey); return { ok: true, receipt: 'fake' }; };
  const pass = () => runClaimNoticePass({ ...claimNoticeFileDeps(root), readBoard: () => board, send, now: () => now });
  return { paths, calls, pass };
}

describe('binding integrity preserves pending notices', () => {
  it.each([
    ['torn JSON', '{"v":1'],
    ['unsupported version', JSON.stringify({ ...binding, v: 2 })],
    ['invalid record', JSON.stringify({ ...binding, threadKey: '' })],
    ['non-object', 'null'],
  ])('halts on %s and recovers the assignment exactly once', async (_label, bad) => {
    const f = fixture();
    const damaged = `${JSON.stringify(binding)}\n\n${bad}\n`;
    writeFileSync(f.paths.bindings, damaged, { mode: 0o600 });
    const prev = readFileSync(f.paths.prev);
    const sent = readFileSync(f.paths.sent);
    expect(readClaimThreadBindingsState(f.paths.bindings)).toBeNull();
    expect(readClaimThreadBindings(f.paths.bindings)).toEqual([]);
    expect(await f.pass()).toMatchObject({ status: 'bindings-unavailable', planned: 0, sent: 0 });
    expect(f.calls).toEqual([]);
    expect(readFileSync(f.paths.bindings, 'utf8')).toBe(damaged);
    expect(readFileSync(f.paths.prev)).toEqual(prev);
    expect(readFileSync(f.paths.sent)).toEqual(sent);
    writeFileSync(f.paths.bindings, `${JSON.stringify(binding)}\n \n${JSON.stringify(corrected)}\n`, { mode: 0o600 });
    expect(await f.pass()).toMatchObject({ status: 'completed', planned: 1, sent: 1,
      deliveries: [{ state: 'ASSIGNED', threadKey: corrected.threadKey, result: 'sent' }] });
    expect(await f.pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(f.calls).toEqual([corrected.threadKey]);
  });

  it('treats absent and blank files as known empty', () => {
    const f = fixture();
    expect(readClaimThreadBindingsState(f.paths.bindings)).toEqual([]);
    writeFileSync(f.paths.bindings, '\n  \n', { mode: 0o600 });
    expect(readClaimThreadBindingsState(f.paths.bindings)).toEqual([]);
  });
});
