/**
 * prompt-ab.ts — RQ-SELFOPT-PROMPT-OPT: the prompt-variant A/B engine.
 *
 * Replays each prompt variant as a router policy over a frozen outcome log
 * (router-eval.v1) through the RQ-SELFOPT-EVAL-HARNESS evaluator, and applies
 * a promotion gate per job class. A challenger is promoted only on a
 * significant lift: non-overlapping Wilson 95% intervals on merge rate, a
 * minimum resolved cohort on both arms, bounded unobserved coverage, and a
 * cost-per-merge guardrail. Anything short of that is a documented hold —
 * never a quiet promotion.
 *
 * Honesty stance (inherited from the harness): outcomes only ever come from
 * the recorded arm or a frozen counterfactual row; unobserved decisions are
 * counted, not estimated. "Before" numbers are the control variant replayed
 * over the same cohort as the challenger, not a different dataset.
 */

import {
  evaluateRouterPolicy,
  type MetricReport,
  type PolicyJobView,
  type RouterEvalDataset,
  type RouterPolicy,
} from './router-eval.js';
import type { PromptPromotionRecord, PromptPromotionsRegistry } from './prompt-promotions.js';
import {
  classifyPromptJob,
  promptGate,
  type PromotionGateSpec,
  type PromptExperimentSpec,
} from './prompt-variants.js';

// ---------------------------------------------------------------------------
// Variant policies — each arm replayed as "always pick this prompt"
// ---------------------------------------------------------------------------

function variantPolicy(arm: string): RouterPolicy {
  return {
    name: `variant:${arm}`,
    decide(job: PolicyJobView) {
      if (job.candidates.length > 0 && !job.candidates.includes(arm)) {
        return { arm: null, reason: `${arm} is not an eligible candidate` };
      }
      return { arm, reason: `experiment arm ${arm}` };
    },
  };
}

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

export interface PromptArmEval {
  arm: string;
  cohort: number;
  resolved: number;
  merged: number;
  unobserved: number;
  held: number;
  mergeRate: MetricReport;
  costPerMergedPrUsd: MetricReport;
  tokensPerMergedPr: MetricReport;
  wallTimeMsMean: MetricReport;
}

export type PromotionVerdict =
  | 'promoted'
  | 'no-lift'
  | 'not-significant'
  | 'insufficient-data'
  | 'thin-coverage'
  | 'cost-regression';

export interface PromptChallengerResult {
  eval: PromptArmEval;
  verdict: PromotionVerdict;
  /** after - before merge rate, in points; null when either side is unknown. */
  liftPoints: number | null;
}

export interface PromptClassReport {
  classId: string;
  jobs: number;
  control: PromptArmEval;
  challengers: PromptChallengerResult[];
  /** Arm of the promoted challenger, if any passed the gate. */
  winner: string | null;
}

export interface PromptAbReport {
  schemaVersion: 1;
  experimentId: string;
  generatedAt: string;
  dataset: { id?: string; sha256: string; jobs: number };
  gate: PromotionGateSpec;
  classes: PromptClassReport[];
  /** One record per promoted class — the registry's `promoted` payload. */
  promotions: PromptPromotionRecord[];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function armEval(dataset: RouterEvalDataset, jobs: RouterEvalDataset['jobs'], arm: string): PromptArmEval {
  const report = evaluateRouterPolicy(
    { meta: dataset.meta, jobs, sha256: dataset.sha256 },
    variantPolicy(arm),
  );
  return {
    arm,
    cohort: report.coverage.jobs,
    resolved: report.coverage.resolved,
    merged: report.perArm.find((a) => a.arm === arm)?.merged ?? 0,
    unobserved: report.coverage.unobserved,
    held: report.coverage.held,
    mergeRate: report.mergeRate,
    costPerMergedPrUsd: report.costPerMergedPrUsd,
    tokensPerMergedPr: report.tokensPerMergedPr,
    wallTimeMsMean: report.wallTimeMsMean,
  };
}

/** The gate, checked in explainable order — first failure is the verdict. */
function gateVerdict(control: PromptArmEval, challenger: PromptArmEval, gate: PromotionGateSpec): PromotionVerdict {
  const cohort = Math.max(control.cohort, challenger.cohort);
  const unobserved = Math.max(control.unobserved, challenger.unobserved);
  if (cohort > 0 && unobserved / cohort > gate.maxUnobservedShare) return 'thin-coverage';
  if (control.resolved < gate.minResolvedPerArm || challenger.resolved < gate.minResolvedPerArm) {
    return 'insufficient-data';
  }
  const before = control.mergeRate.value;
  const after = challenger.mergeRate.value;
  if (before === null || after === null) return 'insufficient-data';
  if (after <= before) return 'no-lift';
  const ciLow = challenger.mergeRate.ci95?.[0];
  const ciHigh = control.mergeRate.ci95?.[1];
  if (ciLow === undefined || ciHigh === undefined || ciLow <= ciHigh) return 'not-significant';
  const costBefore = control.costPerMergedPrUsd.value;
  const costAfter = challenger.costPerMergedPrUsd.value;
  if (costBefore !== null && costAfter !== null && costAfter > costBefore * (1 + gate.costRegressionTolerance)) {
    return 'cost-regression';
  }
  return 'promoted';
}

/**
 * Replay the experiment: group the dataset into classes, evaluate the control
 * and every challenger over each cohort, and gate each pairing. Deterministic
 * given the dataset — `generatedAt` is the only wall-clock field.
 */
export function evaluatePromptExperiment(
  dataset: RouterEvalDataset,
  spec: PromptExperimentSpec,
  opts: { now?: string } = {},
): PromptAbReport {
  const gate = promptGate(spec);
  const decidedAt = opts.now ?? new Date().toISOString();
  const classes: PromptClassReport[] = [];
  const promotions: PromptPromotionRecord[] = [];

  for (const cls of spec.classes) {
    const cohort = dataset.jobs.filter((j) => classifyPromptJob(viewForClassify(j), spec) === cls.id);
    const control = armEval(dataset, cohort, cls.control);
    const challengers: PromptChallengerResult[] = cls.challengers.map((arm) => {
      const evaluation = armEval(dataset, cohort, arm);
      const verdict = gateVerdict(control, evaluation, gate);
      const liftPoints = control.mergeRate.value !== null && evaluation.mergeRate.value !== null
        ? evaluation.mergeRate.value - control.mergeRate.value
        : null;
      return { eval: evaluation, verdict, liftPoints };
    });

    const winners = challengers.filter((c) => c.verdict === 'promoted');
    winners.sort((a, b) => (b.eval.mergeRate.value ?? 0) - (a.eval.mergeRate.value ?? 0));
    const winner = winners[0]?.eval.arm ?? null;
    if (winner !== null) {
      const w = winners[0]!;
      promotions.push({
        classId: cls.id,
        experimentId: spec.id,
        variant: winner,
        control: cls.control,
        before: { value: control.mergeRate.value, ci95: control.mergeRate.ci95, n: control.resolved },
        after: { value: w.eval.mergeRate.value, ci95: w.eval.mergeRate.ci95, n: w.eval.resolved },
        liftPoints: w.liftPoints ?? 0,
        costPerMergedPrBefore: control.costPerMergedPrUsd.value,
        costPerMergedPrAfter: w.eval.costPerMergedPrUsd.value,
        decidedAt,
        datasetSha256: dataset.sha256,
      });
    }
    classes.push({ classId: cls.id, jobs: cohort.length, control, challengers, winner });
  }

  return {
    schemaVersion: 1,
    experimentId: spec.id,
    generatedAt: decidedAt,
    dataset: {
      ...(dataset.meta.id !== undefined ? { id: dataset.meta.id } : {}),
      sha256: dataset.sha256,
      jobs: dataset.jobs.length,
    },
    gate,
    classes,
    promotions,
  };
}

function viewForClassify(job: RouterEvalDataset['jobs'][number]): PolicyJobView {
  const { id, at, repo, pool, tier, priority, task, candidates } = job;
  return { id, at, repo, pool, tier, priority, task, candidates };
}

/** Fold a report into the registry shape the store and dashboard consume. */
export function promotionsRegistry(report: PromptAbReport): PromptPromotionsRegistry {
  const held: PromptPromotionsRegistry['held'] = [];
  for (const cls of report.classes) {
    for (const c of cls.challengers) {
      if (c.eval.arm === cls.winner) continue;
      held.push({ classId: cls.classId, variant: c.eval.arm, verdict: c.verdict });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    experimentId: report.experimentId,
    dataset: report.dataset,
    classes: report.classes.map((c) => c.classId),
    promoted: report.promotions,
    held,
  };
}

// ---------------------------------------------------------------------------
// Dashboard rendering
// ---------------------------------------------------------------------------

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`;
const pts = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)} pts`;

function metric(m: MetricReport, fmt: (n: number) => string): string {
  if (m.value === null) return 'unknown';
  return m.ci95 ? `${fmt(m.value)} [${fmt(m.ci95[0])} – ${fmt(m.ci95[1])}]` : `${fmt(m.value)} [no CI]`;
}

const VERDICT_LABEL: Record<PromotionVerdict, string> = {
  promoted: 'PROMOTED',
  'no-lift': 'held — no lift',
  'not-significant': 'held — not significant',
  'insufficient-data': 'held — insufficient data',
  'thin-coverage': 'held — thin counterfactual coverage',
  'cost-regression': 'held — cost regression',
};

/** Human-readable before/after dashboard for the experiment. */
export function formatPromptAbMarkdown(report: PromptAbReport): string {
  const g = report.gate;
  const lines: string[] = [
    '# Prompt A/B report',
    '',
    `- Experiment: ${report.experimentId} — dataset ${report.dataset.id ?? 'unnamed'} (${report.dataset.jobs} frozen lines, sha256 \`${report.dataset.sha256.slice(0, 12)}\`)`,
    `- Gate: ≥${g.minResolvedPerArm} resolved per arm, ≤${pct(g.maxUnobservedShare)} unobserved, disjoint Wilson 95% intervals, cost-per-merge regression ≤${pct(g.costRegressionTolerance)}`,
    '',
  ];
  for (const cls of report.classes) {
    lines.push(`## ${cls.classId} — ${cls.winner === null ? 'no promotion' : `promoted \`${cls.winner}\``}`, '');
    lines.push(
      '| Arm | Resolved | Merged | Merge rate | Cost/merge | Wall mean |',
      '| --- | ---: | ---: | --- | --- | --- |',
    );
    for (const arm of [cls.control, ...cls.challengers.map((c) => c.eval)]) {
      const tag = arm.arm === cls.control.arm ? ' (control)' : '';
      lines.push(`| ${arm.arm}${tag} | ${arm.resolved} | ${arm.merged} | ${metric(arm.mergeRate, pct)} | ${metric(arm.costPerMergedPrUsd, usd)} | ${metric(arm.wallTimeMsMean, minutes)} |`);
    }
    lines.push('');
    for (const c of cls.challengers) {
      const lift = c.liftPoints === null ? 'unknown lift' : `${pts(c.liftPoints)} vs control`;
      lines.push(`- ${c.eval.arm}: **${VERDICT_LABEL[c.verdict]}** (${lift})`);
    }
    lines.push('');
  }
  if (report.promotions.length > 0) {
    lines.push('## Promotions', '', '| Job class | Variant | Before | After | Lift |', '| --- | --- | --- | --- | --- |');
    for (const p of report.promotions) {
      const before = p.before.value === null ? 'unknown' : `${pct(p.before.value)} (n=${p.before.n})`;
      const after = p.after.value === null ? 'unknown' : `${pct(p.after.value)} (n=${p.after.n})`;
      lines.push(`| ${p.classId} | ${p.variant} | ${before} | ${after} | ${pts(p.liftPoints)} |`);
    }
    lines.push('');
  }
  lines.push(
    'Merge-rate intervals are Wilson score; cost/wall intervals are seeded bootstrap. Only counterfactually-covered decisions are observed — the gate refuses promotion on thin coverage.',
    '',
  );
  return lines.join('\n');
}
