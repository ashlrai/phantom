export const FLEET_EMPTY_WHY_LOG_LINES = 60;
export const FLEET_EMPTY_WHY_REASONS = ['lint-env', 'interrupted', 'blocked', 'limit', 'other'] as const;
export type FleetEmptyWhyReason = (typeof FLEET_EMPTY_WHY_REASONS)[number];

// Checked in order; the first match wins.
const RULES: ReadonlyArray<readonly [FleetEmptyWhyReason, RegExp]> = [
  ['lint-env', /eslint|lib\/cli/i],
  ['interrupted', /\bexit(?:ed|\s+code|\s+status)?\b\D{0,12}130\b/i],
  ['blocked', /\bblocked\b|not implemented|\bincomplete\b/i],
  ['limit', /usage limit|rate[ -]?limit/i],
];

/** Pure: tag one log by its last lines. */
export function classifyEmptyLog(log: string | null): FleetEmptyWhyReason {
  if (log === null) return 'other';
  const tail = log.split('\n').slice(-FLEET_EMPTY_WHY_LOG_LINES).join('\n');
  return RULES.find(([, re]) => re.test(tail))?.[0] ?? 'other';
}

/** Stable, exhaustive reasons for `jobs empty`; legacy log tags above remain compatible. */
export const EMPTY_JOB_REASONS = ['already-on-master', 'no-op change', 'scope too vague',
  'sandbox or permission denial', 'test or typecheck failed and was reverted', 'timed out',
  'provider quota or rate limit', 'tool error', 'unknown'] as const;
export type EmptyJobDiagnosis = typeof EMPTY_JOB_REASONS[number];

// First match wins across both tails. Specific failures outrank incidental no-change wording.
// A bare RESULT EMPTY proves the outcome, never its cause. See docs/FLEET-EMPTIES.md.
const DIAGNOSIS_RULES: ReadonlyArray<readonly [EmptyJobDiagnosis, RegExp]> = [
  ['sandbox or permission denial', /\b(?:EPERM|EACCES)\b|permission denied|operation not permitted|\bsandbox[^\n]{0,40}\b(?:denied|blocked)\b/i],
  ['provider quota or rate limit', /\b(?:usage|quota|rate)[ -]?limit|quota exhausted|insufficient_quota|\b(?:HTTP|status(?: code)?) 429\b/i],
  ['test or typecheck failed and was reverted', /\b(?:tests?|typecheck|tsc|tsgo)\b[^\n]{0,80}\b(?:failed|errors?)\b[\s\S]{0,120}\b(?:reverted|rolled back|discarded changes)\b/i],
  ['timed out', /\btimed out\b|\btimeout (?:after|exceeded)\b|deadline exceeded/i],
  ['tool error', /command not found|\bspawn \S+ ENOENT\b|\b(?:tool|MCP|eslint|API)\b[^\n]{0,40}\b(?:error|failed|crashed|unavailable)\b/i],
  ['already-on-master', /\balready (?:on|in|landed on|merged (?:in|to|into)) (?:origin\/)?(?:master|main)\b|EMPTY_REASON: duplicate-landed\b/i],
  ['no-op change', /\bno changes? (?:is |are |was |were )?needed\b|\bnothing to change\b|\bno[- ]op change\b|EMPTY_REASON: no-change-needed\b/i],
  ['scope too vague', /\b(?:scope|goal|task|prompt) (?:is |was )?(?:too vague|unclear|underspecified)\b|EMPTY_REASON: prompt-unclear\b/i],
];
export function diagnoseEmptyJob(log: string | null, publish: string | null): EmptyJobDiagnosis {
  const texts = [publish, log].map(text => (text ?? '').split(/\r?\n/).slice(-FLEET_EMPTY_WHY_LOG_LINES).join('\n'));
  return DIAGNOSIS_RULES.find(([, pattern]) => texts.some(text => pattern.test(text)))?.[0] ?? 'unknown';
}

export const EMPTY_JOB_SUGGESTIONS: Record<EmptyJobDiagnosis, string> = {
  'already-on-master': 'stop queuing this family',
  'no-op change': 'stop queuing this family',
  'scope too vague': 'make the goal concrete',
  'sandbox or permission denial': 'restore the required tool access',
  'test or typecheck failed and was reverted': 'route to frontier',
  'timed out': 'split the goal into smaller jobs',
  'provider quota or rate limit': 'wait for provider capacity before retrying',
  'tool error': 'repair the failing tool before retrying',
  unknown: 'record a concrete reason in the final job log',
};

/** A worker stopped because its model or plan hit a usage cap. `model` is null when the log does not name one. */
export interface PoolCapHit { model: string | null; kind: 'model-limit' | 'plan-limit' | 'rate-limit' }

// Specific wording first. The model name is a single word, so "reached your Fable limit" names Fable.
const POOL_CAP_RULES: ReadonlyArray<readonly [PoolCapHit['kind'], RegExp]> = [
  ['model-limit', /you(?:'|’)ve (?:reached|hit) (?:your|the) ([A-Za-z][\w.-]{1,40}) (?:usage )?limit\b/i],
  ['plan-limit', /you(?:'|’)ve (?:reached|hit) (?:your|the) (?:usage|plan|weekly|daily|5-hour) limit\b|you(?:(?:'|’)ve| have) hit your usage limit|usage limit (?:reached|hit)\b|usage_limit_reached|exceeded your (?:current )?(?:usage|plan) (?:limit|quota)/i],
  ['rate-limit', /\brate[ -]?limit(?:ed| exceeded| reached)\b|\bquota (?:exceeded|exhausted)\b|insufficient_quota|resource_exhausted/i],
];

/**
 * Pure: does the final worker output say a model or plan limit was reached? Same tail window as the other
 * empty reasons. Plain "auth failed" and ordinary empties return null, so they keep their own labels.
 */
export function detectPoolCap(log: string | null): PoolCapHit | null {
  if (log === null) return null;
  const tail = log.split(/\r?\n/).slice(-FLEET_EMPTY_WHY_LOG_LINES).join('\n');
  for (const [kind, pattern] of POOL_CAP_RULES) {
    const match = pattern.exec(tail);
    if (!match) continue;
    const named = match[1]?.toLowerCase();
    // "reached your usage limit" captures the word "usage"; that is a plan limit, not a model.
    if (named && ['usage', 'plan', 'weekly', 'daily', 'rate', 'monthly', 'free'].includes(named)) return { model: null, kind: 'plan-limit' };
    return { model: named ?? null, kind };
  }
  return null;
}
