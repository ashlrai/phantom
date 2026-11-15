/** Role slots resolve by capability fit, live availability and cost; no model is bound to a role. */
import { describe, expect, it } from 'vitest';

import type { SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import {
  claimLease, decideLeadership, heartbeatLease, leaseState, releaseLease, DEFAULT_LEASE_TTL_MS,
  type LeaseHolder,
} from '../src/core/routing/role-lease.js';
import { failoverRole, resolveRole, ROLE_SLOTS, type RoleResolveInput } from '../src/core/routing/role-slots.js';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const OBSERVED = new Date(NOW - 60_000).toISOString();

function paid(id: string, engine: SeatCapacity['engine'], used: number, ctx = 200_000): SeatCapacity {
  return {
    seatId: id, engine, label: id, free: false, signedOut: false, reachable: null, contextWindow: ctx,
    observedAt: OBSERVED, spentTodayUsd: null,
    windows: [{ id: 'weekly', usedPercent: used, resetsAt: '2026-11-12T00:00:00.000Z', resetDescription: null, limitReached: used >= 100 }],
  };
}
const local = (ctx: number): SeatCapacity => ({
  seatId: 'local:qwen', engine: 'local', label: 'local:qwen', free: true, windows: [], signedOut: false,
  reachable: true, contextWindow: ctx, observedAt: OBSERVED, spentTodayUsd: null,
});

function input(over: Partial<RoleResolveInput> = {}): RoleResolveInput {
  return {
    role: 'leader',
    capacities: [paid('claude', 'claude', 10), paid('codex', 'codex', 10), paid('grok', 'grok', 10), local(65_536)],
    policy: defaultBudgetPolicy(),
    opts: { nowMs: NOW },
    ...over,
  };
}

describe('resolveRole', () => {
  it('lets every engine hold every slot', () => {
    for (const role of ROLE_SLOTS) {
      for (const engine of ['claude', 'codex', 'grok'] as const) {
        const r = resolveRole(input({ role, capacities: [paid(engine, engine, 10)] }));
        expect(r.lane?.seatId).toBe(engine);
      }
      expect(resolveRole(input({ role, capacities: [local(65_536)] })).lane?.seatId).toBe('local:qwen');
    }
  });

  it('treats hints as preference only: honored when eligible, yielded when not', () => {
    const hints = { leader: { engines: ['grok' as const] } };
    const honored = resolveRole(input({ hints }));
    expect(honored.lane?.seatId).toBe('grok');
    expect(honored.hintHonored).toBe(true);

    const spent = input({ hints, capacities: [paid('claude', 'claude', 10), paid('grok', 'grok', 100)] });
    const yielded = resolveRole(spent);
    expect(yielded.lane?.seatId).toBe('claude');
    expect(yielded.hintHonored).toBe(false);
    expect(yielded.candidates.map((c) => c.seatId)).not.toContain('grok');
    expect(yielded.why).toContain('hint yielded');
  });

  it('matches hints by model substring and seat id, in order', () => {
    const r = resolveRole(input({ hints: { leader: { models: ['qwen'], seatIds: ['codex'] } } }));
    expect(r.candidates.slice(0, 2).map((c) => c.seatId)).toEqual(['local:qwen', 'codex']);
  });

  it('applies the context floor per role', () => {
    const small = local(8_000);
    const r = resolveRole(input({ capacities: [small, paid('claude', 'claude', 10)] }));
    expect(r.lane?.seatId).toBe('claude');
    expect(r.exclusions.find((e) => e.seatId === 'local:qwen')).toBeTruthy();
  });

  it('excludes lanes that declare capabilities without the required ones, but not undeclared lanes', () => {
    const r = resolveRole(input({
      capabilities: { claude: ['reasoning'], codex: ['tools', 'reasoning'] },
    }));
    const ids = r.candidates.map((c) => c.seatId);
    expect(ids).not.toContain('claude');
    expect(ids).toContain('codex');
    expect(ids).toContain('grok');
  });

  it('fails over when the leading lane exhausts and reports no lane when all are spent', () => {
    const first = resolveRole(input());
    const next = failoverRole(input(), first.lane!.seatId);
    expect(next.lane?.seatId).not.toBe(first.lane?.seatId);
    expect(next.exclusions.find((e) => e.seatId === first.lane!.seatId)).toBeTruthy();

    const none = resolveRole(input({ capacities: [paid('claude', 'claude', 100), paid('grok', 'grok', 100)] }));
    expect(none.lane).toBeNull();
    expect(none.why).toContain('No lane can hold');
  });

  it('is deterministic', () => {
    expect(resolveRole(input())).toEqual(resolveRole(input()));
  });
});

describe('role lease', () => {
  const a: LeaseHolder = { agentId: 'a', seatId: 'claude' };
  const b: LeaseHolder = { agentId: 'b', seatId: 'grok' };

  it('grants, refuses a rival while live, and allows takeover after expiry', () => {
    const first = claimLease(null, 'leader', a, NOW);
    if (!first.ok) throw new Error('expected claim');
    expect(first.lease.epoch).toBe(1);
    const rival = claimLease(first.lease, 'leader', b, NOW + 1_000);
    expect(rival.ok).toBe(false);

    const late = NOW + DEFAULT_LEASE_TTL_MS + 1;
    expect(leaseState(first.lease, late)).toBe('expired');
    const took = claimLease(first.lease, 'leader', b, late);
    if (!took.ok) throw new Error('expected takeover');
    expect(took.takeover).toBe(true);
    expect(took.lease.epoch).toBe(2);
    expect(took.lease.holder).toEqual(b);
  });

  it('fences a stale holder after takeover', () => {
    const first = claimLease(null, 'leader', a, NOW);
    if (!first.ok) throw new Error();
    const took = claimLease(first.lease, 'leader', b, NOW + DEFAULT_LEASE_TTL_MS + 1);
    if (!took.ok) throw new Error();
    expect(heartbeatLease(took.lease, 'a', 1, NOW + DEFAULT_LEASE_TTL_MS + 2)).toEqual({ ok: false, reason: 'lost' });
    expect(heartbeatLease(took.lease, 'b', 2, NOW + DEFAULT_LEASE_TTL_MS + 2).ok).toBe(true);
  });

  it('heartbeat extends a live lease and release vacates only for the holder', () => {
    const first = claimLease(null, 'leader', a, NOW);
    if (!first.ok) throw new Error();
    const beat = heartbeatLease(first.lease, 'a', 1, NOW + 60_000);
    if (!beat.ok) throw new Error();
    expect(leaseState(beat.lease, NOW + 120_000)).toBe('live');
    expect(releaseLease(beat.lease, 'b', 1)).toBe(beat.lease);
    expect(leaseState(releaseLease(beat.lease, 'a', 1), NOW)).toBe('vacant');
  });

  it('decides renew, yield, claim, follow and stand-by from the resolution', () => {
    const res = resolveRole(input({ capacities: [paid('claude', 'claude', 10), paid('grok', 'grok', 10)] }));
    const held = claimLease(null, 'leader', a, NOW);
    if (!held.ok) throw new Error();
    expect(decideLeadership(held.lease, a, res, NOW + 1)).toEqual({ kind: 'renew' });
    expect(decideLeadership(held.lease, b, res, NOW + 1)).toEqual({ kind: 'follow', holder: a });
    expect(decideLeadership(held.lease, b, res, NOW + DEFAULT_LEASE_TTL_MS + 1)).toEqual({ kind: 'claim', takeover: true });
    expect(decideLeadership(null, a, res, NOW)).toEqual({ kind: 'claim', takeover: false });

    const aSpent = resolveRole(input({ capacities: [paid('claude', 'claude', 100), paid('grok', 'grok', 10)] }));
    expect(decideLeadership(held.lease, a, aSpent, NOW + 1).kind).toBe('yield');
    expect(decideLeadership(null, a, aSpent, NOW).kind).toBe('stand-by');
  });
});
