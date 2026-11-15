import { describe, expect, it } from 'vitest';
import { buildStatusDigest, TOP_P0_MAX_CHARS, type StatusDigestInput } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput, inboxAtMs, isHardLimitAsk } from '../src/core/leader/status-digest-sources.js';

const ok = <T>(value: T) => ({ ok: true as const, value });
const no = (reason: string) => ({ ok: false as const, reason });
const known: StatusDigestInput = {
  installedVersion: ok('3.29.15'), publishedVersion: ok('3.30.32'), updatePending: true,
  mergesLastHour: ok(3), mergesLast24h: ok(41),
  lanes: ok([
    { lane: 'claude', running: 4, target: 8, held: false, heldReason: null },
    { lane: 'idle', running: 0, target: 0, held: false, heldReason: null },
    { lane: 'codex-cmp', running: 0, target: 0, held: true, heldReason: 'usage limit' },
  ]),
  needsMason: ok(2), topP0: ok({ text: 'Phantom status', ageMs: 12 * 60_000 }),
};

describe('buildStatusDigest', () => {
  it('renders the five lines from known values', () => {
    expect(buildStatusDigest(known)).toEqual([
      'App: installed 3.29.15 · published 3.30.32 · update pending',
      'Merges: 3 in the last hour · 41 in the last 24h',
      'Lanes: claude 4/8 · held: codex-cmp (usage limit)',
      'Needs Mason: 2 hard-limit asks waiting',
      'Top P0: Phantom status (12m ago)',
    ]);
  });

  it('says unknown with the reason for every unreadable input, never 0', () => {
    const lines = buildStatusDigest({
      installedVersion: no('plist unreadable'), publishedVersion: no('gh offline'), updatePending: null,
      mergesLastHour: no('merge count incomplete'), mergesLast24h: no('merge count incomplete'),
      lanes: no('runs dir missing'), needsMason: no('file unreadable'), topP0: no('inbox unreadable'),
    });
    expect(lines).toEqual([
      'App: installed unknown (plist unreadable) · published unknown (gh offline)',
      'Merges: unknown (merge count incomplete) · unknown (merge count incomplete)',
      'Lanes: unknown (runs dir missing)',
      'Needs Mason: unknown (file unreadable)',
      'Top P0: unknown (inbox unreadable)',
    ]);
    expect(lines.join('\n')).not.toMatch(/\b0\b/);
  });

  it('distinguishes genuine zero, none and up-to-date from unknown', () => {
    const lines = buildStatusDigest({ ...known, updatePending: false, mergesLastHour: ok(0), lanes: ok([]), needsMason: ok(0), topP0: ok(null) });
    expect(lines[0]).toContain('up to date');
    expect(lines[1]).toBe('Merges: 0 in the last hour · 41 in the last 24h');
    expect(lines[2]).toBe('Lanes: no lane has a target');
    expect(lines[3]).toBe('Needs Mason: none waiting');
    expect(lines[4]).toBe('Top P0: none in the inbox');
  });

  it('truncates the top P0 to 120 chars and keeps an unknown age honest', () => {
    const line = buildStatusDigest({ ...known, topP0: ok({ text: `${'status words '.repeat(20)}\n  tail`, ageMs: null }) })[4]!;
    const text = line.slice('Top P0: '.length, line.indexOf(' (age unknown)'));
    expect(text).toHaveLength(TOP_P0_MAX_CHARS);
    expect(text.endsWith('…')).toBe(true);
    expect(line.endsWith('(age unknown)')).toBe(true);
  });

  it('names a held lane with no recorded reason', () => {
    const line = buildStatusDigest({ ...known, lanes: ok([{ lane: 'zai', running: 0, target: 3, held: true, heldReason: null }]) })[2];
    expect(line).toBe('Lanes: held: zai (no reason recorded)');
  });
});

describe('gatherStatusDigestInput', () => {
  const now = new Date('2026-11-10T20:00:00Z');
  const shipped = (...n: string[]) => ({ shipped: n.map(text => ({ text })), mergeCountUnavailable: false });
  const base = {
    installedVersion: () => '3.29.15', publishedVersion: async () => '3.30.32',
    mergeFacts: async () => shipped('ashlrai/phantom#1: a', 'ashlrai/ashlr-hub#2: b', 'ashlrai/phantom#3'),
    runsState: async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never, lanes: [{ lane: 'claude', running: 1, target: 2, held: false, heldReason: null, queued: 0, floor: null, ceiling: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }] }),
    needs: () => ({ status: 'available', items: [{ text: 'rotate the Stripe API key' }, { text: 'review the docs wording' }] }),
    inbox: async () => ({ sourceState: 'healthy', entries: [{ at: '2026-11-10 14:48', source: 'Slack', priority: 'P0', text: 'Phantom status' }, { at: '2026-11-10 09:00', source: 'x', priority: 'P0', text: 'older' }] }),
  };

  it('counts only phantom merges, only hard-limit asks, and the newest P0 with its age', async () => {
    const input = await gatherStatusDigestInput('/r', now, base);
    expect(input.mergesLastHour).toEqual(ok(2));
    expect(input.needsMason).toEqual(ok(1));
    expect(input.updatePending).toBe(true);
    expect(input.topP0).toEqual(ok({ text: 'Phantom status', ageMs: 12 * 60_000 }));
    expect(input.lanes).toEqual(ok([{ lane: 'claude', running: 1, target: 2, held: false, heldReason: null }]));
  });

  it('turns throwing or self-declared unavailable readers into unknown facts', async () => {
    const boom = async () => { throw new Error('secret-path /Users/x'); };
    const input = await gatherStatusDigestInput('/r', now, {
      installedVersion: () => null, publishedVersion: boom, mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: true }),
      runsState: async () => ({ runsDirPresent: false, sources: { status: 'missing' } as never, lanes: [] }),
      needs: () => ({ status: 'unavailable', items: [] }), inbox: async () => ({ sourceState: 'degraded', entries: [] }),
    });
    for (const key of ['installedVersion', 'publishedVersion', 'mergesLastHour', 'mergesLast24h', 'lanes', 'needsMason', 'topP0'] as const) expect(input[key].ok).toBe(false);
    expect(input.updatePending).toBeNull();
    expect(JSON.stringify(input)).not.toContain('/Users/x');
  });
});

describe('helpers', () => {
  it('classifies hard-limit asks only', () => {
    for (const t of ['Need the Stripe API key', 'approve $200 payment', 'delete the prod database', 'send an email to the customer']) expect(isHardLimitAsk(t)).toBe(true);
    for (const t of ['review the docs wording', 'pick a release name']) expect(isHardLimitAsk(t)).toBe(false);
  });
  it('reads Eastern inbox stamps across DST', () => {
    expect(inboxAtMs('2026-11-10 14:48')).toBe(Date.parse('2026-11-10T19:48:00Z'));
    expect(inboxAtMs('2026-07-01 10:00')).toBe(Date.parse('2026-07-01T14:00:00Z'));
    expect(inboxAtMs('garbage')).toBeNull();
  });
});
