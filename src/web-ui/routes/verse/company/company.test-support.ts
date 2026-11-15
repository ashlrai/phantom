import type { FleetLaneView, FleetSessionV1, FleetSessionsV1 } from '../../../data/api-types.js';

export const NOW = Date.now();
export const at = (seconds = 0) => new Date(NOW - seconds * 1000).toISOString();
export const session = (over: Partial<FleetSessionV1> = {}): FleetSessionV1 => ({
  job: 'RQ-A', lane: 'codex-personal', repo: 'ashlrai/phantom', tier: 'work', status: 'running', model: 'test-model',
  batchId: null, pid: null, live: 'yes', exitCode: null, timedOut: false, enqueuedAt: null, claimedAt: null,
  launchedAt: at(60), startedAt: at(60), finishedAt: null, elapsedSeconds: 60, durationSeconds: null,
  queueWaitSeconds: null, tokensTotal: null, wallSeconds: null, diffLines: null, outcome: null, prUrl: null, ...over,
});
export const sessions: FleetSessionsV1 = {
  schema: 'fleet.sessions.v1', generatedAt: at(), runsDirPresent: true, sourceState: 'healthy',
  sources: { runDir: 'healthy', ready: 'healthy', claimed: 'healthy', precheck: 'healthy', status: 'healthy', metrics: 'healthy', live: 'healthy' },
  dispatcher: { lastTick: at(), paused: false, tickAgeSeconds: 0 }, sessions: [session()],
  recent: [session({ job: 'RQ-DONE', status: 'finished', finishedAt: at(30), outcome: 'pr' }), session({ job: 'RQ-FAILED', status: 'finished', finishedAt: at(40), outcome: 'failed' })],
  counts: { queued: 0, parked: 0, launching: 0, running: 1, publishing: 0, exited: 0, stale: 0 }, malformed: 0, truncated: false,
};
export const lane: FleetLaneView = {
  lane: 'codex-personal', liveJobs: 1, queueDepth: 8, mergesPerHour: 3,
  hold: { held: false, reason: null, until: null, by: null, since: null },
  credit: { state: 'observed', label: '75% left', remainingPct: 75, remainingCredits: null, creditsUnit: null,
    resetAt: at(-3600), burnPerHour: null, projectedExhaustionAt: null, observedAt: at(15), source: 'budget-ledger' },
};
export function payloads(): Record<string, unknown> {
  return {
    '/api/fleet/sessions': sessions,
    '/api/fleet/lanes': { schema: 'fleet.lanes.v1', generatedAt: at(), lanes: [lane] },
    '/api/nodes': { schema: 'phantom.nodes.v1', generatedAt: at(), error: null, nodes: [
      { id: 'muse', role: 'worker', status: 'ready', heartbeatAt: at(10), liveJobs: ['RQ-A'] },
    ] },
    '/api/queue/stats?window=3600': { schemaVersion: 1, generatedAt: NOW, pools: [], stations: [{ station: 'READY', windows: [{
      windowMs: 3_600_000, arrivals: 4, departures: 6, lambda: 1, mu: 99, rho: null, queueLength: 8, wait: null, wip: 1, currentQueueLength: 8, currentWip: 1,
    }] }] },
    '/api/verse/fleet/runs/mission': {
      schema: 'fleet.mission.v1', generatedAt: at(), overview: { health: 'watch', headline: 'Shipping steadily; one lane needs attention.', shipped: '', attention: null, items: [] },
      jobs: [], decisions: [], resources: [], merges: [], mains: [], incidents: [], memory: { note: '' }, plan: { title: 'Make Phantom useful', points: [] },
    },
    '/api/verse/fleet/runs': {
      v: 1, generatedAt: at(), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
      lastTick: at(), paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [], workers: [], leaders: [],
      orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 3, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Company surface' }] },
      events: [], codexPersonal: null, inbox: [], drop: null,
    },
    '/api/verse/fleet/comms-status': { generatedAt: at(), channelHealth: { asOf: at(), channels: [{ channel: 'slack', state: 'LIVE', runtimeHost: 'muse', lastReplyAt: at(20) }] } },
    '/api/verse/agent-bus/status': { v: 1, source: 'available', retainedCount: 10, retainedBytes: 100, liveCount: 7, expiredCount: 3, maxMessages: 100, maxBytes: 1000 },
    '/api/verse/fleet/work-board?limit=20': { asOf: at(), inbox: 'ok', truncated: false, items: [{ id: 'wi-1', owner: 'atlas', channel: 'slack', channelRef: 'T-TEAM/C-AGENTS/thread-1', state: 'RUNNING' }] },
  };
}
