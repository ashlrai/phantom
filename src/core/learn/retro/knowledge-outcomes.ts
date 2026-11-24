/**
 * knowledge-outcomes.ts — join injected-note run correlations to trajectory
 * outcomes (3.15 follow-on).
 *
 * knowledge-runs.jsonl records which fleet trajectory each approved note was
 * injected into (`run:<attemptId>` — the same key trajectory-records joins
 * on). This module folds those rows against trajectory records so the Lessons
 * view can show, per note, how the runs that saw it actually ended — the same
 * descriptive evidence skill outcomes already publish, at note granularity.
 *
 * Honesty rules (mirroring skill-outcomes.ts):
 *  - Descriptive counts only. A note's tallies say what happened to runs it
 *    was injected into; they are NOT a causal verdict — that is what the
 *    cloud lesson holdout (improve/lesson-trial.ts) measures separately.
 *  - Degraded or incomplete trajectory sources withhold EVERYTHING (null):
 *    an unreadable journal cannot be told apart from "no record".
 *  - A trajectory id claimed by conflicting records never resolves.
 *  - Below MIN_KNOWLEDGE_OUTCOME_JOINS joined runs, `outcomes`/`realized`
 *    stay absent — exact per-note counts at tiny samples mislead, the same
 *    floor MIN_SKILL_OBSERVED_TRAJECTORIES applies to skill tallies.
 *  - `runs`/`joined` are always exact observations of the retained window;
 *    a truncated runs tail makes them a floor, and truncation withholds the
 *    tallies rather than silently undercounting.
 */
import {
  listTrajectoryJoinQuality,
  type TrajectoryJoinQualityOptions,
  type TrajectoryJoinQualityResult,
  type TrajectoryRealizedOutcome,
  type TrajectoryRecord,
  type TrajectoryTerminalOutcome,
} from '../../autonomy/trajectory-records.js';
import { readKnowledgeRuns } from './store.js';
import type { KnowledgeNoteOutcomes } from './types.js';

/** Joined runs a note needs before its outcome tallies publish. */
export const MIN_KNOWLEDGE_OUTCOME_JOINS = 3;

export interface KnowledgeOutcomeDeps {
  readRuns?: typeof readKnowledgeRuns;
  listJoinQuality?: (opts?: TrajectoryJoinQualityOptions) => TrajectoryJoinQualityResult;
}

export interface KnowledgeOutcomeOptions {
  windowHours?: number;
  limit?: number;
  deps?: KnowledgeOutcomeDeps;
}

/** Terminal + realized outcome of one trajectory record, when both resolve. */
interface ResolvedTrajectory {
  terminalOutcome: TrajectoryTerminalOutcome;
  realizedOutcome?: TrajectoryRealizedOutcome;
}

/**
 * Per-note outcome tallies keyed by note id, or null when the evidence is not
 * publishable (degraded runs log or degraded/incomplete trajectory sources).
 * Notes absent from the map had no correlated injections in the retained
 * window — their `outcomes` simply stays unset.
 */
export async function readKnowledgeNoteOutcomes(
  opts: KnowledgeOutcomeOptions = {},
): Promise<Map<string, KnowledgeNoteOutcomes> | null> {
  try {
    const readRuns = opts.deps?.readRuns ?? readKnowledgeRuns;
    const runs = await readRuns();
    if (runs.state === 'degraded' || runs.truncated || runs.byNote.size === 0) {
      // A degraded log cannot be told from "no runs"; a truncated tail
      // undercounts runs, so exact tallies would be silently incomplete.
      return runs.state === 'degraded' || runs.truncated ? null : new Map();
    }
    const listQuality = opts.deps?.listJoinQuality ?? listTrajectoryJoinQuality;
    const quality = listQuality({
      ...(opts.windowHours !== undefined ? { windowHours: opts.windowHours } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    const sources = quality.sourceQuality?.sources;
    if (!sources) return null;
    // Terminal outcomes are decided by the dispatch + outcome journals; a
    // degraded or partial read there cannot distinguish "no record" from
    // "record unreadable", so every tally is withheld.
    for (const key of ['dispatch', 'outcomes'] as const) {
      const source = sources[key];
      if (!source || source.sourceState === 'degraded' || source.complete === false) return null;
    }
    const trajectories = trajectoryOutcomes(quality.records);
    const out = new Map<string, KnowledgeNoteOutcomes>();
    for (const [noteId, trajectoryIds] of runs.byNote) {
      let joined = 0;
      const outcomes: Partial<Record<TrajectoryTerminalOutcome, number>> = {};
      const realized: Partial<Record<TrajectoryRealizedOutcome, number>> = {};
      for (const trajectoryId of trajectoryIds) {
        const resolved = trajectories.get(trajectoryId);
        if (resolved === undefined) continue;
        joined += 1;
        outcomes[resolved.terminalOutcome] = (outcomes[resolved.terminalOutcome] ?? 0) + 1;
        if (resolved.realizedOutcome !== undefined) {
          realized[resolved.realizedOutcome] = (realized[resolved.realizedOutcome] ?? 0) + 1;
        }
      }
      const row: KnowledgeNoteOutcomes = { runs: trajectoryIds.size, joined };
      if (joined >= MIN_KNOWLEDGE_OUTCOME_JOINS) {
        row.outcomes = outcomes;
        if (Object.keys(realized).length > 0) row.realized = realized;
      }
      out.set(noteId, row);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * trajectoryId → resolved outcome. A trajectory id claimed by records with
 * DIFFERENT terminal outcomes is ambiguous evidence and resolves to nothing —
 * the same "conflicting claims never resolve" rule the sibling folds apply.
 * Records without a trajectoryId (work:-derived or unjoined) cannot be hit
 * targets and are skipped.
 */
function trajectoryOutcomes(records: readonly TrajectoryRecord[]): Map<string, ResolvedTrajectory> {
  const claims = new Map<string, ResolvedTrajectory[]>();
  for (const record of records) {
    if (typeof record.trajectoryId !== 'string' || record.trajectoryId.length === 0) continue;
    const list = claims.get(record.trajectoryId) ?? [];
    list.push({
      terminalOutcome: record.terminalOutcome,
      ...(record.realizedOutcome !== undefined ? { realizedOutcome: record.realizedOutcome } : {}),
    });
    claims.set(record.trajectoryId, list);
  }
  const out = new Map<string, ResolvedTrajectory>();
  for (const [trajectoryId, list] of claims) {
    const first = list[0]!;
    const conflict = list.some((r) =>
      r.terminalOutcome !== first.terminalOutcome || r.realizedOutcome !== first.realizedOutcome);
    if (!conflict) out.set(trajectoryId, first);
  }
  return out;
}
