/**
 * fleet-runs-fixtures.test-support.ts — shared fixture for tests reading
 * GET /api/verse/fleet/runs (FleetRunsV1).  Plain functions, no test imports,
 * fully fake data, shallow-merge overrides.
 */
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';

/* ── helpers (exported) ─────────────────────────────────────────── */

export function fleetRunsFixture(overrides?: Partial<FleetRunsV1>): FleetRunsV1 {
  return {
    generatedAt: '2026-10-31T05:00:00.000Z',   v: 1,
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: '2026-10-31T05:00:00.000Z', paused: false, memFreePct: null, diskFreeGb: null,
    switches: ['run:restart', 'merge:flush'],
    lanes: [
      { lane: 'codex-personal', running: 3, target: 4, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: 12, mergeRate24h: 0.5 },
      { lane: 'devin',          running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h:  5, mergeRate24h: 0.3 },
    ],
    workers: [{ job: 'RQ-FAKE-JOB1', repo: 'fake/repo', lane: 'codex-personal', tier: 'mid', ageSeconds: 120 }],
    leaders: [{ label: 'fake-leader', ageSeconds: 60 }], orchestratorAgents: null,
    publishesLastHour: [{ job: 'RQ-FAKE-JOB1', lane: 'codex-personal', url: 'https://github.com/example/repo/pull/1', at: '2026-10-31T04:55:00.000Z' }],
    mergesLastHour: { count: 3, items: [{ repo: 'example/repo', number: 42, title: 'fake merge title' }] },
    events: [
      { at: '2026-10-31T04:58:00.000Z', kind: 'error', text: 'fake event text A' },
      { at: '2026-10-31T04:59:00.000Z', kind: 'merge:github-pull-request', text: 'https://github.com/example/repo/pull/1' },
    ],
    codexPersonal: { usedPct: 42, resetsAt: '2026-11-01T00:00:00.000Z', asOf: '2026-10-31T05:00:00.000Z' },
    inbox: [
      { at: '2026-10-31T04:57:00.000Z', source: 'Telegram', text: 'fake inbox message A' },
      { at: '2026-10-31T04:58:00.000Z', source: 'Phantom desktop', text: 'fake inbox message B' },
    ],
    drop: { pending: [], done: 3 },
    ...overrides,
  };
}

/* Lane helpers — replace by lane id, or append a new one. */

export function withLane(snapshot: FleetRunsV1, incoming: Partial<FleetRunsV1['lanes'][0]>): FleetRunsV1 {
  const idx = snapshot.lanes.findIndex(l => l.lane === incoming.lane);
  if (idx === -1) return { ...snapshot, lanes: [...snapshot.lanes, incoming as FleetRunsV1['lanes'][0]] };
  return { ...snapshot, lanes: snapshot.lanes.map((l, i) => (i === idx ? { ...l, ...incoming } as FleetRunsV1['lanes'][0] : l)) };
}

/* Worker helper — safely append a worker. */

export function withWorker(snapshot: FleetRunsV1, incoming: FleetRunsV1['workers'][0]): FleetRunsV1 {
  return { ...snapshot, workers: [...snapshot.workers, incoming] };
}

/* Source helper — mark exactly one source 'degraded'. */

export function degraded(snapshot: FleetRunsV1, source: keyof FleetRunsV1['sources'] = 'runsDir'): FleetRunsV1 {
  return { ...snapshot, sources: { ...snapshot.sources, [source]: 'degraded' } };
}
