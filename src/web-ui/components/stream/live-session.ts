/**
 * components/stream/live-session.ts — pure projection from a persisted
 * RunState (GET /api/runs) to the live session card rendered on the journal
 * and Show mode. No React, no fetch — trivially unit-testable.
 *
 * Everything derived is observational, never inferred:
 *   - "phase" is the task currently marked running when one exists, else the
 *     kind of the most recent recorded step, else "Starting up".
 *   - "quiet" is simply the observed gap since the run's persisted
 *     updatedAt, labeled as an observation — the run stream's stall
 *     verdict stays inside useRunStream where it is computed honestly.
 *   - engine/model come straight off the run; when `engineModel` is absent
 *     the card shows the provider id instead of inventing a model name.
 */
import type { RunState, RunStep } from '../../data/api-types.js';

export const STEP_KIND_LABEL: Record<RunStep['kind'], string> = {
  plan: 'Plan',
  model: 'Model',
  tool: 'Tool',
  synthesize: 'Synthesize',
};

export interface LiveSessionEvent {
  kindLabel: string;
  summary: string;
  ts: string;
}

export interface LiveSession {
  id: string;
  goal: string;
  engine: string;
  provider: string;
  /** Backend+model pair the run recorded (`engine:model`), else null. */
  engineModel: string | null;
  /** ms since createdAt — 0 when the timestamp does not parse. */
  elapsedMs: number;
  /** Current phase label: running task goal, step kind, or "Starting up". */
  phase: string;
  tasksDone: number;
  tasksTotal: number;
  lastEvent: LiveSessionEvent | null;
  /** Observed gap since the run's persisted updatedAt, in ms. */
  quietMs: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
}

export function isLiveRun(run: RunState): boolean {
  return run.status === 'running';
}

export function buildLiveSession(run: RunState, now: number): LiveSession {
  const started = Date.parse(run.createdAt);
  const updated = Date.parse(run.updatedAt);
  const lastStep = run.steps.length > 0 ? run.steps[run.steps.length - 1]! : null;
  const runningTasks = run.tasks.filter((t) => t.status === 'running');

  let phase: string;
  if (runningTasks.length === 1) {
    phase = runningTasks[0]!.goal;
  } else if (runningTasks.length > 1) {
    phase = `${runningTasks.length} tasks in flight`;
  } else if (lastStep) {
    phase = `${STEP_KIND_LABEL[lastStep.kind]} step`;
  } else {
    phase = 'Starting up';
  }

  return {
    id: run.id,
    goal: run.goal,
    engine: run.engine,
    provider: run.provider,
    engineModel: run.engineModel ?? null,
    elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : 0,
    phase,
    tasksDone: run.tasks.filter((t) => t.status === 'done').length,
    tasksTotal: run.tasks.length,
    lastEvent: lastStep
      ? { kindLabel: STEP_KIND_LABEL[lastStep.kind] ?? lastStep.kind, summary: lastStep.summary, ts: lastStep.ts }
      : null,
    quietMs: Number.isFinite(updated) ? Math.max(0, now - updated) : 0,
    tokensIn: run.usage.tokensIn,
    tokensOut: run.usage.tokensOut,
    estCostUsd: run.usage.estCostUsd,
  };
}

/** Running runs, newest-started first, projected to cards. */
export function buildLiveSessions(runs: readonly RunState[] | undefined, now: number, limit = 12): LiveSession[] {
  return (runs ?? [])
    .filter(isLiveRun)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map((run) => buildLiveSession(run, now));
}

/** Compact elapsed clock: `42s`, `3m 12s`, `1h 4m`, `2d 3h`. */
export function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * "quiet for X" label — emitted only past `quietAfterMs` of no persisted
 * update, and always phrased as an observation (the data may simply be
 * quiet between steps), never a stall verdict.
 */
export function formatQuietLabel(quietMs: number, quietAfterMs: number): string | null {
  if (quietMs < quietAfterMs) return null;
  return `quiet ${formatElapsedMs(quietMs)}`;
}
