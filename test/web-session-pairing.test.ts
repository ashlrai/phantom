import { expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { startServer } from '../src/core/web/server.js';

const cfg: AshlrConfig = {
  version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {},
};
const desktopProof = 'd'.repeat(64);
const browserProof = 'b'.repeat(64);

it('exchanges a short-lived code once without merging read and mutation authority', async () => {
  const hub = await startServer(cfg, { port: 0, open: false, allowDispatch: true }, { readProjections: null });
  const post = (path: string, headers: Record<string, string>) => fetch(hub.url + path, {
    method: 'POST', headers: { origin: hub.url, ...headers },
  });
  const issue = (headers: Record<string, string>) => post('/api/session/pairing', headers);
  const redeem = (code: string, headers: Record<string, string> = {}) => post('/api/session/pairing/redeem', {
    'x-ashlr-pairing-code': code, 'x-ashlr-read-client': browserProof, ...headers,
  });
  try {
    const desktop = await post('/api/session', { 'x-ashlr-token': hub.readToken, 'x-ashlr-read-client': desktopProof });
    const cookie = { cookie: desktop.headers.get('set-cookie')!.split(';')[0]!, 'x-ashlr-read-client': desktopProof };
    const desktopAuth = { ...cookie, 'x-ashlr-token': hub.token };
    expect((await issue(cookie)).status).toBe(401);
    expect((await issue({ ...desktopAuth, cookie: '' })).status).toBe(401);
    expect((await issue({ ...desktopAuth, origin: 'https://other.example' })).status).toBe(403);
    const issued = await issue(desktopAuth);
    expect(issued.status).toBe(200);
    const { code, expiresAt } = await issued.json();
    expect((await redeem('0'.repeat(43))).status).toBe(401);
    expect((await redeem(code, { origin: 'https://other.example' })).status).toBe(403);
    expect((await redeem(code, { 'x-ashlr-read-client': '' })).status).toBe(400);
    const paired = await redeem(code);
    expect(paired.status).toBe(200);
    expect(paired.headers.get('cache-control')).toBe('no-store');
    expect(await paired.json()).toEqual({ mutationToken: hub.token });
    const ticket = paired.headers.get('set-cookie')!;
    expect(ticket).toContain('HttpOnly; SameSite=Strict');
    const browserCookie = { cookie: ticket.split(';')[0]!, 'x-ashlr-read-client': browserProof };
    expect((await fetch(hub.url + '/api/runs', { headers: browserCookie })).status).toBe(200);
    expect((await fetch(hub.url + '/api/runs', { headers: { ...browserCookie, 'x-ashlr-read-client': desktopProof } })).status).toBe(401);
    expect((await fetch(hub.url + '/api/runs', { headers: { 'x-ashlr-token': hub.token } })).status).toBe(401);
    expect((await post('/api/run', { ...browserCookie, 'content-type': 'application/json' })).status).toBe(401);
    expect((await redeem(code)).status).toBe(401);

    const next = await (await issue(desktopAuth)).json();
    expect(next.expiresAt).toBeGreaterThanOrEqual(expiresAt);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(next.expiresAt);
    try { expect((await redeem(next.code)).status).toBe(401); }
    finally { clock.mockRestore(); }
  } finally {
    await hub.close();
  }
});

it('does not enable pairing on a read-only server', async () => {
  const hub = await startServer(cfg, { port: 0, open: false, allowDispatch: false }, { readProjections: null });
  try {
    const response = await fetch(hub.url + '/api/session/pairing', { method: 'POST', headers: { origin: hub.url } });
    expect(response.status).toBe(404);
  } finally {
    await hub.close();
  }
});
