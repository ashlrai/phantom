/**
 * Fixtures for the "Working now" strip. Built with the core projection itself,
 * so the JSON matches what `phm sessions --json` prints.
 */
import { buildLiveSessions, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { FleetSessionV1 } from '../../../../core/fleet/runs-sessions.js';
import type { FleetSessionMap, MapSession } from '../../../../core/fleet/sessions-view.js';
import type { SubagentRecord } from '../../../../core/subagent/spawn.js';

export const ROSTER_NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(ROSTER_NOW - minutes * 60_000).toISOString();
const local = (job: string, lane: string, over: Partial<FleetSessionV1> = {}) => ({ job, lane, repo: 'phantom', tier: 'frontier',
  model: 'fixture-model', startedAt: ago(30), lastOutputAt: ago(2), prUrl: null, ...over }) as FleetSessionV1;
const placed = (job: string, lane: string | null, nodeId: string | null, over: Partial<MapSession> = {}): MapSession => ({
  job, lane, model: 'fixture-model', status: 'running', elapsedSeconds: 1800, prUrl: null, outcome: null, nodeId,
  placement: nodeId ? 'claim' : 'unknown', mapState: 'running', branch: null, worktree: null, activity: null, detailSources: null, ...over });
const map = (over: Partial<FleetSessionMap>) => ({ schema: 'fleet.sessions.v1', runsDirPresent: true, sourceState: 'healthy', sources: {},
  truncated: false, localNodeId: 'node-here', sessions: [], mapSessions: [], ...over }) as unknown as FleetSessionMap;

/** Two running workers (one saying something, one with a PR), one quiet worker, a helper under RQ-A and a failed job. */
export function rosterFleet(): LiveSessionsV1 {
  const sessions = map({
    sessions: [local('RQ-A', 'claude'), local('RQ-QUIET', 'claude', { lastOutputAt: ago(14), startedAt: ago(40) }),
      local('RQ-PR', 'codex-local', { prUrl: 'https://github.com/ashlrai/phantom/pull/9' })],
    mapSessions: [placed('RQ-A', 'claude', 'node-here', { activity: 'Running the tests' }), placed('RQ-QUIET', 'claude', 'node-here'),
      placed('RQ-PR', 'codex-local', 'node-here')],
    recent: [local('RQ-FAILED', 'claude', { finishedAt: ago(5), outcome: 'failed' })],
  } as Partial<FleetSessionMap>);
  const helper = { id: 'helper-a', parent_id: 'RQ-A', depth: 1, lane: 'claude', model: 'small-model', state: 'running', created_at: ago(3) } as SubagentRecord;
  return buildLiveSessions(sessions, ROSTER_NOW, { subagents: [helper] });
}

export const rosterEmpty = (): LiveSessionsV1 => buildLiveSessions(map({}), ROSTER_NOW);
