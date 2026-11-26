/**
 * Lessons trial: does serving approved lessons (learn/retro knowledge notes)
 * make cloud runs land more often? Answered by a randomized holdout, not by
 * hit counts.
 *
 * At launch, a task with applicable notes is assigned an arm from a hash of
 * its id: `served` gets the lessons block, `holdout` (a fixed fraction) gets
 * the same prompt without it. Both arms record which notes applied, so the
 * comparison is between runs that were eligible for the same lessons. A run
 * lands when its PR merged and was not reverted afterwards; a launch failure
 * never reached the agent, so it counts in neither arm.
 *
 * Unknown stays unknown: below MIN_ARM_TASKS per arm the effect and verdict
 * are null / 'unknown', never 0. Promotion evidence also requires every
 * task family to have enough samples and no observed regression.
 */
import { createHash } from 'node:crypto';
import type { CloudTaskV1 } from '../cloud/types.js';

export type LessonArm = 'served' | 'holdout';

/** Share of eligible launches that run without lessons, so the effect is measurable. */
export const DEFAULT_LESSON_HOLDOUT = 0.2;
/** Above this the holdout would cost more runs their lessons than the measurement is worth. */
export const MAX_LESSON_HOLDOUT = 0.5;
export const MIN_ARM_TASKS = 3;
export const HARNESS_TASK_FAMILIES = ['repair', 'test-writing', 'refactor'] as const;
export const MIN_FAMILY_PAIRED = MIN_ARM_TASKS;

/** `ASHLR_LESSON_HOLDOUT` (0 turns the holdout off), clamped to [0, MAX_LESSON_HOLDOUT]. */
export function lessonHoldoutFraction(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ASHLR_LESSON_HOLDOUT'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_LESSON_HOLDOUT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LESSON_HOLDOUT;
  return Math.min(MAX_LESSON_HOLDOUT, Math.max(0, n));
}

/** Deterministic per task, so a relaunch of the same task id keeps its arm. */
export function lessonArm(taskId: string, holdout: number = lessonHoldoutFraction()): LessonArm {
  if (!(holdout > 0)) return 'served';
  const u = parseInt(createHash('sha256').update(`lessons:${taskId}`).digest('hex').slice(0, 8), 16) / 0x1_0000_0000;
  return u < holdout ? 'holdout' : 'served';
}

export interface ArmStats { tasks: number; landed: number; rate: number | null }

interface FamilyRun {
  family: string;
  arm: 'candidate' | 'incumbent';
  passed: boolean;
}

export interface FamilyEvidence {
  family: string;
  candidate: ArmStats;
  incumbent: ArmStats;
  delta: number | null;
  verdict: 'improves' | 'holds' | 'regresses' | 'unknown';
}

export interface FamilyPromotionGate {
  families: FamilyEvidence[];
  aggregate: Pick<FamilyEvidence, 'candidate' | 'incumbent' | 'delta'>;
  promote: boolean;
  refusals: { family: string; reason: 'regressed' | 'insufficient-samples' }[];
  retained: 'incumbent' | 'candidate';
}

export interface LessonEffect {
  /** 'all' for every eligible run, else one knowledge note id. */
  scope: string;
  served: ArmStats;
  holdout: ArmStats;
  /** served.rate − holdout.rate; null below MIN_ARM_TASKS in either arm. */
  delta: number | null;
  /** Normal-approximation 95% interval for delta; null with delta. */
  ci95: [number, number] | null;
  verdict: 'helps' | 'hurts' | 'no-difference' | 'unknown';
}

export interface LessonTrialReport {
  holdout: number;
  overall: LessonEffect;
  /** One row per note that applied to at least one finished run, most-served first. */
  byNote: LessonEffect[];
  byFamily: FamilyPromotionGate;
  /** Finished eligible runs left out, and why. */
  excluded: { launchFailed: number; unfinished: number };
}

const FINISHED = new Set<CloudTaskV1['state']>(['merged', 'closed', 'expired']);

/** `owner/name#number`, the key reverted PRs are passed in under. */
export const prKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

function stats(runs: readonly { landed: boolean }[]): ArmStats {
  const landed = runs.filter((r) => r.landed).length;
  return { tasks: runs.length, landed, rate: runs.length ? landed / runs.length : null };
}

/** Compare preselected cohorts for one candidate and incumbent under the same evaluation envelope. */
export function familyPromotionGate(
  runs: readonly FamilyRun[],
  opts: { families?: readonly string[]; minPerArm?: number } = {},
): FamilyPromotionGate {
  const min = opts.minPerArm ?? MIN_FAMILY_PAIRED;
  if (!Number.isSafeInteger(min) || min < 1) throw new RangeError('minPerArm must be a positive safe integer');
  const cohorts = new Map<string, FamilyRun[]>((opts.families ?? HARNESS_TASK_FAMILIES).map((family) => [family, []]));
  for (const run of runs) {
    const cohort = cohorts.get(run.family);
    if (cohort) cohort.push(run);
    else cohorts.set(run.family, [run]);
  }
  const compare = (cohort: readonly FamilyRun[]): FamilyPromotionGate['aggregate'] => {
    const tally = (arm: FamilyRun['arm']) => stats(cohort.filter((r) => r.arm === arm).map((r) => ({ landed: r.passed })));
    const candidate = tally('candidate');
    const incumbent = tally('incumbent');
    const delta = candidate.tasks >= min && incumbent.tasks >= min && candidate.rate !== null && incumbent.rate !== null
      ? candidate.rate - incumbent.rate : null;
    return { candidate, incumbent, delta };
  };
  const refusals: FamilyPromotionGate['refusals'] = [];
  const families = [...cohorts].map(([family, cohort]): FamilyEvidence => {
    const evidence = compare(cohort);
    const { delta } = evidence;
    const verdict = delta === null ? 'unknown' : delta < 0 ? 'regresses' : delta > 0 ? 'improves' : 'holds';
    if (verdict === 'unknown') refusals.push({ family, reason: 'insufficient-samples' });
    if (verdict === 'regresses') refusals.push({ family, reason: 'regressed' });
    return { family, ...evidence, verdict };
  });
  const promote = families.length > 0 && refusals.length === 0;
  return { families, aggregate: compare(runs), promote, refusals, retained: promote ? 'candidate' : 'incumbent' };
}

function effect(scope: string, runs: readonly { arm: LessonArm; landed: boolean }[]): LessonEffect {
  const served = stats(runs.filter((r) => r.arm === 'served'));
  const holdout = stats(runs.filter((r) => r.arm === 'holdout'));
  if (served.tasks < MIN_ARM_TASKS || holdout.tasks < MIN_ARM_TASKS || served.rate === null || holdout.rate === null) {
    return { scope, served, holdout, delta: null, ci95: null, verdict: 'unknown' };
  }
  const delta = served.rate - holdout.rate;
  const se = Math.sqrt(served.rate * (1 - served.rate) / served.tasks + holdout.rate * (1 - holdout.rate) / holdout.tasks);
  const ci95: [number, number] = [delta - 1.96 * se, delta + 1.96 * se];
  const verdict = ci95[0] > 0 ? 'helps' : ci95[1] < 0 ? 'hurts' : 'no-difference';
  return { scope, served, holdout, delta, ci95, verdict };
}

/**
 * The trial's result over cloud task files. A run did not land when its task
 * records a revert (`outcome.revertedBy`) or `reverted` holds its `prKey`
 * (improve-ledger reverts); both come from `phm improve observe`.
 */
export function lessonTrial(tasks: readonly CloudTaskV1[], reverted: ReadonlySet<string> = new Set(), holdout: number = lessonHoldoutFraction()): LessonTrialReport {
  const excluded = { launchFailed: 0, unfinished: 0 };
  const runs: { arm: LessonArm; landed: boolean; noteIds: readonly string[]; family: string }[] = [];
  for (const t of tasks) {
    if (!t.lessons || t.lessons.noteIds.length === 0) continue;
    if (t.state === 'failed') { excluded.launchFailed += 1; continue; }
    if (!FINISHED.has(t.state)) { excluded.unfinished += 1; continue; }
    const landed = t.state === 'merged' && !t.outcome?.revertedBy && !(t.pr && reverted.has(prKey(t.repo, t.pr.number)));
    runs.push({ arm: t.lessons.arm, landed, noteIds: t.lessons.noteIds, family: t.lessons.family ?? 'unclassified' });
  }
  const ids = new Map<string, number>();
  for (const r of runs) for (const id of new Set(r.noteIds)) ids.set(id, (ids.get(id) ?? 0) + 1);
  const byNote = [...ids.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => effect(id, runs.filter((r) => r.noteIds.includes(id))));
  const byFamily = familyPromotionGate(runs.map((r) => ({
    family: r.family, arm: r.arm === 'served' ? 'candidate' : 'incumbent', passed: r.landed,
  })));
  return { holdout, overall: effect('all', runs), byNote, byFamily, excluded };
}

const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
const arm = (s: ArmStats) => `${s.landed}/${s.tasks} landed (${pct(s.rate)})`;
const pts = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n * 100)}`;

export function renderLessonEffect(e: LessonEffect): string {
  const head = `${e.scope === 'all' ? 'All eligible runs' : `Note ${e.scope}`}: with lessons ${arm(e.served)}, without ${arm(e.holdout)}`;
  if (e.delta === null) return `${head}; effect unknown (needs ${MIN_ARM_TASKS}+ finished runs in each arm)`;
  return `${head}; effect ${pts(e.delta)} points (95% CI ${pts(e.ci95![0])} to ${pts(e.ci95![1])}), ${e.verdict}`;
}

export function renderFamilyPromotion(gate: FamilyPromotionGate): string {
  const decision = gate.promote ? 'Family gate: candidate eligible' : 'Family gate: promotion refused; retain incumbent';
  const rows = gate.families.map((row) => {
    const delta = row.delta === null ? 'insufficient samples' : `${pts(row.delta)} points`;
    return `  ${row.family}: candidate ${arm(row.candidate)}, incumbent ${arm(row.incumbent)}; ${row.verdict} (${delta})`;
  });
  return [decision, ...rows].join('\n');
}
