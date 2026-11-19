/**
 * A sessions list for the Leader reply box tests, built by the core projection
 * itself so the JSON matches what `phm sessions --json` prints: RQ-A running on
 * claude (last said "Running the tests"), RQ-QUIET quiet for 14 minutes,
 * RQ-CODEX on codex-local with no recorded last message, a helper with no RQ
 * id, and RQ-FAILED, which ended and must never be offered.
 */
import { buildLiveSessions, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { FleetSessionV1 } from '../../../../core/fleet/runs-sessions.js';
import type { FleetSessionMap, MapSession } from '../../../../core/fleet/sessions-view.js';
import type { SubagentRecord } from '../../../../core/subagent/spawn.js';

export const ASSIST_NOW = Date.parse('2026-11-18T12:00:00Z');
const ago = (minutes: number) => new Date(ASSIST_NOW - minutes * 60_000).toISOString();
const local = (job: string, lane: string, over: Partial<FleetSessionV1> = {}) => ({ job, lane, repo: 'phantom', tier: 'frontier',
  model: 'fixture-model', startedAt: ago(30), lastOutputAt: ago(2), prUrl: null, ...over }) as FleetSessionV1;
const placed = (job: string, lane: string, activity: string | null): MapSession => ({
  job, lane, model: 'fixture-model', status: 'running', elapsedSeconds: 1800, prUrl: null, outcome: null, nodeId: 'node-here',
  placement: 'claim', mapState: 'running', branch: null, worktree: null, activity, detailSources: null });

function sessionMap(sessions: FleetSessionV1[], mapSessions: MapSession[], recent: FleetSessionV1[] = []): FleetSessionMap {
  return { schema: 'fleet.sessions.v1', runsDirPresent: true, sourceState: 'healthy', sources: {}, truncated: false, localNodeId: 'node-here',
    sessions, mapSessions, recent } as unknown as FleetSessionMap;
}

export function assistSessions(): LiveSessionsV1 {
  const map = sessionMap(
    [local('RQ-A', 'claude'), local('RQ-QUIET', 'claude', { lastOutputAt: ago(14), startedAt: ago(40) }), local('RQ-CODEX', 'codex-local')],
    [placed('RQ-A', 'claude', 'Running the tests'), placed('RQ-QUIET', 'claude', 'Waiting on a review'), placed('RQ-CODEX', 'codex-local', null)],
    [local('RQ-FAILED', 'claude', { finishedAt: ago(5), outcome: 'failed' })],
  );
  const helper = { id: 'helper-a', parent_id: 'RQ-A', depth: 1, lane: 'claude', model: 'small-model', state: 'running', created_at: ago(3) } as SubagentRecord;
  return buildLiveSessions(map, ASSIST_NOW, { subagents: [helper] });
}

export const noSessions = (): LiveSessionsV1 => buildLiveSessions(sessionMap([], []), ASSIST_NOW);
