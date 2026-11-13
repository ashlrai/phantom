/**
 * core/fleet/autopilot-state.ts — read-only fleet autopilot state assembly
 * (recovered slice of RQ-SWE3-AUTOPILOT-1, open PR #4071). Reads
 * queue/status.json (admission via explainFleetAdmission), queue/ready.tsv
 * plus metrics/jobs.jsonl (ready/parked supply and unmet dependency rows via
 * readFleetQueue), and queue/slots.json (lane targets, floors, ceilings and
 * holds via readLaneTargets). An optional repos pass adds the read-only
 * `gh pr list` rebase-coverage read via readRebaseStatus; without repos that
 * source is 'unconfigured', never guessed.
 *
 * Every source degrades independently and the assembly never throws: a
 * missing or malformed input nulls only its own slice while healthy siblings
 * survive. This module performs no writes, launches, holds or merges; the
 * state is advisory input for a later planner. `ashlr fleet
 * autopilot-state --json` is the verb.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { explainFleetAdmission, type FleetAdmissionReport } from '../../cli/fleet-admission.js';
import { readFleetQueue, type FleetQueueV1, type Source } from './runs-parked-queue.js';
import { readLaneTargets, type LaneTargetsV1 } from './runs-lane-targets.js';
import { readRebaseStatus } from './rebase-status.js';

export type RebaseSource = 'unconfigured' | 'ok' | 'partial' | 'degraded';
export interface AutopilotSources { status: Source; queue: Source; slots: Source; rebase: RebaseSource }

/** Per-repo rebase coverage, reduced from readRebaseStatus to what a planner needs. */
export interface AutopilotRebaseRepo {
  repo: string;
  source: 'ok' | 'truncated' | 'unavailable';
  /** Open conflicting bridge PRs; null when the repo read was unavailable. */
  conflicting: number | null;
  /** Conflicting PRs with no rebase job for the current head — enqueue this many. */
  uncovered: number | null;
  /** Conflicting PRs whose only rebase jobs target a stale head — rebase is due again. */
  staleHeadOnly: number | null;
}

export interface FleetAutopilotState {
  generatedAt: string;
  sources: AutopilotSources;
  admission: FleetAdmissionReport | null;
  queue: FleetQueueV1 | null;
  slots: LaneTargetsV1 | null;
  /** Null when no repo was requested. */
  rebase: AutopilotRebaseRepo[] | null;
}

export interface AutopilotReadDeps {
  /** Returns queue/status.json text; rejects ENOENT for a missing file. */
  statusText?: (path: string) => Promise<string>;
  queue?: (opts: { runsDir: string }) => Promise<FleetQueueV1>;
  slots?: (opts: { runsDir: string }) => Promise<LaneTargetsV1>;
  rebase?: typeof readRebaseStatus;
  now?: () => Date;
}

/** Assemble every local input; each source degrades independently, never throws. */
export async function readFleetAutopilotState(
  opts: { runsDir?: string; repos?: string[] } & AutopilotReadDeps = {},
): Promise<FleetAutopilotState> {
  const runsDir = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const now = opts.now ?? (() => new Date());
  const [status, queue, slots, rebase] = await Promise.all([
    (async (): Promise<{ source: Source; report: FleetAdmissionReport | null }> => {
      try {
        const text = await (opts.statusText ?? ((path) => readFile(path, 'utf8')))(join(runsDir, 'queue', 'status.json'));
        return { source: 'healthy', report: explainFleetAdmission(JSON.parse(text)) };
      } catch (error) {
        return { source: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'degraded', report: null };
      }
    })(),
    (opts.queue ?? ((o) => readFleetQueue(o)))({ runsDir })
      // The ready/parked supply is the measured input; the precheck-skip tail
      // is auxiliary and never downgrades the queue source here.
      .then((view): { source: Source; view: FleetQueueV1 | null } => ({
        source: view.sources.ready, view,
      }))
      .catch((): { source: Source; view: FleetQueueV1 | null } => ({ source: 'degraded', view: null })),
    (opts.slots ?? ((o) => readLaneTargets(o)))({ runsDir })
      .then((view): { source: Source; view: LaneTargetsV1 } => ({ source: view.sourceState, view }))
      .catch((): { source: Source; view: LaneTargetsV1 | null } => ({ source: 'degraded', view: null })),
    (async (): Promise<{ source: RebaseSource; repos: AutopilotRebaseRepo[] | null }> => {
      const repos = opts.repos ?? [];
      if (repos.length === 0) return { source: 'unconfigured', repos: null };
      try {
        const report = await (opts.rebase ?? readRebaseStatus)(repos, runsDir, now());
        const rows: AutopilotRebaseRepo[] = report.repos.map((row) => ({
          repo: row.repo,
          source: row.source === 'ok' || row.source === 'truncated' ? row.source : 'unavailable',
          conflicting: row.summary?.conflicting ?? null,
          uncovered: row.summary === null ? null : (row.summary.coverage?.uncovered ?? null),
          staleHeadOnly: row.summary === null ? null : (row.summary.coverage?.staleHeadOnly ?? null),
        }));
        const ok = rows.filter((row) => row.source === 'ok').length;
        return { source: ok === rows.length ? 'ok' : ok === 0 ? 'degraded' : 'partial', repos: rows };
      } catch {
        return { source: 'degraded', repos: null };
      }
    })(),
  ]);
  return {
    generatedAt: now().toISOString(),
    sources: { status: status.source, queue: queue.source, slots: slots.source, rebase: rebase.source },
    admission: status.report, queue: queue.view, slots: slots.view, rebase: rebase.repos,
  };
}
