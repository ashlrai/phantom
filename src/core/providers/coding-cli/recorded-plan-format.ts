/**
 * Pure text rendering of an archived (recorded) coding-CLI worker plan.
 *
 * Provenance: recovered from Phantom PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * `src/core/providers/coding-cli/worker-plan.ts` `formatPlan` (lines 241-257). Only the
 * renderer and local structural input types are kept; the planner, catalog, accounts,
 * routing and execution closure of that PR are deliberately not inherited.
 *
 * Deliberate differences from the source `formatPlan`:
 * - A first line states this is a historical recorded plan that grants no execution
 *   or spend authority. `execute` / `metered: enabled` are recorded facts only.
 * - Input is validated (malformed structure throws a TypeError naming the path)
 *   instead of being coerced into a plausible plan.
 * - Text fields may not contain line breaks, so a recorded value cannot forge rows.
 *
 * No filesystem, env, clock, subprocess or provider access; the input is never mutated.
 */

export const RECORDED_PLAN_BANNER =
  'historical recorded plan: grants no execution or spend authority; execute/metered values below are recorded facts, not current authorization';

export interface RecordedPlanStep {
  number: number;
  title: string;
  action: 'run' | 'skip';
  reason: string;
  backend?: string | null;
  billing?: string | null;
  model?: string | null;
  role?: string | null;
  accountId?: string | null;
  poolId?: string | null;
  worktree?: string | null;
  pullRequest?: 'draft' | null;
}

export interface RecordedPlan {
  dryRun: boolean;
  meteredEnabled: boolean;
  steps: readonly RecordedPlanStep[];
}

const OPTIONAL_ROWS = [
  ['backend', 'backend'],
  ['billing', 'billing'],
  ['role', 'role'],
  ['accountId', 'account'],
  ['poolId', 'pool'],
  ['model', 'model'],
  ['worktree', 'worktree'],
  ['pullRequest', 'pr'],
] as const;

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new TypeError(`recorded plan: ${path} must be a string`);
  if (/[\r\n]/.test(value)) throw new TypeError(`recorded plan: ${path} must not contain line breaks`);
  return value;
}

function validate(plan: unknown): asserts plan is RecordedPlan {
  if (typeof plan !== 'object' || plan === null) throw new TypeError('recorded plan: plan must be an object');
  const p = plan as Record<string, unknown>;
  if (typeof p.dryRun !== 'boolean') throw new TypeError('recorded plan: dryRun must be a boolean');
  if (typeof p.meteredEnabled !== 'boolean') throw new TypeError('recorded plan: meteredEnabled must be a boolean');
  if (!Array.isArray(p.steps)) throw new TypeError('recorded plan: steps must be an array');
  p.steps.forEach((raw: unknown, i) => {
    const at = `steps[${i}]`;
    if (typeof raw !== 'object' || raw === null) throw new TypeError(`recorded plan: ${at} must be an object`);
    const s = raw as Record<string, unknown>;
    if (!Number.isInteger(s.number)) throw new TypeError(`recorded plan: ${at}.number must be an integer`);
    text(s.title, `${at}.title`);
    if (s.action !== 'run' && s.action !== 'skip') throw new TypeError(`recorded plan: ${at}.action must be 'run' or 'skip'`);
    text(s.reason, `${at}.reason`);
    for (const [key] of OPTIONAL_ROWS) {
      const v = s[key];
      if (v !== undefined && v !== null) text(v, `${at}.${key}`);
    }
    if (s.pullRequest !== undefined && s.pullRequest !== null && s.pullRequest !== 'draft') {
      throw new TypeError(`recorded plan: ${at}.pullRequest must be 'draft' or null`);
    }
  });
}

/** Render one caller-supplied archived plan as deterministic text. */
export function formatRecordedPlan(plan: RecordedPlan): string {
  validate(plan);
  const lines = [
    RECORDED_PLAN_BANNER,
    `worker plan (${plan.dryRun ? 'dry-run' : 'execute'})`,
    `metered: ${plan.meteredEnabled ? 'enabled' : 'disabled'}`,
    `steps: ${plan.steps.length}`,
  ];
  for (const step of plan.steps) {
    lines.push(`#${step.number} ${step.title}`, `  action: ${step.action}`, `  reason: ${step.reason}`);
    for (const [key, label] of OPTIONAL_ROWS) {
      const v = step[key];
      if (v) lines.push(`  ${label}: ${v}`);
    }
  }
  return lines.join('\n');
}
