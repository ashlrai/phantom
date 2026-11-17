/** RQ-PHX-SLACKOWNERSASK386: exact "owners" ask in the Slack Leader thread. Fake values only. */
import { describe, expect, it, vi } from 'vitest';
import { isOwnersAsk } from '../src/core/fleet/owners-ask.js';
import { isStatusAsk } from '../src/core/fleet/status-ask.js';
import { isRecheckAsk } from '../src/core/fleet/recheck-ask.js';
import { isOrdersAsk } from '../src/core/fleet/orders-ask.js';
import { isReviewAsk } from '../src/core/fleet/review-ask.js';
import { formatSurfaceOwnersReply } from '../src/core/fleet/surface-owners-reply.js';
import { SURFACES, type SurfaceOwnerReport } from '../src/core/fleet/surface-owner.js';
import {
  composeOwnerOwnersReply, defaultOwnersReply, OWNER_OWNERS_FALLBACK, ownerStatusReply,
} from '../src/core/agents/owner-status-reply.js';

const NOW = new Date('2026-11-14T19:30:00.000Z');
const ASOF = NOW.toISOString();
const rep = (over: Partial<SurfaceOwnerReport> = {}): SurfaceOwnerReport => ({
  schemaVersion: 1, authority: 'none', surface: 'fake-surface', asOf: ASOF, owner: 'UNKNOWN', ownerSource: 'none',
  liveClaims: [], lastLanded: null, scannedPaths: [], reasons: [], ...over,
});
const single = (agent: string): SurfaceOwnerReport => rep({
  owner: agent, ownerSource: 'advisory-claim', liveClaims: [{ id: 'c1', agent, expiresInSeconds: 601 }],
});

describe('isOwnersAsk', () => {
  it.each(['owners', 'owner', 'who owns', 'bridge owners', 'who owns the bridge', 'Owners?', 'Who owns the bridge!', "who’s the owner", '  OWNER. '])(
    'accepts %s', t => expect(isOwnersAsk(t)).toBe(true));
  it.each(['owners of PR #12 please', 'status', 'review', 'orders', 'recheck', 'x'.repeat(41), '', 'who owns the bridge and why'])(
    'rejects %s', t => expect(isOwnersAsk(t)).toBe(false));
  it('never overlaps another exact ask', () => {
    for (const t of ['owners', 'owner', 'who owns', 'bridge owners', 'who owns the bridge', 'status', 'review', 'orders', 'recheck', 'glance']) {
      const hits = [isOwnersAsk, isStatusAsk, isRecheckAsk, isOrdersAsk, isReviewAsk].filter(f => f(t)).length;
      expect(hits).toBe(1);
    }
  });
});

describe('formatSurfaceOwnersReply', () => {
  it('formats single owner, none, contested and UNKNOWN', () => {
    const out = formatSurfaceOwnersReply([
      { ...single('fake-agent'), surface: 'a' },
      rep({ surface: 'b', lastLanded: { jobId: 'RQ-FAKE-1', pr: 77, date: '2026-11-10T00:00:00Z', path: 'p' } }),
      rep({ surface: 'c', liveClaims: [
        { id: 'x', agent: 'a1', expiresInSeconds: 60 }, { id: 'y', agent: 'a2', expiresInSeconds: 60 }] }),
      rep({ surface: 'd', reasons: ['coordination ledger: missing or unreadable'] }),
    ], ASOF).split('\n');
    expect(out).toEqual([
      `Phantom owners, as of ${ASOF}`,
      'a: fake-agent (advisory claim, expires in 11m)',
      'b: no live owner — last landed RQ-FAKE-1 #77 2026-11-10',
      'c: 2 live claims, contested',
      'd: UNKNOWN (coordination ledger: missing or unreadable)',
      'Claims are advisory; this reply assigns nothing.',
    ]);
  });
  it('scrubs paths and control chars', () => {
    const out = formatSurfaceOwnersReply([single('/Users/fake/x'), single('ok\u001b[31mred')], ASOF);
    expect(out).not.toContain('/Users/fake');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('[31m');
  });
  it('caps at 900 chars and keeps the footer', () => {
    const reports = Array.from({ length: 40 }, (_, i) => ({ ...single('fake-agent-with-long-name'), surface: `surface-number-${i}` }));
    const out = formatSurfaceOwnersReply(reports, ASOF);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out).toContain('…');
    expect(out.endsWith('Claims are advisory; this reply assigns nothing.')).toBe(true);
  });
});

describe('ownerStatusReply owners branch', () => {
  const fail = () => { throw new Error('wrong seam'); };
  it('asks and composes through the seam', async () => {
    const owners = vi.fn(async () => 'FAKE OWNERS');
    const r = ownerStatusReply({ owners });
    expect(r.ask('owners')).toBe(true);
    expect(await r.compose('/nonexistent/fake-runs', NOW, 'owners')).toBe('FAKE OWNERS');
    expect(owners).toHaveBeenCalledOnce();
  });
  it('falls back when the seam throws', async () => {
    const r = ownerStatusReply({ owners: async () => { throw new Error('boom'); } });
    expect(await r.compose('/nonexistent/fake-runs', NOW, 'owners')).toBe(OWNER_OWNERS_FALLBACK);
    expect(await composeOwnerOwnersReply(NOW, { owners: async () => { throw new Error('x'); } })).toBe(OWNER_OWNERS_FALLBACK);
  });
  it('review and status still reach their own seams', async () => {
    const owners = vi.fn(async () => 'FAKE OWNERS');
    const review = vi.fn(async () => 'FAKE REVIEW');
    const r = ownerStatusReply({
      owners, review, brief: async () => 'Morning leader brief\nfake digest', snapshot: async () => { throw new Error('x'); }, board: fail,
    });
    expect(await r.compose('/nonexistent/fake-runs', NOW, 'review')).toBe('FAKE REVIEW');
    expect(await r.compose('/nonexistent/fake-runs', NOW, 'status')).toContain('fake digest');
    expect(owners).not.toHaveBeenCalled();
  });
});

describe('defaultOwnersReply', () => {
  it('covers every SURFACES key, degrading null/throwing reads to UNKNOWN', async () => {
    const keys = Object.keys(SURFACES);
    const seen: string[] = [];
    const out = await defaultOwnersReply(NOW, { read: async s => {
      seen.push(s);
      if (s === keys[0]) return null;
      if (s === keys[1]) throw new Error('boom');
      return single('fake-agent');
    } });
    expect(seen.sort()).toEqual([...keys].sort());
    for (const k of keys) expect(out).toContain(`${k}:`);
    expect(out).toContain(`${keys[0]}: UNKNOWN`);
    expect(out.startsWith(`Phantom owners, as of ${ASOF}`)).toBe(true);
  });
});
