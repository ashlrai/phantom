/** GET /api/verse/fleet/runtime-identity/bridge-check — one-call READY/BLOCKED verdict. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  createFleetBridgeCheckApi,
  VERSE_FLEET_BRIDGE_CHECK_PATH as PATH,
} from '../src/core/verse/fleet-bridge-check-api.js';
import { createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const FAILED = {
  verdict: 'BLOCKED', asOf: NOW.toISOString(),
  missing: ['bridge-check'], reason: 'bridge-check-reader-failed',
};

async function call(api: ApiModule, method = 'GET', path = PATH) {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const req = { url: path } as IncomingMessage;
  const handled = await api({} as VerseApiContext, req, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

function apiWithRead(read: () => unknown) {
  return createFleetRuntimeIdentityApi({
    bridgeCheck: createFleetBridgeCheckApi({ read, now: () => NOW }),
  });
}

afterEach(() => { vi.useRealTimers(); });

describe('bridge-check HTTP route', () => {
  it('wraps a READY verdict in the envelope', async () => {
    const check = { verdict: 'READY', asOf: NOW.toISOString(), missing: [] };
    const r = await call(apiWithRead(async () => check));
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body).toEqual({ v: 1, authority: 'none', check });
  });

  it('wraps a BLOCKED verdict naming the missing part', async () => {
    const check = { verdict: 'BLOCKED', asOf: NOW.toISOString(), missing: ['claims'] };
    const r = await call(apiWithRead(async () => check));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, authority: 'none', check });
  });

  it('degrades a throwing or rejecting read without leaking the message', async () => {
    for (const read of [
      () => { throw new Error('/Users/someone/secret'); },
      () => Promise.reject(new Error('/Users/someone/secret')),
    ]) {
      const r = await call(apiWithRead(read));
      expect(r).toMatchObject({ handled: true, status: 200 });
      expect(r.body).toEqual({ v: 1, authority: 'none', check: FAILED });
      expect(r.text).not.toContain('secret');
      expect(r.text).not.toContain('/Users/');
    }
  });

  it('falls back to the same BLOCKED body when the read never resolves', async () => {
    vi.useFakeTimers();
    const pending = call(apiWithRead(() => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(8_000);
    const r = await pending;
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body).toEqual({ v: 1, authority: 'none', check: FAILED });
  });

  it('rejects POST with 405 before any read', async () => {
    const read = vi.fn(async () => ({}));
    const r = await call(apiWithRead(read), 'POST');
    expect(r).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    expect(read).not.toHaveBeenCalled();
  });

  it('returns false for other paths on the module itself', async () => {
    const r = await call(createFleetBridgeCheckApi({ read: async () => ({}) }), 'GET', '/api/verse/other');
    expect(r.handled).toBe(false);
  });

  it('keeps tailnet-peers on the hostReach seam', async () => {
    const hostReach = vi.fn<ApiModule>(async () => true);
    const bridgeCheck = vi.fn<ApiModule>(async () => true);
    const api = createFleetRuntimeIdentityApi({ hostReach, bridgeCheck });
    const p = '/api/verse/fleet/runtime-identity/tailnet-peers';
    expect((await call(api, 'GET', p)).handled).toBe(true);
    expect(hostReach).toHaveBeenCalledTimes(1);
    expect(bridgeCheck).not.toHaveBeenCalled();
  });
});
