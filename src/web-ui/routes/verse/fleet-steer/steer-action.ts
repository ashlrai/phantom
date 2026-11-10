/**
 * routes/verse/fleet-steer/steer-action.ts — the Steer pane's mutation
 * client: POST /api/wb/v1/action with the held mutation token, a fresh
 * nonce per call, and the same outcome sentences the other action panes
 * use. Shaped like fleet-job-log/job-stop-action.ts.
 */
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost, readFailureReason } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { STEER_PRIORITIES } from './steer-model.js';

/** core/web/wb-action-api.ts — the one wb mutation door. */
export const WB_ACTION_PATH = '/api/wb/v1/action';
/** First click arms Stop for this window; the second click posts. */
export const STOP_CONFIRM_MS = 5_000;
/** Mirror of INBOX_MAX_CHARS (core/fleet/mason-inbox.ts); the server re-checks. */
export const NOTE_MAX_CHARS = 6_000;

export type WbActionBody =
  | { action: 'steer.note'; text: string }
  | { action: 'queue.reprioritize'; job: string; priority: string }
  | { action: 'job.stop'; job: string };

export interface WbActionResult { dryRun: boolean; count?: number; outcome?: string }

/** A 32-hex nonce — what the action endpoint's replay fence requires. */
function freshNonce(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function parseWbActionResult(value: unknown): WbActionResult {
  if (!record(value) || typeof value.dryRun !== 'boolean'
    || (value.count !== undefined && typeof value.count !== 'number')
    || (value.outcome !== undefined && typeof value.outcome !== 'string')) {
    throw new ApiError('Invalid action response.', 502, WB_ACTION_PATH, 'The server returned an invalid action response.');
  }
  return { dryRun: value.dryRun, count: value.count, outcome: value.outcome };
}

/** One-line result the pane shows after a send. */
export function actionOutcomeText(body: WbActionBody, result: WbActionResult): string {
  const outcome = typeof result.outcome === 'string' ? result.outcome : '';
  switch (body.action) {
    case 'steer.note':
      return `note sent to the leaders' inbox${result.count === undefined ? '' : ` · ${result.count} bytes`}`;
    case 'queue.reprioritize':
      return outcome.includes('>') ? `${body.job} · ${outcome.replace('>', ' → ')}` : `${body.job} reprioritized`;
    case 'job.stop': {
      if (outcome === 'stopped') return `${body.job} · stopped ${result.count ?? 0} ${result.count === 1 ? 'process' : 'processes'}`;
      if (outcome === 'planned') return `${body.job} · ${result.count ?? 0} processes matched (dry run)`;
      return `${body.job} · not running`;
    }
  }
}

export function stopConfirmLabel(id: string, armed: boolean): string {
  return armed ? `Stop ${id}? click again` : 'Stop';
}

/** The inline sentence for a failure: the locked-token text, then a 401,
 * the dispatch gate, then the route's refusal — never request values. */
export function actionFailureText(error: unknown): string {
  if (error instanceof VerseControlLockedError) return error.message;
  if (error instanceof ApiError && error.status === 401) return error.message;
  if (error instanceof ApiError && error.status === 403) return 'Workbench actions are disabled on this server.';
  if (error instanceof ApiError && error.status === 400) return 'That action was refused; check the fields.';
  if (error instanceof ApiError && error.status === 409) return 'That action was already sent; try again.';
  if (error instanceof ApiError && error.status === 503) return 'The action could not run — the job may have moved on.';
  if (error instanceof ApiError) return readFailureReason(error);
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}

export async function postWbSteerAction(body: WbActionBody): Promise<WbActionResult> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  try {
    const result = parseWbActionResult(await apiPost<unknown>(WB_ACTION_PATH, { ...body, nonce: freshNonce(), dryRun: false }, token));
    touchMutationHold();
    return result;
  } catch (error) {
    // A codeless 404 is an old server without the steer actions.
    if (error instanceof ApiError && error.status === 404) {
      const message = 'This Phantom server cannot run workbench actions yet; update the app.';
      throw new ApiError(message, 404, WB_ACTION_PATH, message);
    }
    throw error;
  }
}

/** Note text problem the pane can say before posting (mirrors the server's). */
export function noteProblem(text: string): 'empty' | 'too-long' | 'secret-shaped' | null {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return 'empty';
  if (clean.length > NOTE_MAX_CHARS) return 'too-long';
  return null;
}

export function isSteerPriority(value: string): value is (typeof STEER_PRIORITIES)[number] {
  return (STEER_PRIORITIES as readonly string[]).includes(value);
}
