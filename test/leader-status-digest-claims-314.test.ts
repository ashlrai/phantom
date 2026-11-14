/**
 * RQ-PHX-STATUSCLAIMSLINE314: the status reply's sixth line is a fresh read of
 * the durable bus claims table (inspectBusWorkClaims), honouring the same
 * Fact<T> contract as the other lines: value, "none recorded" when no claims
 * table exists, and "unknown (reason)" when the table cannot be read — never a
 * fabricated 0. When StatusDigestInput.workClaims is absent the digest is
 * byte-identical to the original five lines. Fake owners only; the claims
 * table is seeded through the real appendBusInbox/mutateBusWorkClaim path in a
 * tmp root, never the real ~/.ashlr.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatusDigest, type StatusDigestInput } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput, type StatusDigestSources } from '../src/core/leader/status-digest-sources.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

const ok = <T>(value: T) => ({ ok: true as const, value });
const no = (reason: string) => ({ ok: false as const, reason });

/** 2026-11-10 20:00Z is 15:00 Eastern (EST). */
const T0 = Date.parse('2026-11-10T20:00:00Z');

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
const FIVE = [
  'App: installed 3.29.15 · published 3.30.32 · update pending',
  'Merges: 3 in the last hour · 41 in the last 24h',
  'Lanes: claude 4/8 · held: codex-cmp (usage limit)',
  'Needs Mason: 2 hard-limit asks waiting',
  'Top P0: Phantom status (12m ago)',
];

const lane = { lane: 'claude', running: 1, target: 2, held: false, heldReason: null, queued: 0, floor: null, ceiling: null, tokensLastHour: null, merged24h: null, mergeRate24h: null };
/** Deterministic stand-ins for the other five readers; only the claims seam varies. */
const fakes = (): StatusDigestSources => ({
  installedVersion: () => '3.29.15',
  publishedVersion: async () => '3.30.32',
  mergeFacts: async () => ({ shipped: [{ text: 'ashlrai/phantom#1: a' }], mergeCountUnavailable: false }),
  runsState: async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never, lanes: [lane] }),
  needs: () => ({ status: 'available', items: [] }),
  inbox: async () => ({ sourceState: 'healthy', entries: [] }),
  workClaims: () => ({ source: 'missing', claims: [] }),
});

describe('buildStatusDigest claims line', () => {
  it('returns the identical five lines when workClaims is absent', () => {
    expect(buildStatusDigest(known)).toEqual(FIVE);
  });

  it('appends the counts and an Eastern as-of clock for a live table', () => {
    const lines = buildStatusDigest({ ...known, workClaims: ok({ live: 3, completed: 5, expired: 1, owners: 2, asOfMs: T0 }) });
    expect(lines).toEqual([...FIVE, 'Claims: 3 live (2 owners) · 5 completed · 1 expired · as of 15:00 ET, source bus claims']);
  });

  it('singularises a single live owner and renders zero buckets honestly', () => {
    const lines = buildStatusDigest({ ...known, workClaims: ok({ live: 1, completed: 0, expired: 0, owners: 1, asOfMs: T0 }) });
    expect(lines[5]).toBe('Claims: 1 live (1 owner) · 0 completed · 0 expired · as of 15:00 ET, source bus claims');
  });

  it('says none recorded when there is no claims table, never a fabricated 0', () => {
    const lines = buildStatusDigest({ ...known, workClaims: ok(null) });
    expect(lines).toEqual([...FIVE, 'Claims: none recorded (no claims table)']);
  });

  it('says unknown with the reason for an unreadable table', () => {
    const lines = buildStatusDigest({ ...known, workClaims: no('bus claims table could not be read') });
    expect(lines).toEqual([...FIVE, 'Claims: unknown (bus claims table could not be read)']);
  });
});

describe('gatherStatusDigestInput workClaims', () => {
  let root: string;
  let now: number;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'status-claims-314-'));
    now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  /** Real appendBusInbox + mutateBusWorkClaim, fake ids and owners. */
  const acquire = (id: string, owner: string, leaseMs: number) => {
    expect(appendBusInbox({ id, from: 'fake', to: 'worker', priority: 'P1', ttl: 600_000, body: { kind: 'work', text: 'fake payload' } },
      { root, now: () => now }).status).toBe('posted');
    const result = mutateBusWorkClaim({ action: 'acquire', id, owner, leaseMs, root });
    expect(result.status).toBe('acquired');
    return result;
  };

  it('counts the real claims table at a tmp root: one live, one completed, one expired', async () => {
    const acquired = acquire('job-314-live', 'worker-a', 60_000);
    const done = acquire('job-314-done', 'worker-a', 60_000);
    expect(mutateBusWorkClaim({ action: 'complete', id: 'job-314-done', token: done.token!, root }).status).toBe('completed');
    acquire('job-314-lapsed', 'worker-b', 1_000);
    now += 2_000; // past the 1s lease, inside the 60s lease and the 600s receipt TTL

    const input = await gatherStatusDigestInput('/r', new Date(now), { ...fakes(), workClaims: () => inspectBusWorkClaims(root) });
    expect(input.workClaims).toEqual(ok({ live: 1, completed: 1, expired: 1, owners: 1, asOfMs: now }));
    const lines = buildStatusDigest(input);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('Claims: 1 live (1 owner) · 1 completed · 1 expired · as of 15:00 ET, source bus claims');
    // Fencing tokens and claim internals never reach the reply.
    expect(lines.join('\n')).not.toContain(acquired.token!);
    expect(lines.join('\n')).not.toMatch(/\b[a-f0-9]{64}\b/);
  });

  it('reports the missing table as none recorded, not zero', async () => {
    const input = await gatherStatusDigestInput('/r', new Date(now), { ...fakes(), workClaims: () => inspectBusWorkClaims(root) });
    expect(input.workClaims).toEqual(ok(null));
    expect(buildStatusDigest(input)[5]).toBe('Claims: none recorded (no claims table)');
  });

  it('turns an unavailable table into the unknown fact with the fixed reason', async () => {
    const input = await gatherStatusDigestInput('/r', new Date(now), { ...fakes(), workClaims: () => ({ source: 'unavailable', claims: [] }) });
    expect(input.workClaims).toEqual(no('bus claims table could not be read'));
    expect(buildStatusDigest(input)[5]).toBe('Claims: unknown (bus claims table could not be read)');
  });

  it('turns a throwing reader into the unknown fact and never leaks its message', async () => {
    const input = await gatherStatusDigestInput('/r', new Date(now), {
      ...fakes(),
      workClaims: () => { throw new Error('secret-marker-314 /private/claims-path'); },
    });
    expect(input.workClaims).toEqual(no('bus claims table could not be read'));
    const text = buildStatusDigest(input).join('\n');
    expect(text).toContain('Claims: unknown (bus claims table could not be read)');
    expect(text).not.toContain('secret-marker-314');
    expect(text).not.toContain('/private');
  });

  it('keeps exactly the five original lines when the source is overridden to undefined', async () => {
    const input = await gatherStatusDigestInput('/r', new Date(now), { ...fakes(), workClaims: undefined });
    expect(input.workClaims).toBeUndefined();
    expect(buildStatusDigest(input)).toHaveLength(5);
  });
});
