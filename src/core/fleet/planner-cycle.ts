/**
 * planner-cycle.ts — run (or preview) ONE planner pass and prove it supplied
 * work. A child exit 0 alone never meant the pass produced jobs: the planner
 * can spawn, exit cleanly and still write nothing the ingest can use. After
 * exactly one executePlannerPass run, this re-reads the drop folders and
 * ingest ledger over the run's own startedAt..finishedAt bounds (rounded
 * outward to whole seconds, matching ledger granularity) and reports the
 * execution outcome separately from the output evidence.
 *
 * Verdicts: `productive` only when pending or ingested jobs were observed —
 * pending means produced, not ingested or launched. Zero exit with nothing
 * produced, or rejected-only output, is `unproductive` (nonzero). Missing or
 * invalid evidence is `unknown`, never success. ORCH_OFF is `skipped`, never
 * productive. Runner failures and passes that never executed are `failed`.
 * The pass is never retried and lane selection is never altered. The window
 * is observational, not attribution: concurrent planners writing in the same
 * seconds land in the same ledger rows and drop files. Prompt and log
 * contents are never read here.
 */
import { executePlannerPass } from './planner-pass.js';
import { readPlannerPassOutput, summarizePlannerPassOutput, type PlannerPassOutput } from './planner-pass-output.js';
import type { PlannerRunResult } from './planner-run.js';
import { scrubSecrets } from '../util/scrub.js';

export interface PlannerCycleDeps {
  /** One-shot pass executor; apply mode calls it exactly once. */
  executePass: typeof executePlannerPass;
  /** Drop-folder and ingest-ledger reader over the run window. */
  readOutput: typeof readPlannerPassOutput;
}
export const defaultPlannerCycleDeps: PlannerCycleDeps = { executePass: executePlannerPass, readOutput: readPlannerPassOutput };

export type PlannerCycleVerdict = 'planned' | 'productive' | 'unproductive' | 'failed' | 'skipped' | 'unknown';
export type PlannerCycleEvidenceState = 'not-collected' | 'productive' | 'unproductive' | 'unknown';

export const PLANNER_CYCLE_ATTRIBUTION =
  'window evidence is observational: drops and ledger rows landing inside the run window may include concurrent planners\' output and are not exact attribution to this pass';

export interface PlannerCycleReport {
  v: 1;
  mode: 'preview' | 'apply';
  verdict: PlannerCycleVerdict;
  execution: {
    outcome: 'planned' | 'not-run' | 'threw' | PlannerRunResult['outcome'];
    provider: string | null;
    exitCode: number | null;
    reason: string;
    logPath: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    nextResetAt: string | null;
  };
  evidence: {
    state: PlannerCycleEvidenceState;
    attribution: 'observational' | 'none';
    window: { since: string; until: string } | null;
    counts: { ingested: number; pending: number; rejected: number } | null;
    ingested: string[];
    pending: string[];
    rejected: Array<{ id: string; reason: string }>;
    sources: { ledger: string; drops: string[]; skipped: number } | null;
    detail: string;
    note: string | null;
  };
}

export function plannerCycleExit(verdict: PlannerCycleVerdict): number {
  if (verdict === 'planned' || verdict === 'productive') return 0;
  if (verdict === 'unproductive' || verdict === 'failed') return 1;
  return verdict === 'skipped' ? 3 : 4;
}

/** Classify one output read: positive counts are real evidence; a degraded or fully missing store cannot prove a negative. */
function classifyEvidence(view: PlannerPassOutput): Exclude<PlannerCycleEvidenceState, 'not-collected'> {
  if (view.counts.ingested + view.counts.pending > 0) return 'productive';
  const degraded = view.sources.ledger === 'invalid'
    || view.sources.drops.some((drop) => drop.state === 'invalid')
    || view.sources.skipped > 0;
  if (degraded) return 'unknown';
  const nothingToRead = view.sources.ledger === 'missing'
    && view.sources.drops.every((drop) => drop.state === 'missing');
  return nothingToRead ? 'unknown' : 'unproductive';
}

/** The run's real bounds widened only to ledger granularity: `HH:MM:SS` rows carry no sub-second part. */
function runWindow(result: { startedAt: string; finishedAt: string }): { sinceMs: number; untilMs: number } | null {
  const start = Date.parse(result.startedAt), finish = Date.parse(result.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || start > finish) return null;
  return { sinceMs: Math.floor(start / 1000) * 1000, untilMs: Math.ceil(finish / 1000) * 1000 };
}

function evidenceFromView(view: PlannerPassOutput): PlannerCycleReport['evidence'] {
  return {
    state: classifyEvidence(view),
    attribution: 'observational',
    window: view.window,
    counts: view.counts,
    ingested: view.ingested.map((row) => row.id),
    pending: view.pending.map((row) => row.id),
    rejected: view.rejected.map((row) => ({ id: row.id, reason: row.reason })),
    sources: { ledger: view.sources.ledger, drops: view.sources.drops.map((drop) => drop.state), skipped: view.sources.skipped },
    detail: summarizePlannerPassOutput(view),
    note: PLANNER_CYCLE_ATTRIBUTION,
  };
}

function shellEvidence(
  state: PlannerCycleEvidenceState, detail: string, window: PlannerCycleReport['evidence']['window'] = null,
): PlannerCycleReport['evidence'] {
  const observational = state !== 'not-collected';
  return {
    state, attribution: observational ? 'observational' : 'none', window, counts: null,
    ingested: [], pending: [], rejected: [], sources: null, detail,
    note: observational ? PLANNER_CYCLE_ATTRIBUTION : null,
  };
}

/**
 * Run one planner cycle. `opts.runsRoot` and `opts.promptPath` must already be
 * absolute; `apply` false previews the selection without spawning. Apply mode
 * makes exactly one executePlannerPass call — no retry — then reads output
 * evidence over the run's reported bounds.
 */
export async function runPlannerCycle(
  opts: { runsRoot: string; promptPath: string; apply?: boolean; home?: string; now?: () => number },
  deps: PlannerCycleDeps = defaultPlannerCycleDeps,
): Promise<{ report: PlannerCycleReport; exitCode: number }> {
  const apply = opts.apply === true;
  const done = (report: PlannerCycleReport): { report: PlannerCycleReport; exitCode: number } =>
    ({ report, exitCode: plannerCycleExit(report.verdict) });
  const base = (verdict: PlannerCycleVerdict, execution: PlannerCycleReport['execution'], evidence: PlannerCycleReport['evidence']): PlannerCycleReport =>
    ({ v: 1, mode: apply ? 'apply' : 'preview', verdict, execution, evidence });

  let pass: Awaited<ReturnType<typeof executePlannerPass>>;
  try {
    pass = await deps.executePass({ runsRoot: opts.runsRoot, promptPath: opts.promptPath, run: apply });
  } catch (error) {
    const reason = `planner pass threw: ${scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200)}`;
    return done(base('failed',
      { outcome: 'threw', provider: null, exitCode: null, reason, logPath: null, startedAt: null, finishedAt: null, nextResetAt: null },
      shellEvidence('not-collected', 'no run completed; nothing to observe')));
  }

  // executePlannerPass's inferred return is a union; only the run branch
  // carries `result`/`nextResetAt`, so read them through an optional shape.
  const fields = pass as { result?: PlannerRunResult; nextResetAt?: string | null };
  const result = fields.result;
  const execution: PlannerCycleReport['execution'] = {
    outcome: apply ? (result?.outcome ?? 'not-run') : 'planned',
    provider: result?.provider ?? pass.provider ?? null,
    exitCode: result?.exitCode ?? null,
    reason: pass.reason,
    logPath: result?.logPath ?? null,
    startedAt: result?.startedAt ?? null,
    finishedAt: result?.finishedAt ?? null,
    nextResetAt: result?.nextResetAt ?? fields.nextResetAt ?? null,
  };

  if (!apply) {
    return done(base(pass.ok ? 'planned' : 'failed', execution, shellEvidence('not-collected', 'preview does not run the pass; no output expected')));
  }
  if (!result) {
    return done(base('failed', execution, shellEvidence('not-collected', 'no planner run executed; nothing produced observable output')));
  }

  const window = runWindow(result);
  let evidence: PlannerCycleReport['evidence'];
  if (window === null) {
    evidence = shellEvidence('unknown', 'run reported missing or invalid startedAt/finishedAt bounds; evidence window is unusable');
  } else {
    try {
      evidence = evidenceFromView(await deps.readOutput({
        runsRoot: opts.runsRoot, home: opts.home, sinceMs: window.sinceMs, untilMs: window.untilMs, now: opts.now,
      }));
    } catch {
      evidence = shellEvidence('unknown', 'output evidence read failed; cannot prove or disprove produced work',
        { since: new Date(window.sinceMs).toISOString(), until: new Date(window.untilMs).toISOString() });
    }
  }

  const verdict: PlannerCycleVerdict =
    result.outcome === 'skipped-orch-off' ? 'skipped'
    : result.outcome !== 'ran' || result.exitCode !== 0 ? 'failed'
    : evidence.state === 'not-collected' ? 'unknown'
    : evidence.state;
  return done(base(verdict, execution, evidence));
}
