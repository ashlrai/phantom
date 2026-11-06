import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost, readFailureReason } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import type { AppAction, AppActionResult } from './apps-card-model.js';

export const APP_ACTION_PATH = '/api/verse/fleet/apps/action';
export const APP_CONFIRM_MS = 5_000;
export function appActionFailureText(error: unknown): string {
  if (error instanceof VerseControlLockedError) return error.message;
  if (error instanceof ApiError && error.status === 401) return error.message;
  if (error instanceof ApiError) return readFailureReason(error);
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}
export async function postAppAction(app: string, action: AppAction): Promise<AppActionResult> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  try {
    const result = await apiPost<AppActionResult>(APP_ACTION_PATH, { app, action }, token);
    if (!result || result.app !== app || result.action !== action || typeof result.code !== 'string' || typeof result.at !== 'string') {
      throw new ApiError('Invalid app response.', 502, APP_ACTION_PATH, 'The server returned an invalid app response.');
    }
    touchMutationHold();
    return result;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      const message = error.status === 404 ? 'This Phantom server cannot control apps yet; update the app.' : 'App control works only on this Mac.';
      throw new ApiError(message, error.status, APP_ACTION_PATH, message);
    }
    throw error;
  }
}
