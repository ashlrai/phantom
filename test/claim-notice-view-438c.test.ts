import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendClaimNoticeSent, claimNoticePaths, writeClaimNoticePrev } from '../src/core/fleet/claim-notice-send.js';
import { parseClaimNoticeKey, readClaimNoticeView } from '../src/core/fleet/claim-notice-view.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const claim = { id: 'claim-fake-1', repo: 'ashlrai/phantom', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 3_600_000 };
const threadKey = 'T00000000/C00000000/1700000000.000100';
const board = (): FleetBoard =>
  ({ schema: 'fleet.coordination.v1', state: 'known', claims: [claim], messages: [], proposals: [], expiredClaims: 0 });
const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'claim-view-')); chmodSync(d, 0o700); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).map(name => {
  const p = join(dir, name); return [name, { bytes: readFileSync(p, 'utf8'), mtime: statSync(p).mtimeMs }];
}));
const cfg = (state: 'ok' | 'missing', slack?: object) => () => ({ path: 'x', state, teamIdentities: [], slack }) as never;

function seed(dir: string) {
  const paths = claimNoticePaths(dir);
  writeFileSync(paths.bindings, `${JSON.stringify({ v: 1, claimId: claim.id, repo: claim.repo, threadKey, pr: 1, head: 'abcdef1' })}\n`, { mode: 0o600 });
  appendClaimNoticeSent(paths.sent, JSON.stringify(['VERIFIED', 'claim-old', 'abc']), now - 5000);
  appendClaimNoticeSent(paths.sent, 'not-json', now - 4000);
  appendClaimNoticeSent(paths.sent, JSON.stringify(['RELEASED', claim.repo, 'claim-two', 'abc']), now - 3000);
  appendClaimNoticeSent(paths.sent, JSON.stringify(['BLOCKED', claim.repo, 'claim-three', 'agent', 5, 'abc']), now - 2000);
  writeClaimNoticePrev(paths.prev, { state: 'known', claims: [], messages: [], asOf: now - 60_000 });
}

describe('readClaimNoticeView', () => {
  it('reports counts, recent rows newest-first and dry-run pending without writing', async () => {
    const dir = mk(); seed(dir);
    const before = snapshot(dir);
    const view = await readClaimNoticeView({ runsRoot: dir, now: () => now, readBoard: board,
      readConfig: cfg('ok', { teamId: 'T00000000' }) });
    expect(view).toMatchObject({ v: 1, source: 'ok', bindings: 1, slackConfigured: true });
    expect(view.sent.total).toBe(4);
    expect(view.sent.recent).toEqual([
      { state: 'BLOCKED', claimId: 'claim-three', at: now - 2000, delivery: 'unknown' },
      { state: 'RELEASED', claimId: 'claim-two', at: now - 3000, delivery: 'unknown' },
      { state: 'VERIFIED', claimId: 'claim-old', at: now - 5000, delivery: 'unknown' },
    ]);
    expect(view.pending).toHaveLength(1);
    expect(view.pending[0]).toMatchObject({ state: 'ASSIGNED', threadKey });
    expect(view.pending[0]!.text).toContain('claim-fake-1');
    expect(snapshot(dir)).toEqual(before);
  });

  it('caps rows and text', async () => {
    const dir = mk(); seed(dir);
    const paths = claimNoticePaths(dir);
    for (let i = 0; i < 30; i++) appendClaimNoticeSent(paths.sent, JSON.stringify(['ASSIGNED', `c${i}`, 't']), now + i);
    const view = await readClaimNoticeView({ runsRoot: dir, now: () => now, readBoard: board, readConfig: cfg('missing') });
    expect(view.sent.recent).toHaveLength(20);
    expect(view.sent.total).toBe(34);
    expect(view.slackConfigured).toBe(false);
  });

  it('returns missing for an absent directory', async () => {
    const view = await readClaimNoticeView({ runsRoot: join(mk(), 'nope'), now: () => now, readBoard: board, readConfig: cfg('missing') });
    expect(view).toMatchObject({ source: 'missing', bindings: 0, sent: { total: 0, recent: [] }, pending: [] });
  });

  it('returns unreadable for a corrupt sent ledger', async () => {
    const dir = mk(); seed(dir);
    writeFileSync(claimNoticePaths(dir).sent, '{"v":1,"at":1,"key":"a"}\n{torn', { mode: 0o600 });
    const before = snapshot(dir);
    const view = await readClaimNoticeView({ runsRoot: dir, now: () => now, readBoard: board, readConfig: cfg('missing') });
    expect(view).toMatchObject({ source: 'unreadable', sent: { total: 0, recent: [] }, pending: [] });
    expect(snapshot(dir)).toEqual(before);
  });

  it('parses dedupe keys only by known shapes', () => {
    expect(parseClaimNoticeKey('["ASSIGNED","c1","t"]')).toEqual({ state: 'ASSIGNED', claimId: 'c1' });
    expect(parseClaimNoticeKey('["ASSIGNED","r","c1","t"]')).toEqual({ state: 'ASSIGNED', claimId: 'c1', repo: 'r' });
    expect(parseClaimNoticeKey('["ASSIGNED","c1"]')).toBeNull();
    expect(parseClaimNoticeKey('{"a":1}')).toBeNull();
    expect(parseClaimNoticeKey('nope')).toBeNull();
  });
});
