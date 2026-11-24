/**
 * Offline job-shape heuristic, recovered from the source PR #5952 at head
 * 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886 (src/core/decide/job-shape.ts).
 *
 * Only the heuristic is preserved. The source's Jev/model path, its decide()
 * import and its router policy are deliberately absent: this module never
 * calls a model, never grants dispatch, admission or spend authority, and
 * does not change routing. The band names and thresholds below are copied
 * from the source; the source's registry constants are inlined so this file
 * does not depend on src/core/decide.
 *
 * Provenance of `contextTokens`: it is a UTF-16 code-unit count of the input
 * text, capped at CONTEXT_CAP. It is a character-length heuristic. It is not
 * measured provider tokens and must never be reported as token usage.
 */

export const JOB_SHAPE_SOURCE = {
  pr: 5952,
  head: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  path: 'src/core/decide/job-shape.ts',
  preserved_as: 'src/core/fleet/recorded-job-shape.ts',
  dropped: ['jev model path', 'decide() import', 'router policy and registry hunks'],
} as const;

export const JOB_BANDS = ['low', 'medium', 'high'] as const;
export const JOB_LATENCIES = ['interactive', 'batch'] as const;

export type JobBand = (typeof JOB_BANDS)[number];
export type JobLatency = (typeof JOB_LATENCIES)[number];

/** Source JobShape. `source` is always 'heuristic' here: the Jev path is not recovered. */
export interface JobShape {
  complexity: JobBand;
  risk: JobBand;
  contextTokens: number;
  latency: JobLatency;
  source: 'heuristic';
}

/** Largest measured text length; longer input is counted as this cap. */
export const CONTEXT_CAP = 200_000;
const COMPLEX_LENGTH_HIGH = 8_000;
const COMPLEX_LENGTH_MEDIUM = 800;

// Conservative on purpose: any single security-flavoured word escalates risk.
const RISK_HIGH = /\b(security|credential|credentials|auth|merge|secret|secrets|token|vulnerability)\b/i;
const COMPLEX_HIGH = /\b(architecture|migration|migrate|redesign)\b/i;
const LATENCY_NOW = /\b(urgent|asap|immediately|now)\b/i;

/** Measurement description carried beside the shape so output cannot be read as provider usage. */
export const CONTEXT_MEASUREMENT = {
  unit: 'utf16_code_units',
  cap: CONTEXT_CAP,
  heuristic: true,
  provider_tokens: false,
  description: 'Character-length heuristic (UTF-16 code units, capped). Not measured provider tokens; not usage or billing data.',
} as const;

/** Classify text offline. Never throws; non-string input is treated as empty. */
export function jobShapeHeuristic(text: string): JobShape {
  const body = typeof text === 'string' ? text : '';
  const length = Math.min(CONTEXT_CAP, body.length);
  let complexity: JobBand = 'low';
  if (COMPLEX_HIGH.test(body) || length >= COMPLEX_LENGTH_HIGH) complexity = 'high';
  else if (length >= COMPLEX_LENGTH_MEDIUM) complexity = 'medium';
  return {
    complexity,
    risk: RISK_HIGH.test(body) ? 'high' : 'low',
    contextTokens: length,
    latency: LATENCY_NOW.test(body) ? 'interactive' : 'batch',
    source: 'heuristic',
  };
}
