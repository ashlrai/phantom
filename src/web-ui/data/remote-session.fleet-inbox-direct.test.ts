import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAuthentication } from '@simplewebauthn/browser';
import { clearRemoteSessionForTest, directCsrfWrite, probeRemoteSession, remoteMutate } from './remote-session.js';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({ id: 'passkey' })),
}));

afterEach(() => { clearRemoteSessionForTest(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const csrfToken = 'c'.repeat(40);
const ready = {
  authenticated: true, deviceId: 'device-1', label: 'My phone',
  scopes: { read: true, act: true }, csrfToken,
  capabilities: { pairing: true, writes: true, push: false },
};

describe('fleet inbox direct writes', () => {
  it('allows only the exact inbox path among fleet routes', () => {
    expect(directCsrfWrite('/api/verse/fleet/runs/inbox')).toBe(true);
    expect(directCsrfWrite('/api/verse/fleet/runs/inbox/x')).toBe(false);
    expect(directCsrfWrite('/api/verse/fleet/control/lanes')).toBe(false);
    expect(directCsrfWrite('/api/verse/fleet/control/switches')).toBe(false);
  });

  it('posts the inbox once with CSRF and without step-up', async () => {
    const fetcher = vi.fn(async (path: string, _init: RequestInit) => {
      if (path === '/remote/session') return Response.json({ ...ready, expiresAt: Date.now() + 60_000 });
      if (path === '/api/verse/fleet/runs/inbox') return Response.json({ sent: true });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await probeRemoteSession();
    fetcher.mockClear();

    const body = { text: 'hi', source: 'Phantom mobile' };
    await expect(remoteMutate('POST', '/api/verse/fleet/runs/inbox', body)).resolves.toEqual({ sent: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe('/api/verse/fleet/runs/inbox');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(body));
    expect(new Headers(init.headers).get('x-ashlr-remote-csrf')).toBe(csrfToken);
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it('still requires step-up for fleet control lanes', async () => {
    const fetcher = vi.fn(async (path: string, _init: RequestInit) => {
      if (path === '/remote/session') return Response.json({ ...ready, expiresAt: Date.now() + 60_000 });
      if (path === '/remote/step-up/begin') return Response.json({ challengeId: 'challenge-1', options: { challenge: 'YQ' } });
      if (path === '/remote/step-up/finish') return Response.json({ ok: true });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await probeRemoteSession();
    fetcher.mockClear();

    const body = { lane: 'fixture' };
    await expect(remoteMutate('POST', '/api/verse/fleet/control/lanes', body)).resolves.toEqual({ ok: true });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/remote/step-up/begin', '/remote/step-up/finish']);
    const operation = { method: 'POST', path: '/api/verse/fleet/control/lanes', body: JSON.stringify(body) };
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).toEqual(operation);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1].body))).toMatchObject({ ...operation, challengeId: 'challenge-1' });
    expect(startAuthentication).toHaveBeenCalledOnce();
  });
});
