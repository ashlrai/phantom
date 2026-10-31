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
import { createRemoteFleetFeed } from '../src/core/web/remote-fleet-feed.js';
import { classifyRemoteRoute, validateRemoteMutation } from '../src/core/web/remote-gateway-policy.js';
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
  const hub = createServer((req, res) => {
    received.push({ path: req.url ?? '', headers: { ...req.headers } });
    if (req.url === '/api/session' && req.method === 'POST' && req.headers['x-ashlr-token'] === TOKEN) {
      res.writeHead(204, { 'Set-Cookie': `ashlr_read_session=${'z'.repeat(80)}; Path=/api/; HttpOnly` }); res.end(); return;
    }
    if (req.url === '/api/verse/fleet/live' && req.headers['x-ashlr-token'] === TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ v: 1, runs: [{ id: 'job-1' }] })); return;
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
  return { gateway, devices, received, headers, get, post, sign, session };
}


describe('remote fleet feed', () => {
  it('denies an unpaired device, serves a paired device, and denies revocation', async () => {
    const f = await fixture();
    let cookie = '';
    const feed = createRemoteFleetFeed({
      async get<T>(path: string): Promise<T> {
        const response = await f.get(path, { cookie });
        if (!response.ok) throw new Error(`Gateway ${response.status}`);
        return await response.json() as T;
      },
      async mutate<T>(): Promise<T> { throw new Error('read only'); },
    });
    try {
      await expect(feed.list()).rejects.toThrow('Gateway 401');
      expect(f.received).toHaveLength(0);
      cookie = f.headers.cookie;
      expect(await feed.list()).toEqual({ v: 1, runs: [{ id: 'job-1' }] });
      f.devices.revoke(DEVICE_ID, Date.now());
      await expect(feed.list()).rejects.toThrow('Gateway 401');
      expect(f.received).toHaveLength(1);
    } finally { await f.gateway.close(); }
  });

  it('keeps every fleet control behind the gateway step-up policy', async () => {
    const f = await fixture({ writes: true });
    const operations: unknown[] = [];
    const feed = createRemoteFleetFeed({
      async get<T>(): Promise<T> { throw new Error('unused'); },
      async mutate<T>(method: 'POST', path: string, body: unknown): Promise<T> {
        const decision = classifyRemoteRoute(method, path);
        expect(decision).toMatchObject({ kind: 'write', stepUp: true });
        expect(validateRemoteMutation(decision, body)).toBe(true);
        operations.push({ path, body });
        const response = await f.post(path, body);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
        return undefined as T;
      },
    });
    try {
      await feed.pause(); await feed.resume(); await feed.kill();
      expect(operations).toEqual([
        { path: '/api/verse/daemon', body: { action: 'pause' } },
        { path: '/api/verse/daemon', body: { action: 'resume' } },
        { path: '/api/verse/authority', body: { action: 'stop' } },
      ]);
      expect(f.received).toHaveLength(0);
    } finally { await f.gateway.close(); }
  });
});
