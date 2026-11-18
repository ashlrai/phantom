/** Read-only reconciliation of local dispatch attempts using the sessions/metrics reader. */
import type { FleetSessionsV1, FleetSessionV1 } from './runs-sessions.js';

export type RunState = 'live' | 'finished' | 'unknown';
export interface ReconciledRun extends Pick<FleetSessionV1,
  'job' | 'repo' | 'lane' | 'status' | 'live' | 'pid' | 'startedAt' | 'lastOutputAt' | 'finishedAt' | 'exitCode'> {
  state: RunState;
  reason: string;
}
export interface SessionReconciliation extends Pick<FleetSessionsV1,
  'generatedAt' | 'runsDirPresent' | 'sources' | 'dispatcher' | 'truncated' | 'malformed'> {
  schema: 'fleet.session-reconciliation.v1';
  readOnly: true;
  /** Counts cover returned runs only; inspect sources and truncated for coverage. */
  counts: Record<RunState, number>;
  runs: ReconciledRun[];
}

export function reconcileSessions(snapshot: FleetSessionsV1): SessionReconciliation {
  const runs = [...snapshot.sessions, ...snapshot.recent]
    .filter(s => s.status !== 'queued' && s.status !== 'parked')
    .sort((a, b) => a.job.localeCompare(b.job))
    .map((s): ReconciledRun => {
      const ended = s.status === 'finished' || s.status === 'exited';
      const state = s.live === 'yes' ? ended ? 'unknown' : 'live' : ended ? 'finished' : 'unknown';
      const reason = s.live === 'yes' && ended ? 'Worker and completion records disagree.'
        : state === 'live' ? 'Worker process observed, even if its output or dispatcher heartbeat is old.'
          : state === 'finished' ? 'Completion or exit recorded for this attempt; this does not prove publication.'
            : s.live === 'unknown' ? 'Process observation unavailable; no completion recorded.'
              : 'No worker or completion observed; quiet output alone does not prove the run ended.';
      return { job: s.job, repo: s.repo, lane: s.lane, status: s.status, live: s.live, pid: s.pid,
        startedAt: s.startedAt, lastOutputAt: s.lastOutputAt ?? null, finishedAt: s.finishedAt,
        exitCode: s.exitCode, state, reason };
    });
  const counts = { live: 0, finished: 0, unknown: 0 };
  for (const run of runs) counts[run.state]++;
  return { schema: 'fleet.session-reconciliation.v1', readOnly: true, generatedAt: snapshot.generatedAt,
    runsDirPresent: snapshot.runsDirPresent, sources: snapshot.sources, dispatcher: snapshot.dispatcher,
    truncated: snapshot.truncated, malformed: snapshot.malformed, counts, runs };
}

export function renderSessionReconciliation(report: SessionReconciliation): string {
  return [`Local runs: ${report.counts.live} live, ${report.counts.finished} finished, ${report.counts.unknown} unknown.`,
    ...report.runs.map(r => `${r.job} | ${r.state} | ${r.reason}`),
    `Sources: ${Object.entries(report.sources).map(([key, value]) => `${key}=${value}`).join(', ')}.`,
    ...(report.truncated ? ['Partial list: the source reached its size limit.'] : []),
    'Read only. No processes or job records changed.'].join('\n');
}
