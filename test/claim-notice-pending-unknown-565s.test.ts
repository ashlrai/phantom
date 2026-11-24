import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import { appendClaimNoticeSent, claimNoticePaths, writeClaimNoticePrev } from '../src/core/fleet/claim-notice-send.js';
import { readClaimNoticeView } from '../src/core/fleet/claim-notice-view.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const claim = { id: 'claim-fake-1', repo: 'fake-org/fake-repo', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 3_600_000 };
const threadKey = 'T00000000/C00000000/1700000000.000100';
const board = (claims = [claim]): FleetBoard =>
  ({ schema: 'fleet.coordination.v1', state: 'known', claims, messages: [], proposals: [], expiredClaims: 0 });
const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'claim-pending-')); chmodSync(d, 0o700); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const bytes = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map(n => [n, (() => { try { return readFileSync(join(dir, n), 'utf8'); } catch { return '<unreadable>'; } })()]));
const cfg = () => ({ path: 'x', state: 'missing', teamIdentities: [] }) as never;

const sentKey = JSON.stringify(['VERIFIED', claim.repo, claim.id, 'abc']);
const receiptTs = String((now - 5000) / 1000 - 1);
const receipts = () => ({ state: 'ok' as const, receipts: [{
  key: slackSendStoreKey(`claim-notice-${createHash('sha256').update(sentKey).digest('hex').slice(0, 24)}`),
  state: 'sent', channel: 'C00000000', thread: '1700000000.000100', ts: `${Math.floor(Number(receiptTs))}.000200` }] }) as never;

function seed(dir: string, opts: { bindings?: string; prev?: 'known' | 'corrupt' | 'absent' } = {}) {
  const p = claimNoticePaths(dir);
  writeFileSync(p.bindings, opts.bindings ??
    `${JSON.stringify({ v: 1, claimId: claim.id, repo: claim.repo, threadKey, pr: 1, head: 'abcdef1' })}\n`, { mode: 0o600 });
  appendClaimNoticeSent(p.sent, sentKey, now - 5000);
  const prev = opts.prev ?? 'known';
  if (prev === 'known') writeClaimNoticePrev(p.prev, { state: 'known', claims: [], messages: [], asOf: now - 60_000 });
  else if (prev === 'corrupt') writeFileSync(p.prev, '{not json', { mode: 0o600 });
}
const read = (dir: string, extra: Record<string, unknown> = {}) => {
  const nowFn = vi.fn(() => now);
  return readClaimNoticeView({ runsRoot: dir, now: nowFn, readBoard: () => board(), readConfig: cfg,
    readSendReceipts: receipts, ...extra }).then(view => ({ view, nowFn }));
};

describe('pending observation (565s)', () => {
  it('healthy empty is known, not unknown', async () => {
    const dir = mk(); seed(dir); const before = bytes(dir);
    const { view } = await read(dir, { readBoard: () => board([]) });
    expect(view.pending).toEqual([]);
    expect(view.pendingObservation).toEqual({ state: 'known' });
    expect(bytes(dir)).toEqual(before);
  });

  it('absent prev snapshot is a baseline, known', async () => {
    const dir = mk(); seed(dir, { prev: 'absent' });
    expect((await read(dir)).view.pendingObservation).toEqual({ state: 'known' });
  });

  it('known non-empty pending is reported', async () => {
    const dir = mk(); seed(dir);
    const { view } = await read(dir);
    expect(view.pendingObservation).toEqual({ state: 'known' });
    expect(view.pending).toHaveLength(1);
  });

  it.each([
    ['corrupt prev snapshot', (d: string) => seed(d, { prev: 'corrupt' }), 'prev-unavailable', {}],
    ['bindings outage', (d: string) => { seed(d); chmodSync(claimNoticePaths(d).bindings, 0o000); }, 'bindings-unavailable', {}],
    ['throwing board reader', (d: string) => seed(d), 'board-unavailable',
      { readBoard: () => { throw new Error('fake outage http://fake.invalid'); } }],
    ['unknown board', (d: string) => seed(d), 'board-unavailable',
      { readBoard: () => ({ ...board(), state: 'unreadable' }) }],
  ])('%s is unknown with a fixed reason', async (_n, setup, reason, extra) => {
    const dir = mk(); setup(dir); const before = bytes(dir);
    const { view, nowFn } = await read(dir, extra);
    if (view.pendingObservation.state === 'known') throw new Error('expected unknown');
    expect(view.pendingObservation).toEqual({ state: 'unknown', reason });
    expect(view.pending).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('fake.invalid');
    expect(view.generatedAt).toBe(new Date(now).toISOString());
    expect(nowFn).toHaveBeenCalledTimes(1);
    expect(bytes(dir)).toEqual(before);
  });

  it('missing state directory is unknown (nothing observed)', async () => {
    const { view } = await read(join(mk(), 'absent'));
    expect(view).toMatchObject({ source: 'missing', pendingObservation: { state: 'unknown', reason: 'state-missing' } });
  });

  it('keeps exact Slack receipt classification during a pending outage', async () => {
    const dir = mk(); seed(dir, { prev: 'corrupt' });
    const { view } = await read(dir);
    expect(view.pendingObservation.state).toBe('unknown');
    expect(view.sent.recent).toEqual([{ state: 'VERIFIED', claimId: claim.id, at: now - 5000, delivery: 'slack-sent' }]);
    const degraded = await read(dir, { readSendReceipts: () => ({ state: 'degraded', receipts: [] }) });
    expect(degraded.view.sent.recent[0]!.delivery).toBe('unknown');
  });

  it('recovers with a newly constructed reader once state is repaired', async () => {
    const dir = mk(); seed(dir, { prev: 'corrupt' });
    expect((await read(dir)).view.pendingObservation.state).toBe('unknown');
    writeClaimNoticePrev(claimNoticePaths(dir).prev, { state: 'known', claims: [], messages: [], asOf: now - 1 });
    expect((await read(dir, { readBoard: () => board([]) })).view.pendingObservation).toEqual({ state: 'known' });
  });
});
