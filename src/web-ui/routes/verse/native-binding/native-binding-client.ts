/** Saved Phantom metadata only; this read never connects to a native agent. */
import { apiGet, ApiError } from '../../../data/client.js';
import { validNativeBindingId, validVerseNativeSessionBinding, type VerseNativeSessionBinding } from '../../../../core/verse/native-session-binding-types.js';

export interface NativeBindingApi {
  read(sessionId: string, signal: AbortSignal): Promise<VerseNativeSessionBinding>;
}

export const nativeBindingApi: NativeBindingApi = {
  async read(sessionId, signal) {
    if (!validNativeBindingId(sessionId)) throw new Error('Invalid chat ID');
    const value = await apiGet<unknown>(`/api/verse/sessions/${encodeURIComponent(sessionId)}/native-binding`, signal);
    if (!validVerseNativeSessionBinding(value) || value.sessionId !== sessionId) throw new Error('Invalid native binding');
    return value;
  },
};

/** Fixed UI copy keeps server errors and private transport details out of the sheet. */
export function nativeBindingReadError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Read session expired. Reconnect Phantom to try again.';
  if (error instanceof ApiError && error.status === 404) return 'Saved conversation details are unavailable.';
  return 'Conversation details could not be loaded. Try again.';
}
