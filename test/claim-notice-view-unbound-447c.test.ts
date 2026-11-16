import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimNoticePaths } from '../src/core/fleet/claim-notice-send.js';
import { readClaimNoticeView } from '../src/core/fleet/claim-notice-view.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const mkClaim = (id: string, over: Partial<FleetClaim> = {}): FleetClaim =>
  ({ id, repo: 'fake-org/fake-repo', task: 'SECRET fake task text', agent: 'fake-agent', claimedAt: now - 1000, expiresAt: now + 3_600_000, ...over });
const A = mkClaim('claim-a'), B = mkClaim('claim-b', { claimedAt: now - 500 }), C = mkClaim('claim-c', { expiresAt: now - 1 });
const board = (state: 'known' | 'unknown', claims: FleetClaim[]): FleetBoard =>
  ({ schema: 'fleet.coordination.v1', state, claims, messages: [], proposals: [], expiredClaims: 0 });
const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'claim-unbound-')); chmodSync(d, 0o700); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const cfg = () => ({ path: 'x', state: 'missing', teamIdentities: [] }) as never;
const seed = (dir: string) => writeFileSync(claimNoticePaths(dir).bindings,
  `${JSON.stringify({ v: 1, claimId: A.id, repo: A.repo, threadKey: 'T00000000/C00000000/1700000000.000100', pr: 1, head: 'abcdef1' })}\n`, { mode: 0o600 });
const view = (dir: string, readBoard: () => FleetBoard) =>
  readClaimNoticeView({ runsRoot: dir, now: () => now, readBoard, readConfig: cfg, readSendReceipts: () => ({ state: 'ok', receipts: [] }) });

describe('readClaimNoticeView unbound', () => {
  it('lists only live claims with no binding, and reads the board exactly once', async () => {
    const dir = mk(); seed(dir);
    let reads = 0;
    const v = await view(dir, () => { reads++; return board('known', [A, B, C]); });
    expect(reads).toBe(1);
    expect(v.unbound).toEqual({ state: 'known', total: 1,
      rows: [{ claimId: 'claim-b', repo: B.repo, agent: 'fake-agent', claimedAt: B.claimedAt }] });
    expect(JSON.stringify(v)).not.toContain('SECRET');
  });

  it('orders newest first, caps rows, and keeps the uncapped total', async () => {
    const dir = mk(); seed(dir);
    const many = Array.from({ length: 25 }, (_, i) => mkClaim(`claim-n${i}`, { claimedAt: now - 10_000 + i }));
    const v = await view(dir, () => board('known', many));
    expect(v.unbound.total).toBe(25);
    expect(v.unbound.rows).toHaveLength(20);
    expect(v.unbound.rows[0]!.claimId).toBe('claim-n24');
  });

  it('caps untrusted strings at 128 characters', async () => {
    const dir = mk(); seed(dir);
    const v = await view(dir, () => board('known', [mkClaim('x'.repeat(500), { agent: 'y'.repeat(500) })]));
    expect(v.unbound.rows[0]!.claimId).toHaveLength(128);
    expect(v.unbound.rows[0]!.agent).toHaveLength(128);
  });

  it('is unknown when the board is not known', async () => {
    const dir = mk(); seed(dir);
    expect((await view(dir, () => board('unknown', [B]))).unbound).toEqual({ state: 'unknown', total: 0, rows: [] });
  });

  it('is unknown when the board read throws, and the sent half is still returned', async () => {
    const dir = mk(); seed(dir);
    let reads = 0;
    const v = await view(dir, () => { reads++; throw new Error('boom'); });
    expect(reads).toBe(1);
    expect(v.unbound).toEqual({ state: 'unknown', total: 0, rows: [] });
    expect(v).toMatchObject({ source: 'ok', bindings: 1, pending: [] });
  });

  it('is unknown on the missing and unreadable paths', async () => {
    const v = await view(join(mk(), 'nope'), () => board('known', [B]));
    expect(v).toMatchObject({ source: 'missing', unbound: { state: 'unknown', total: 0, rows: [] } });
  });
});
