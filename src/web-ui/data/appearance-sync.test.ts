/**
 * data/appearance-sync.test.ts — the desktop ↔ server appearance mirror:
 * a newer server revision applies live, a local change PUTs, a 409 refetches
 * the server copy and applies it (server wins, no loop), and a missing route
 * is a no-op. Fake fetch + fake timers; auth-store is mocked for the token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ token: 'test-token' as string | null }));
vi.mock('./auth-store.js', () => ({
  getMutationToken: () => mocks.token,
  getReadClientProof: () => 'proof',
}));

type SyncModule = typeof import('./appearance-sync.js');
type StoreModule = typeof import('./appearance-store.js');

let sync: SyncModule;
let store: StoreModule;
let stop: () => void;
let serverRevision = 0;
let serverAppearance: Record<string, unknown> | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A small fake of the real route's CAS semantics (ui-appearance-api.ts). */
async function server(_path: unknown, init?: { method?: string; body?: string; headers?: unknown }) {
  if (init?.method === 'PUT') {
    const body = JSON.parse(String(init.body ?? '{}')) as { expectedRevision?: number; appearance?: Record<string, unknown> };
    if (body.expectedRevision !== serverRevision) {
      return jsonRes(409, { code: 'VERSE_REVISION_CONFLICT', revision: serverRevision, appearance: serverAppearance });
    }
    serverRevision += 1;
    serverAppearance = { ...(serverAppearance ?? {}), ...(body.appearance ?? {}) };
    return jsonRes(200, { version: 1, revision: serverRevision, updatedAt: 'now', updatedBy: 'x', appearance: serverAppearance });
  }
  return jsonRes(200, serverAppearance === null
    ? { revision: 0, appearance: null }
    : { version: 1, revision: serverRevision, updatedAt: 'now', updatedBy: 'x', appearance: serverAppearance });
}

function putCalls() {
  return fetchMock.mock.calls.filter(([, init]) => (init as { method?: string })?.method === 'PUT');
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
  serverRevision = 0;
  serverAppearance = null;
  fetchMock = vi.fn(server);
  vi.stubGlobal('fetch', fetchMock);
  sync = await import('./appearance-sync.js');
  store = await import('./appearance-store.js');
  stop = () => undefined;
});
afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('startAppearanceSync', () => {
  it('applies a newer server revision at start and on the next poll', async () => {
    serverRevision = 3;
    serverAppearance = { theme: 'dark', accentH: 10, motion: 'reduce' };
    stop = sync.startAppearanceSync();
    await flush();
    expect(store.getAppearance()).toMatchObject({ theme: 'dark', accentH: 10, motion: 'reduce' });

    serverRevision = 4;
    serverAppearance = { ...serverAppearance, theme: 'light', accentH: 20 };
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(store.getAppearance()).toMatchObject({ theme: 'light', accentH: 20 });
    stop();
  });

  it('PUTs a local change with the last known revision and learns the new one', async () => {
    serverRevision = 3;
    serverAppearance = { theme: 'dark', accentH: 10 };
    stop = sync.startAppearanceSync();
    await flush();

    store.setAppearance({ density: 'compact' });
    await flush();
    expect(putCalls()).toHaveLength(1);
    const init = putCalls()[0]![1] as { headers: Record<string, string>; body: string };
    expect(init.headers['x-ashlr-token']).toBe('test-token');
    const sent = JSON.parse(init.body) as { expectedRevision: number; updatedBy: string; appearance: Record<string, unknown> };
    expect(sent).toMatchObject({ expectedRevision: 3, updatedBy: 'verse-ui' });
    expect(sent.appearance).toMatchObject({ theme: 'dark', accentH: 10, density: 'compact' });
    expect(sent.appearance).not.toHaveProperty('reduceMotion');
    expect(serverRevision).toBe(4);
    stop();
  });

  it('on 409 refetches, applies the server copy and does not loop', async () => {
    serverRevision = 3;
    serverAppearance = { theme: 'dark' };
    stop = sync.startAppearanceSync();
    await flush();
    // Another writer lands first — the CAS base this tab holds is stale.
    serverRevision = 5;
    serverAppearance = { theme: 'light', density: 'compact' };

    store.setAppearance({ radius: 'soft' });
    await flush();
    expect(putCalls()).toHaveLength(1);
    // Server wins: the local radius change is replaced by the server record.
    expect(store.getAppearance()).toMatchObject({ theme: 'light', density: 'compact' });
    // The guarded apply did not PUT the server copy back.
    await flush();
    expect(putCalls()).toHaveLength(1);
    stop();
  });

  it('does nothing when the route is absent (404)', async () => {
    fetchMock.mockImplementation(async () => jsonRes(404, { error: 'not found' }));
    stop = sync.startAppearanceSync();
    await flush();
    store.setAppearance({ theme: 'dark' });
    await flush();
    // Local behaviour is untouched, nothing loops.
    expect(store.getAppearance().theme).toBe('dark');
    expect(putCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(putCalls()).toHaveLength(1);
    stop();
  });

  it('does not poll while the document is hidden', async () => {
    stop = sync.startAppearanceSync();
    await flush();
    const calls = fetchMock.mock.calls.length;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(fetchMock.mock.calls.length).toBe(calls);
    stop();
  });
});
