/**
 * Fixtures for "Ended while you were away". Built with the core projection
 * itself, so the JSON matches what `phm sessions --json` prints.
 */
import { buildLiveSessions, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { FleetSessionV1 } from '../../../../core/fleet/runs-sessions.js';
import type { FleetSessionMap, MapSession } from '../../../../core/fleet/sessions-view.js';
import type { SubagentRecord } from '../../../../core/subagent/spawn.js';

const MIN = 60_000;

export interface EndedFixture { job: string; lane?: string; minutesAgo: number; outcome: 'pr' | 'empty' | 'failed' | null }

/**
 * One running worker (RQ-RUN), the given ended workers, and a helper under
 * RQ-RUN that completed (a helper record holds no end time).
 */
export function awayFleet(now: number, ended: readonly EndedFixture[], options: { live?: boolean } = {}): LiveSessionsV1 {
  const ago = (minutes: number) => new Date(now - minutes * MIN).toISOString();
  const local = (job: string, lane: string, over: Partial<FleetSessionV1> = {}) => ({ job, lane, repo: 'phantom', tier: 'frontier',
    model: 'fixture-model', startedAt: ago(90), lastOutputAt: ago(2), prUrl: null, ...over }) as FleetSessionV1;
  const running: MapSession = { job: 'RQ-RUN', lane: 'claude', model: 'fixture-model', status: 'running', elapsedSeconds: 1800, prUrl: null, outcome: null,
    nodeId: 'node-here', placement: 'claim', mapState: 'running', branch: null, worktree: null, activity: 'Running the tests', detailSources: null };
  const sessions = { schema: 'fleet.sessions.v1', runsDirPresent: true, sourceState: 'healthy', sources: {}, truncated: false, localNodeId: 'node-here',
    sessions: [local('RQ-RUN', 'claude')], mapSessions: [running],
    recent: ended.map(item => local(item.job, item.lane ?? 'claude', { finishedAt: ago(item.minutesAgo), outcome: item.outcome } as Partial<FleetSessionV1>)),
  } as unknown as FleetSessionMap;
  const helper = { id: 'helper-done', parent_id: 'RQ-RUN', depth: 1, lane: 'claude', model: 'small-model', state: 'completed', created_at: ago(10) } as SubagentRecord;
  return buildLiveSessions(sessions, now, { subagents: [helper], live: options.live });
}
