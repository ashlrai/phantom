import type { OpsFleetV1, OpsRouteDecision } from '../../../../core/verse/ops-types.js';

const decision = (overrides: Partial<OpsRouteDecision>): OpsRouteDecision => ({
  at: '2026-10-31T12:00:00Z', itemId: 'one', taskId: null, repo: 'ashlrai/phantom', title: 'First',
  seatId: 'seat-a', lane: 'lane-a', dispatched: true, why: 'Ready', summary: null, candidates: ['a', 'b'], skipReason: null, ...overrides,
});
export const fixture = (): OpsFleetV1 => ({
  v: 1, generatedAt: '2026-10-31T12:00:00Z', tickAt: '2026-10-31T12:00:00Z', lanes: null,
  holdProduction: 'maintenance', held: [{ itemId: 'held', repo: 'ashlrai/phantom', title: 'Held task', holdKind: 'cooldown', reason: 'Waiting', nextEligibleAt: '2099-01-01T00:00:00Z', at: '2026-10-31T12:00:00Z' }],
  decisions: [decision({}), decision({ itemId: 'two', title: 'Second', at: '2026-10-31T14:00:00Z' }), decision({ itemId: 'three', title: 'Third', at: '2026-10-31T13:00:00Z', dispatched: false, lane: null, seatId: null, skipReason: 'No seat' })],
  experiments: [], sources: { tick: 'healthy', journal: 'healthy', learning: 'healthy' },
});
