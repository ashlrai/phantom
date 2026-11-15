/**
 * work-result-form-model.ts — pure helpers for the Fleet Board "Record result"
 * form (RQ-PHX-WORKRESULTFORM340). Same rules as `ashlr fleet work-result`:
 * exactly one form of result; blocked is 1..200 chars and never "unknown".
 */
export type WorkResultKind = 'pr' | 'tests' | 'artifact' | 'blocked';

export interface WorkResultForm {
  kind: WorkResultKind;
  /** PR number text (kind 'pr') or the single text value for the other kinds. */
  value: string;
  /** Head sha, only used by kind 'pr'. */
  head?: string;
}

export type WorkResultPayload =
  | { pr: number; head: string }
  | { tests: string }
  | { artifact: string }
  | { blocked: string };

export const BLOCKED_MAX = 200;

export type BuildResult = { ok: true; result: WorkResultPayload } | { ok: false; message: string };

export function buildWorkResultBody(form: WorkResultForm): BuildResult {
  const value = form.value.trim();
  switch (form.kind) {
    case 'pr': {
      const head = (form.head ?? '').trim();
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
        return { ok: false, message: 'PR must be a positive whole number.' };
      }
      if (head === '') return { ok: false, message: 'A PR result needs the head commit.' };
      return { ok: true, result: { pr: Number(value), head } };
    }
    case 'tests':
      return value === '' ? { ok: false, message: 'Describe the tests that ran.' } : { ok: true, result: { tests: value } };
    case 'artifact':
      return value === '' ? { ok: false, message: 'Name the artifact.' } : { ok: true, result: { artifact: value } };
    case 'blocked':
      if (value === '') return { ok: false, message: 'Name what the work is blocked on.' };
      if (value.length > BLOCKED_MAX) return { ok: false, message: `Blocked reason is at most ${BLOCKED_MAX} characters.` };
      if (value.toLowerCase() === 'unknown') return { ok: false, message: 'Blocked must name a real dependency, not "unknown".' };
      return { ok: true, result: { blocked: value } };
    default:
      return { ok: false, message: 'Choose a result kind.' };
  }
}

export function describeWorkResultError(status: number): string {
  if (status === 400) return 'The server rejected this result as invalid.';
  if (status === 404 || status === 405) return 'Request not found, or this Phantom build cannot record results yet';
  if (status === 409) return 'The result conflicted with the current request state. Try again.';
  if (status === 503) return 'The bus is unavailable right now. Try again.';
  return `Could not record the result (HTTP ${status}).`;
}

export function newReplyId(): string {
  return `desk-${crypto.randomUUID()}`;
}
