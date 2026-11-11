/**
 * Pure helpers for the Goals pane "Add a goal" form: what may be submitted
 * (mirroring POST /api/verse/goals' own limits, so bad input is refused
 * before the POST) and how a response or failure maps to one operator
 * sentence. Nothing here fetches or writes files.
 */

/** The route's cap — keep in step with OBJECTIVE_MAX_CHARS in core/verse/goals-create-api.ts. */
export const GOAL_OBJECTIVE_MAX_CHARS = 4_000;
// Rejecting control characters is the point: an objective is one line of text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

export type GoalAddParse = { ok: true; objective: string } | { ok: false; reason: string };

/** Trim like the server does; refuse what it refuses so errors land before the POST. */
export function goalAddParse(input: string): GoalAddParse {
  const objective = input.trim();
  if (!objective) return { ok: false, reason: 'Type an objective first.' };
  if (objective.length > GOAL_OBJECTIVE_MAX_CHARS) {
    return { ok: false, reason: `Keep the objective to ${GOAL_OBJECTIVE_MAX_CHARS} characters or fewer.` };
  }
  if (CONTROL_CHAR_RE.test(objective)) return { ok: false, reason: 'The objective cannot contain control characters.' };
  return { ok: true, objective };
}

/** The line under the input once the server answers: added, already there, or a reply the model does not know. */
export function goalAddNotice(body: unknown): string {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const status = (body as Record<string, unknown>)['status'];
    if (status === 'created') return 'Added';
    if (status === 'exists') return 'That goal already exists';
  }
  return 'Could not add the goal.';
}

/**
 * The line when the POST never produced a usable answer: prefer the server's
 * own refusal sentence (ApiError.detail) over the "POST … failed" wrapper.
 */
export function goalAddErrorText(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const detail = (err as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  if (err instanceof Error && err.message.trim()) return err.message;
  return 'Could not add the goal.';
}
