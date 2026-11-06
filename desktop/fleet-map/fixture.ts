import type { FleetGraphSeed } from '../../src/core/graph/types.js';

export const fleetFixture: FleetGraphSeed = {
  schema: 'fleet.v1',
  agents: [{ id: 'producer', mcpIds: ['locus'] }, { id: 'reviewer' }],
  mcp: [{ id: 'locus' }],
  edges: [{ kind: 'reviews', from: 'reviewer', to: 'producer' }],
};
export type FleetStatus = 'active' | 'idle' | 'offline' | 'unknown';
// Fixture telemetry is separate: fleet.v1 inventory does not assert health.
export const fixtureStatuses: Record<string, FleetStatus> = {
  'agent:producer': 'active', 'agent:reviewer': 'idle', 'mcp:locus': 'offline',
};
