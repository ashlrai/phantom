import { expect, it } from 'vitest';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { narrowRuns } from './runs-graph-queries.js';

const fixture: FleetRunsV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 2, target: 4, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [{ job: 'job-1', repo: 'ashlrai/phantom', lane: 'codex', tier: 'frontier', ageSeconds: 42 }],
  leaders: [{ label: 'Fleet leader', ageSeconds: null }], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

it('maps live lane, worker and leader fields into the graph', () => {
  const runs = narrowRuns(fixture);
  expect(runs?.lanes).toEqual([{ id: 'codex', running: 2, target: 4 }]);
  expect(runs?.workers[0]).toMatchObject({ job: 'job-1', repo: 'ashlrai/phantom', lane: 'codex', model: 'frontier' });
  expect(runs?.leaders[0]?.name).toBe('Fleet leader');
});

it('accepts legacy lane ids and prefers explicitly reported models', () => {
  const runs = narrowRuns({ ...fixture, lanes: [{ id: 'legacy', running: 1, target: 3 }], workers: [{ ...fixture.workers[0], model: 'named-model' }] });
  expect(runs?.lanes).toEqual([{ id: 'legacy', running: 1, target: 3 }]);
  expect(runs?.workers[0]?.model).toBe('named-model');
});
