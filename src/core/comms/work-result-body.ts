/** The one result-receipt body shared by `ashlr fleet work-result` and the
 * desktop POST /api/verse/fleet/work-board/result: exactly one of `verified`
 * {pr,head}, `verified` {tests}, `verified` {artifact} or `blocked`
 * {dependency}, the only shapes work-item-bus-evidence.ts reads. A result
 * receipt is evidence, not authority: it does not complete or release a
 * claim. Pure: no I/O. */

export interface WorkResultInput {
  pr?: number | string;
  head?: string;
  tests?: string;
  artifact?: string;
  blocked?: string;
}

export type WorkResultBody =
  | { verified: { pr: number; head: string } }
  | { verified: { tests: string } }
  | { verified: { artifact: string } }
  | { blocked: { dependency: string } };

const MAX_DEPENDENCY_CHARS = 200;

/** Exactly one result form, shaped the way the work board's evidence reader
 * accepts it; anything it would silently ignore returns null so the caller
 * refuses it before posting. Inputs arrive from argv or untrusted JSON, so
 * every field is type-checked rather than trusted from the static type. */
export function workResultBody(input: WorkResultInput): WorkResultBody | null {
  const { pr, head, tests, artifact, blocked } = input as Record<string, unknown>;
  const forms = (pr !== undefined || head !== undefined ? 1 : 0)
    + (tests !== undefined ? 1 : 0) + (artifact !== undefined ? 1 : 0)
    + (blocked !== undefined ? 1 : 0);
  if (forms !== 1) return null;
  if (pr !== undefined || head !== undefined) {
    if (typeof head !== 'string' || head.trim() === '') return null;
    const n = typeof pr === 'number' ? pr
      : typeof pr === 'string' && /^[0-9]+$/.test(pr) ? Number(pr) : NaN;
    return Number.isSafeInteger(n) && n > 0 ? { verified: { pr: n, head } } : null;
  }
  if (tests !== undefined) return typeof tests !== 'string' || tests.trim() === '' ? null : { verified: { tests } };
  if (artifact !== undefined) {
    return typeof artifact !== 'string' || artifact.trim() === '' ? null : { verified: { artifact } };
  }
  if (typeof blocked !== 'string') return null;
  const dependency = blocked.trim();
  return dependency === '' || dependency.length > MAX_DEPENDENCY_CHARS || dependency.toLowerCase() === 'unknown'
    ? null : { blocked: { dependency } };
}
