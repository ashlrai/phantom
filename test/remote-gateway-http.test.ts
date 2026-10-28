import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRemoteAccessVerifier } from '../src/core/web/remote-access.js';
import { createRemoteDeviceStore, type RemoteDevice } from '../src/core/web/remote-device-store.js';
import { startRemoteReadGateway } from '../src/core/web/remote-gateway.js';
import { createRemotePairing } from '../src/core/web/remote-pairing.js';

const ORIGIN = 'https://phone.example.com';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const DEVICE_ID = '6335d417-61da-459d-899c-0a01c76a2f94';
const TOKEN = 'a'.repeat(64);
const MTOKEN = 'c'.repeat(64);
const CONFIG = { publicOrigin: ORIGIN, teamDomain: 'https://team.cloudflareaccess.com', audience: 'b'.repeat(64), allowedSubjects: [SUBJECT] };
const active = new Set<Server>();
const dirs: string[] = [];
afterEach(async () => {
  for (const server of active) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  active.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function device(): RemoteDevice {
  return { id: DEVICE_ID, label: 'Phone', subject: SUBJECT, email: 'owner@example.com',
    scopes: { read: true, act: true }, credentialId: randomBytes(32).toString('base64url'),
    publicKey: randomBytes(80).toString('base64url'), counter: 0, transports: ['internal'],
    deviceType: 'multiDevice', backedUp: true, createdAt: 1, lastUsedAt: null, revokedAt: null };
}

async function fixture(opts: { writes?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-remote-http-'));
  dirs.push(root);
  const devices = createRemoteDeviceStore(root);
  devices.add(device());
  const received: { path: string; headers: Record<string, unknown> }[] = [];
  const control = {
    rejectNextSse: false,
    /** When set, the activity handler embeds this string in its JSON reply. */
    leakJson: null as string | null,
    /** When set, the SSE handler writes exactly these chunks instead of a tick. */
    ssePayload: null as string[] | null,
    /** When set, the mutation handler embeds this string in its JSON reply. */
    leakMutation: null as string | null,
  };
  const hub = createServer((req, res) => {
    received.push({ path: req.url ?? '', headers: { ...req.headers } });
    if (req.url === '/api/session' && req.method === 'POST' && req.headers['x-ashlr-token'] === TOKEN) {
      res.writeHead(204, { 'Set-Cookie': `ashlr_read_session=${'z'.repeat(80)}; Path=/api/; HttpOnly` }); res.end(); return;
    }
    if (req.url?.startsWith('/api/events?topics=verse-sessions&client=') && req.headers.cookie?.startsWith('ashlr_read_session=')) {
      if (control.rejectNextSse) { control.rejectNextSse = false; res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (control.ssePayload) { for (const chunk of control.ssePayload) res.write(chunk); return; }
      res.write(`event: tick\ndata: ${'x'.repeat(128)}\n\n`); return;
    }
    if ((req.url === '/api/verse/activity' || req.url === '/api/verse/activity?since=v1.aaaaaaaa.t.1')
      && req.headers['x-ashlr-token'] === TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...(control.leakJson ? { debug: control.leakJson } : {}) })); return;
    }
    if (req.url === '/api/verse/activity/seen' && req.method === 'POST' && req.headers['x-ashlr-token'] === MTOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seen: true, ...(control.leakMutation ? { echo: control.leakMutation } : {}) })); return;
    }
    if (req.url === '/api/verse/sessions/long' && req.headers['x-ashlr-token'] === TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ events: 'x'.repeat(3 * 1024 * 1024) })); return;
    }
    if (req.url === '/api/verse/sessions/oversize' && req.headers['x-ashlr-token'] === TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"events":"');
      for (let i = 0; i < 17; i++) res.write('x'.repeat(1024 * 1024));
      res.end('"}'); return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  active.add(hub);
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const hubPort = (hub.address() as { port: number }).port;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const verifier = createRemoteAccessVerifier(CONFIG, createLocalJWKSet({ keys: [key] }));
  const sign = (expiry: number, subject = SUBJECT) => new SignJWT({ type: 'app', email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(CONFIG.teamDomain).setAudience(CONFIG.audience)
    .setSubject(subject).setIssuedAt(Math.floor(Date.now() / 1000) - 1).setNotBefore(Math.floor(Date.now() / 1000) - 1)
    .setExpirationTime(expiry).sign(privateKey);
  const jwt = await sign(Math.floor(Date.now() / 1000) + 600);
  const gateway = await startRemoteReadGateway({
    access: CONFIG, devices, verifier,
    hub: opts.writes ? { port: hubPort, readToken: TOKEN, mutationToken: MTOKEN } : { port: hubPort, readToken: TOKEN },
    pairing: opts.writes ? createRemotePairing(CONFIG, devices) : undefined,
  });
  const identity = { subject: SUBJECT, email: 'owner@example.com', expiresAt: Date.now() + 600_000 };
  const session = gateway.issueDeviceSession(identity, DEVICE_ID);
  if (!session) throw new Error('fixture session missing');
  const headers = { host: 'phone.example.com', 'cf-access-jwt-assertion': jwt, cookie: session.cookie.split(';', 1)[0]! };
  async function get(path: string, overrides: Record<string, string> = {}, method = 'GET') {
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(`${gateway.url}${path}`, { method, headers: { ...headers, ...overrides } }, (incoming) => {
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status: incoming.statusCode, headers: incoming.headers as HeadersInit,
        }));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  }
  async function post(path: string, body: unknown, overrides: Record<string, string> = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(`${gateway.url}${path}`, {
        method: 'POST',
        headers: {
          ...headers, 'content-type': 'application/json', origin: ORIGIN,
          'x-ashlr-remote-csrf': session.csrfToken, ...overrides,
        },
      }, (incoming) => {
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status: incoming.statusCode, headers: incoming.headers as HeadersInit,
        }));
      });
      outgoing.on('error', reject);
      outgoing.end(payload);
    });
  }
  return { gateway, devices, received, headers, get, post, sign, session, control };
}

describe('dormant remote read gateway HTTP boundary', () => {
  it('keeps raw Hub credentials off the browser and allows only reviewed reads', async () => {
    const f = await fixture();
    try {
      const probe = await f.get('/remote/session');
      expect(await probe.json()).toMatchObject({ authenticated: true, capabilities: { writes: false }, deviceId: DEVICE_ID });
      expect(probe.headers.get('set-cookie')).toBeNull();
      const response = await f.get('/api/verse/activity');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('x-ashlr-token')).toBeNull();
      expect(f.received.at(-1)?.headers['x-ashlr-token']).toBe(TOKEN);
      const long = await f.get('/api/verse/sessions/long');
      expect(long.status).toBe(200);
      expect(((await long.json()) as { events: string }).events).toHaveLength(3 * 1024 * 1024);
      expect((await f.get('/api/verse/sessions/oversize')).status).toBe(502);
      expect((await f.get('/api/session')).status).toBe(404);
      expect((await f.get('/api/verse/agent-tools/mcp')).status).toBe(404);
      expect((await f.get('/verse/m/')).status).toBe(404);
      expect((await f.get('/api/verse/activity', {}, 'POST')).status).toBe(403);
    } finally { await f.gateway.close(); }
  });

  it('forwards a valid activity cursor poll but denies malformed or extra query parameters', async () => {
    const f = await fixture();
    try {
      expect((await f.get('/api/verse/activity')).status).toBe(200);
      const second = await f.get('/api/verse/activity?since=v1.aaaaaaaa.t.1');
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ ok: true });
      expect(f.received.at(-1)?.path).toBe('/api/verse/activity?since=v1.aaaaaaaa.t.1');
      expect(f.received.at(-1)?.headers['x-ashlr-token']).toBe(TOKEN);

      const forwarded = f.received.length;
      for (const target of [
        '/api/verse/activity?since=garbage',
        '/api/verse/activity?since=v1.aaaaaaaa.t.1&since=v1.aaaaaaaa.t.2',
        '/api/verse/activity?since=v1.aaaaaaaa.t.1&extra=1',
      ]) {
        const response = await f.get(target);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'ROUTE_DENIED' });
      }
      expect(f.received).toHaveLength(forwarded);
    } finally { await f.gateway.close(); }
  });

  it('denies absent/altered Access assertion, wrong Host/Origin, raw tokens and revoked devices', async () => {
    const f = await fixture();
    try {
      expect((await f.get('/api/verse/activity', { 'cf-access-jwt-assertion': '' })).status).toBe(401);
      expect((await f.get('/api/verse/activity', { 'cf-access-jwt-assertion': `${f.headers['cf-access-jwt-assertion']}x` })).status).toBe(401);
      expect((await f.get('/api/verse/activity', { host: 'evil.example' })).status).toBe(403);
      expect((await f.get('/api/verse/activity', { origin: 'https://evil.example' })).status).toBe(403);
      expect((await f.get('/api/verse/activity', { 'x-ashlr-token': TOKEN })).status).toBe(403);
      const expired = await f.sign(Math.floor(Date.now() / 1000) - 5);
      expect((await f.get('/api/verse/activity', { 'cf-access-jwt-assertion': expired })).status).toBe(401);
      f.devices.revoke(DEVICE_ID, Date.now());
      expect((await f.get('/api/verse/activity')).status).toBe(401);
    } finally { await f.gateway.close(); }
  });

  it('closes live SSE on device revocation and never forwards local credentials', async () => {
    const f = await fixture();
    try {
      const response = await f.get('/api/events?topics=verse-sessions');
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: tick');
      const streamRequest = f.received.find((r) => r.path.startsWith('/api/events?'))!;
      expect(streamRequest.headers.cookie).toMatch(/^ashlr_read_session=/);
      expect(streamRequest.headers['x-ashlr-token']).toBeUndefined();
      f.devices.revoke(DEVICE_ID, Date.now());
      const closed = await Promise.race([reader.read(), new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000))]);
      expect(closed).not.toBe('timeout');
      expect((closed as ReadableStreamReadResult<Uint8Array>).done).toBe(true);
    } finally { await f.gateway.close(); }
  });

  it('caps a live SSE connection to the device session expiry', async () => {
    const f = await fixture();
    try {
      const short = f.gateway.issueDeviceSession({ subject: SUBJECT, email: 'owner@example.com',
        expiresAt: Date.now() + 300 }, DEVICE_ID);
      expect(short).not.toBeNull();
      const response = await f.get('/api/events?topics=verse-sessions', { cookie: short!.cookie.split(';', 1)[0]! });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      const closed = await Promise.race([reader.read(), new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000))]);
      expect(closed).not.toBe('timeout');
      expect((closed as ReadableStreamReadResult<Uint8Array>).done).toBe(true);
    } finally { await f.gateway.close(); }
  });

  it('replaces old device sessions and renews a rejected local SSE ticket', async () => {
    const f = await fixture();
    try {
      const replacement = f.gateway.issueDeviceSession({ subject: SUBJECT, email: 'owner@example.com',
        expiresAt: Date.now() + 600_000 }, DEVICE_ID)!;
      expect((await f.get('/api/verse/activity')).status).toBe(401);
      const cookie = replacement.cookie.split(';', 1)[0]!;
      f.control.rejectNextSse = true;
      expect((await f.get('/api/events?topics=verse-sessions', { cookie })).status).toBe(502);
      const response = await f.get('/api/events?topics=verse-sessions', { cookie });
      expect(response.status).toBe(200);
      await response.body?.cancel();
      expect(f.received.filter((r) => r.path === '/api/session')).toHaveLength(2);
    } finally { await f.gateway.close(); }
  });

  it('rejects a proxied JSON body containing a Hub credential instead of relaying it', async () => {
    const f = await fixture();
    try {
      f.control.leakJson = TOKEN;
      const response = await f.get('/api/verse/activity');
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).not.toContain(TOKEN);
      expect(JSON.parse(body)).toMatchObject({ code: 'HUB_BAD_RESPONSE' });
    } finally { await f.gateway.close(); }
  });

  it('aborts an SSE stream whose Hub credential is split across chunks', async () => {
    const f = await fixture();
    try {
      // The credential arrives straddling a chunk boundary; the gateway holds
      // a token-length tail precisely so this cannot slip through.
      f.control.ssePayload = [`event: t\ndata: ${TOKEN.slice(0, 20)}`, `${TOKEN.slice(20)}\n\n`];
      const response = await f.get('/api/events?topics=verse-sessions');
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      let receivedText = '';
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
        ]);
        expect(chunk).not.toBe('timeout');
        const part = chunk as ReadableStreamReadResult<Uint8Array>;
        if (part.done) break;
        receivedText += decoder.decode(part.value);
      }
      expect(receivedText).not.toContain(TOKEN);
    } finally { await f.gateway.close(); }
  });

  it('rejects a mutation reply containing a Hub credential and never relays it', async () => {
    const f = await fixture({ writes: true });
    try {
      // Happy path first: a clean mutation response passes through untouched.
      const clean = await f.post('/api/verse/activity/seen', { sessionId: 's1', turnCount: 0 });
      expect(clean.status).toBe(200);
      expect(await clean.json()).toEqual({ seen: true });
      expect(f.received.at(-1)?.headers['x-ashlr-token']).toBe(MTOKEN);

      // Hub replies embedding EITHER credential are dropped behind a 502.
      for (const leaked of [MTOKEN, TOKEN]) {
        f.control.leakMutation = leaked;
        const response = await f.post('/api/verse/activity/seen', { sessionId: 's1', turnCount: 0 });
        expect(response.status).toBe(502);
        const body = await response.text();
        expect(body).not.toContain(MTOKEN);
        expect(body).not.toContain(TOKEN);
        expect(JSON.parse(body)).toMatchObject({ code: 'HUB_UNAVAILABLE' });
      }
    } finally { await f.gateway.close(); }
  });
});
