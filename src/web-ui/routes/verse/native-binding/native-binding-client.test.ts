import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getReadClientProof, markCheckComplete, getAuthSnapshot } from '../../../data/auth-store.js';
import { ApiError } from '../../../data/client.js';
import { binding } from './native-binding.test-support.js';
import { nativeBindingApi, nativeBindingReadError } from './native-binding-client.js';

beforeEach(() => markCheckComplete(true));
afterEach(() => { vi.unstubAllGlobals(); markCheckComplete(false); });

describe('native conversation metadata client', () => {
  it('reads only the selected chat through the existing read proof and caller cancellation', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(binding()))); vi.stubGlobal('fetch', fetch);
    const abort = new AbortController();
    expect(await nativeBindingApi.read('vs_1', abort.signal)).toEqual(binding());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/verse/sessions/vs_1/native-binding', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', headers: { 'x-ashlr-read-client': getReadClientProof() }, signal: expect.any(AbortSignal),
    }));
  });

  it.each(['../escape', '', 'a'.repeat(129), 'id/extra', 'id?secret'])('refuses unsafe chat ID %j before fetching', async id => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(nativeBindingApi.read(id, new AbortController().signal)).rejects.toThrow('Invalid chat ID');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: 'vs_other' }, { controlEnabled: true }, { liveOwnerState: 'active' }, { desktopAttachment: 'attached' },
    { nativeSessionId: '/private/conversation' }, { nativeIdState: 'unsupported' }, { savedUpdatedAt: 'invalid' },
    { accountPath: '/private/account' }, { schemaVersion: 2 }, { engine: 'unknown' },
  ])('refuses malformed or contradictory response %j', async patch => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...binding(), ...patch }))));
    await expect(nativeBindingApi.read('vs_1', new AbortController().signal)).rejects.toThrow('Invalid native binding');
  });

  it('reports expired read authentication through the shared auth store and fixed UI copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private server detail', { status: 401 })));
    const error = await nativeBindingApi.read('vs_1', new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(ApiError); expect(getAuthSnapshot().phase).toBe('unauthenticated');
    expect(nativeBindingReadError(error)).toBe('Read session expired. Reconnect Phantom to try again.');
  });

  it('does not display server error details or transport paths', () => {
    const error = new ApiError('/private/secret', 404, '/private/secret', '/private/account');
    expect(nativeBindingReadError(error)).toBe('Saved conversation details are unavailable.');
    expect(nativeBindingReadError(new Error('/private/account'))).toBe('Conversation details could not be loaded. Try again.');
  });
});
