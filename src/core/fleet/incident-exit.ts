/**
 * core/fleet/incident-exit.ts — classify an agent exit before it becomes an incident.
 *
 * A plan-limit exit (the account ran out of quota) is not a defect in the
 * repository: a fix job cannot repair it and would only burn another run
 * against the same wall. It is reported with its reset time instead. Only a
 * real crash may open a fix job; an exit with no usable evidence is `unknown`
 * and is never promoted to a crash on a guess.
 *
 * Pure: no IO, no clock except the injected `nowMs`. The limit matcher and
 * the strict "try again at <date>" parse are the shared ones, not copies.
 */
import { isUsageLimitText } from '../classify/engine-errors.js';
import { parseResetAt } from './planner-failover.js';

export const EXIT_CLASS_SCHEMA = 'fleet.incident-exit.v1';
export type ExitKind = 'plan-limit' | 'crash' | 'unknown';

export interface ExitEvidence {
  /** Process exit code when known. */
  exitCode?: number | null;
  /** Message or log tail. Treated as data only; never echoed. */
  text?: string | null;
  nowMs: number;
}

export interface ExitClassification {
  v: 1;
  schema: typeof EXIT_CLASS_SCHEMA;
  kind: ExitKind;
  /** Local ISO reset time for plan-limit exits; null when none was advertised or parseable. */
  resetAt: string | null;
  exitCode: number | null;
  /** True only for `crash`: the one kind that may open a repository fix job. */
  fixable: boolean;
  /** Short plain-words reason. */
  reason: string;
}

const CRASH = /\b(?:uncaught|unhandled|exception|traceback|panic(?:ked)?|segfault|segmentation fault|stack trace|fatal error|sig(?:segv|abrt|bus|ill)|core dumped|out of memory|oom)\b/i;
const RELATIVE = /(?:resets?|try again|retry) in\s+(?:(\d{1,3})\s*(?:hours?|hrs?|h))?\s*(?:(\d{1,3})\s*(?:minutes?|mins?|m))?/i;

function relativeReset(text: string, nowMs: number): string | null {
  const m = RELATIVE.exec(text);
  const ms = m ? (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000 : 0;
  if (!ms || ms > 14 * 24 * 3_600_000) return null;
  return new Date(nowMs + ms).toISOString();
}

export function classifyExit(evidence: ExitEvidence): ExitClassification {
  const text = typeof evidence.text === 'string' ? evidence.text : '';
  const code = typeof evidence.exitCode === 'number' && Number.isFinite(evidence.exitCode) ? Math.trunc(evidence.exitCode) : null;
  const done = (kind: ExitKind, reason: string, resetAt: string | null = null): ExitClassification =>
    ({ v: 1, schema: EXIT_CLASS_SCHEMA, kind, resetAt, exitCode: code, fixable: kind === 'crash', reason });

  const reset = parseResetAt(text) ?? relativeReset(text, evidence.nowMs);
  if (isUsageLimitText(text) || reset !== null) {
    return done('plan-limit', reset ? `Plan limit reached; resets ${reset}.` : 'Plan limit reached; no reset time was given.', reset);
  }
  if (CRASH.test(text) && code !== 0) return done('crash', 'The run crashed.');
  return done('unknown', code === null || code === 0 ? 'No failure evidence.' : `Exit ${code} with no known cause.`);
}
