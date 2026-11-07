/**
 * prompt-variants.ts — RQ-SELFOPT-PROMPT-OPT: prompt-variant registry, job
 * classes and live assignment for the router queue.
 *
 * A prompt variant is the template the router wraps a job's task in before
 * dispatch. Variants are first-class arms in the outcome logs (`prompt:plain`,
 * `prompt:adaptive`), so the router-eval harness can replay them over frozen
 * history and the prompt-ab engine can promote a winner per job class.
 *
 *   - PROMPT_VARIANTS holds the shipping templates; `renderPrompt` produces
 *     the dispatched prompt text for a job.
 *   - A PromptExperimentSpec declares job classes (matchers over the
 *     router-time fields) and each class's control + challenger arms.
 *   - `assignPromptVariant` is the dispatch-time seam: a promoted class gets
 *     its winner; a class mid-experiment gets a deterministic A/B bucket by
 *     job id; anything unmatched keeps the incumbent control.
 */

import { createHash } from 'node:crypto';

import type { PolicyJobView } from './router-eval.js';
import type { PromptPromotionsRegistry } from './prompt-promotions.js';

// ---------------------------------------------------------------------------
// Prompt variants (the templates under test)
// ---------------------------------------------------------------------------

export interface PromptVariant {
  /** Arm id recorded in outcome logs and dataset candidates. */
  arm: string;
  label: string;
  /** One line — what this template changes about the dispatched prompt. */
  summary: string;
  /** Build the prompt text dispatched with the job. */
  render(job: PolicyJobView): string;
}

function taskOf(job: PolicyJobView): string {
  return (job.task ?? '').trim();
}

/** Incumbent: the bare task line the router has always sent. */
const PLAIN: PromptVariant = {
  arm: 'prompt:plain',
  label: 'Plain task prompt',
  summary: 'Bare task line — the incumbent dispatch prompt.',
  render: (job) => taskOf(job),
};

/**
 * Challenger: a class-aware structured prompt. Adds the routing context the
 * plain prompt drops (repo, tier, priority), a numbered acceptance contract
 * and the verification/scope rules, so the agent knows what "done" means
 * before it starts.
 */
const ADAPTIVE: PromptVariant = {
  arm: 'prompt:adaptive',
  label: 'Adaptive structured prompt',
  summary: 'Task + routing context + acceptance contract + verify/scope rules.',
  render: (job) => {
    const lines: string[] = [taskOf(job)];
    const context: string[] = [];
    if (job.repo !== undefined) context.push(`repo ${job.repo}`);
    if (job.tier !== undefined) context.push(`tier ${job.tier}`);
    if (job.priority !== undefined) context.push(`priority ${job.priority}`);
    if (context.length > 0) lines.push('', `Context: ${context.join(', ')}.`);
    lines.push(
      '',
      'Acceptance:',
      '1. The change is complete and self-contained — no follow-up required to build, lint or test.',
      '2. Scope stays inside this task; unrelated files are untouched.',
      '',
      'Verify before reporting done: run the checks that cover what you changed and fix what fails.',
    );
    return lines.join('\n');
  },
};

export const PROMPT_VARIANTS: readonly PromptVariant[] = [PLAIN, ADAPTIVE];

export function promptVariant(arm: string): PromptVariant | undefined {
  return PROMPT_VARIANTS.find((v) => v.arm === arm);
}

/** Render the dispatched prompt for a variant arm; unknown arms throw. */
export function renderPrompt(arm: string, job: PolicyJobView): string {
  const variant = promptVariant(arm);
  if (!variant) throw new Error(`unknown prompt variant '${arm}'`);
  return variant.render(job);
}

// ---------------------------------------------------------------------------
// Job classes and the experiment spec
// ---------------------------------------------------------------------------

/** Router-time matchers; every set field must match (AND). */
export interface PromptClassMatch {
  /** Case-insensitive regex against the job's task text. */
  task?: string;
  repo?: string;
  tier?: string;
  priority?: string;
}

export interface PromptClassSpec {
  id: string;
  match: PromptClassMatch;
  /** Incumbent arm — the "before" column. */
  control: string;
  /** Challenger arms under test. */
  challengers: string[];
}

export interface PromotionGateSpec {
  /** Resolved (observed) jobs required per arm before any verdict. */
  minResolvedPerArm: number;
  /** Max share of cohort decisions allowed to resolve 'unobserved'. */
  maxUnobservedShare: number;
  /** Challenger cost-per-merge may exceed control by at most this fraction. */
  costRegressionTolerance: number;
}

export const DEFAULT_PROMOTION_GATE: PromotionGateSpec = {
  minResolvedPerArm: 8,
  maxUnobservedShare: 0.25,
  costRegressionTolerance: 0.5,
};

export interface PromptExperimentSpec {
  v: 1;
  id: string;
  note?: string;
  classes: PromptClassSpec[];
  gate?: Partial<PromotionGateSpec>;
}

interface CompiledClass extends PromptClassSpec {
  taskRe?: RegExp;
}

function compileClass(cls: PromptClassSpec, specId: string): CompiledClass {
  if (typeof cls.id !== 'string' || cls.id === '') {
    throw new Error(`prompt-ab spec ${specId}: class needs an id`);
  }
  if (typeof cls.control !== 'string' || cls.control === '') {
    throw new Error(`prompt-ab spec ${specId}: class ${cls.id} needs a control arm`);
  }
  if (!Array.isArray(cls.challengers) || cls.challengers.length === 0
    || cls.challengers.some((c) => typeof c !== 'string' || c === '')) {
    throw new Error(`prompt-ab spec ${specId}: class ${cls.id} needs challenger arms`);
  }
  if (cls.challengers.includes(cls.control)) {
    throw new Error(`prompt-ab spec ${specId}: class ${cls.id} lists its control as a challenger`);
  }
  const match = cls.match ?? {};
  for (const key of ['repo', 'tier', 'priority'] as const) {
    if (match[key] !== undefined && typeof match[key] !== 'string') {
      throw new Error(`prompt-ab spec ${specId}: class ${cls.id} match.${key} must be a string`);
    }
  }
  let taskRe: RegExp | undefined;
  if (match.task !== undefined) {
    if (typeof match.task !== 'string') {
      throw new Error(`prompt-ab spec ${specId}: class ${cls.id} match.task must be a string`);
    }
    try {
      taskRe = new RegExp(match.task, 'i');
    } catch {
      throw new Error(`prompt-ab spec ${specId}: class ${cls.id} match.task is not a valid regex`);
    }
  }
  return { ...cls, match, taskRe };
}

/** Parse and validate an experiment spec; malformed input throws. */
export function parsePromptExperimentSpec(value: unknown): PromptExperimentSpec {
  const rec = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!rec) throw new Error('prompt-ab spec must be an object');
  if (rec.v !== 1) throw new Error(`prompt-ab spec: unsupported v ${JSON.stringify(rec.v)}`);
  const id = rec.id;
  if (typeof id !== 'string' || id === '') throw new Error('prompt-ab spec needs an id');
  if (!Array.isArray(rec.classes) || rec.classes.length === 0) {
    throw new Error('prompt-ab spec needs at least one job class');
  }
  const classes = (rec.classes as PromptClassSpec[]).map((c) => compileClass(c, id));
  const seen = new Set<string>();
  for (const cls of classes) {
    if (seen.has(cls.id)) throw new Error(`prompt-ab spec ${id}: duplicate class id ${cls.id}`);
    seen.add(cls.id);
  }
  const gate: Partial<PromotionGateSpec> = {};
  if (rec.gate !== undefined) {
    const g = rec.gate as Record<string, unknown>;
    if (g === null || typeof g !== 'object' || Array.isArray(g)) {
      throw new Error('prompt-ab spec gate must be an object');
    }
    for (const key of ['minResolvedPerArm', 'maxUnobservedShare', 'costRegressionTolerance'] as const) {
      const v = g[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`prompt-ab spec gate.${key} must be a non-negative number`);
      }
      gate[key] = v;
    }
  }
  return {
    v: 1,
    id,
    ...(typeof rec.note === 'string' ? { note: rec.note } : {}),
    classes,
    ...(Object.keys(gate).length > 0 ? { gate } : {}),
  };
}

export function promptGate(spec: PromptExperimentSpec): PromotionGateSpec {
  return { ...DEFAULT_PROMOTION_GATE, ...(spec.gate ?? {}) };
}

/** First matching class wins — spec order is the precedence order. */
export function classifyPromptJob(job: PolicyJobView, spec: PromptExperimentSpec): string | null {
  for (const cls of spec.classes as CompiledClass[]) {
    const m = cls.match;
    // Parsed specs carry a compiled taskRe; a raw spec object must honor
    // match.task the same way — never silently drop the matcher.
    const taskRe = cls.taskRe ?? (m.task !== undefined ? new RegExp(m.task, 'i') : undefined);
    if (taskRe !== undefined && !taskRe.test(job.task ?? '')) continue;
    if (m.repo !== undefined && m.repo !== job.repo) continue;
    if (m.tier !== undefined && m.tier !== job.tier) continue;
    if (m.priority !== undefined && m.priority !== job.priority) continue;
    return cls.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live assignment (the dispatch-time seam)
// ---------------------------------------------------------------------------

export interface PromptAssignment {
  /** Variant arm to dispatch, or null when the job matches no class. */
  arm: string | null;
  classId: string | null;
  /** Why this arm: promoted winner, A/B bucket, or no experiment coverage. */
  mode: 'promoted' | 'ab' | 'none';
  reason: string;
}

/** Deterministic 32-bit hash of a string (sha256 head) for stable bucketing. */
function hash32(text: string): number {
  const digest = createHash('sha256').update(text, 'utf8').digest();
  return digest.readUInt32BE(0);
}

/**
 * The dispatch-time decision. A class with a promoted variant always gets it;
 * a class mid-experiment splits jobs across [control, ...challengers] by a
 * stable hash of the job id (same job → same arm, every replay); a job outside
 * every class returns arm=null so the caller keeps incumbent behavior.
 */
export function assignPromptVariant(
  job: PolicyJobView,
  spec: PromptExperimentSpec,
  promotions?: PromptPromotionsRegistry | null,
): PromptAssignment {
  const classId = classifyPromptJob(job, spec);
  if (classId === null) {
    return { arm: null, classId: null, mode: 'none', reason: 'no experiment class matches' };
  }
  const promoted = promotions?.promoted.find((p) => p.classId === classId);
  if (promoted) {
    return { arm: promoted.variant, classId, mode: 'promoted', reason: `promoted winner of ${promoted.experimentId}` };
  }
  const cls = spec.classes.find((c) => c.id === classId)!;
  const arms = [cls.control, ...cls.challengers];
  const arm = arms[hash32(`${spec.id}:${classId}:${job.id}`) % arms.length]!;
  return { arm, classId, mode: 'ab', reason: `deterministic bucket of ${spec.id}` };
}
