/** Fixtures for the Capacity board's usage window: a pools.v1 view made by the real builder, at a fixed clock. */
import { buildPoolsView, type PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';

export const NOW = Date.parse('2026-11-17T12:00:00.000Z');
export const at = (hours: number): string => new Date(NOW + hours * 3_600_000).toISOString();

export const poolLane = (name: string, patch: Partial<ResourceLaneRow> = {}, asOfHours = -0.1): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(84),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage', asOf: at(asOfHours) }, ...patch,
});

export const poolsView = (...lanes: ResourceLaneRow[]): PoolsViewV1 => buildPoolsView({ v: 1, generatedAt: at(0), asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' } } satisfies ResourceLedgerV1, NOW);
