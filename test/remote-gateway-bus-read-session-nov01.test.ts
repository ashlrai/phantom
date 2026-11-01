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

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-remote-http-'));
  dirs.push(root);
  const devices = createRemoteDeviceStore(root);
  devices.add(device());
  const received: { path: string; headers: Record<string, unknown> }[] = [];
  const control = { issueFails: false, rejectCount: 0, leak: false };
  let ticket = '';
  let client = '';
  let issues = 0;
  const hub = createServer((req, res) => {
    received.push({ path: req.url ?? '', headers: { ...req.headers } });
    if (req.url === '/api/session' && req.method === 'POST'
      && req.headers['x-ashlr-token'] === TOKEN && req.headers['x-ashlr-read-client']) {
      if (control.issueFails) { res.writeHead(503); res.end(); return; }
      client = String(req.headers['x-ashlr-read-client']);
      ticket = `ashlr_read_session=${'z'.repeat(80)}${++issues}`;
      res.writeHead(204, { 'Set-Cookie': `${ticket}; Path=/api/; HttpOnly` }); res.end(); return;
    }
    if (req.url === '/api/verse/agent-bus?limit=20') {
      if (!ticket || req.headers.cookie !== ticket || req.headers['x-ashlr-read-client'] !== client
        || control.rejectCount-- > 0) {
        res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{}'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ticket });
      res.end(JSON.stringify(control.leak ? { echo: ticket } : { v: 1, items: [] })); return;
    }
    if (req.url === '/api/verse/fleet/runs' && req.headers['x-ashlr-token'] === TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return;
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
    hub: { port: hubPort, readToken: TOKEN, mutationToken: MTOKEN },
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
  return { gateway, received, get, control };

}


describe('phone bus reads through the real gateway', () => {
  it('forwards a client-bound Hub session and keeps ordinary reads unchanged', async () => {
    const f = await fixture();
    try {
      const response = await f.get('/api/verse/agent-bus?limit=20');
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ v: 1, items: [] });
      const issue = f.received.find((r) => r.path === '/api/session')!;
      const bus = f.received.find((r) => r.path === '/api/verse/agent-bus?limit=20')!;
      expect(bus.headers.cookie).toBe(`ashlr_read_session=${'z'.repeat(80)}1`);
      expect(bus.headers['x-ashlr-read-client']).toBe(issue.headers['x-ashlr-read-client']);
      expect(bus.headers['x-ashlr-read-client']).toBeTruthy();
      expect(bus.headers['x-ashlr-token']).toBeUndefined();
      expect(response.headers.get('set-cookie')).toBeNull();
      for (const value of [TOKEN, MTOKEN, 'z'.repeat(80)]) expect(body).not.toContain(value);
      expect((await f.get('/api/verse/fleet/runs')).status).toBe(200);
      expect(f.received.at(-1)?.headers['x-ashlr-token']).toBe(TOKEN);
      expect(f.received.at(-1)?.headers.cookie).toBeUndefined();
      expect(f.received.at(-1)?.headers['x-ashlr-read-client']).toBeUndefined();
    } finally { await f.gateway.close(); }
  });

  it('refreshes an expired ticket and retries the same bus request exactly once', async () => {
    const f = await fixture();
    try {
      f.control.rejectCount = 1;
      const response = await f.get('/api/verse/agent-bus?limit=20');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ v: 1, items: [] });
      expect(f.received.filter((r) => r.path === '/api/session')).toHaveLength(2);
      const reads = f.received.filter((r) => r.path === '/api/verse/agent-bus?limit=20');
      expect(reads).toHaveLength(2);
      expect(reads[0]?.headers.cookie).not.toBe(reads[1]?.headers.cookie);
    } finally { await f.gateway.close(); }
  });

  it('returns a bounded gateway error after two rejected tickets', async () => {
    const f = await fixture();
    try {
      f.control.rejectCount = 2;
      const response = await f.get('/api/verse/agent-bus?limit=20');
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: 'HUB_BAD_RESPONSE' });
      expect(f.received.filter((r) => r.path.includes('agent-bus'))).toHaveLength(2);
    } finally { await f.gateway.close(); }
  });

  it('fails closed when session issuance is unavailable', async () => {
    const f = await fixture();
    try {
      f.control.issueFails = true;
      const response = await f.get('/api/verse/agent-bus?limit=20');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'HUB_READ_UNAVAILABLE', error: 'Local read session unavailable' });
      expect(f.received.map((r) => r.path)).toEqual(['/api/session']);
    } finally { await f.gateway.close(); }
  });

  it('rejects JSON that echoes the loopback cookie', async () => {
    const f = await fixture();
    try {
      f.control.leak = true;
      const response = await f.get('/api/verse/agent-bus?limit=20');
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ code: 'HUB_BAD_RESPONSE' });
      expect(body).not.toContain('z'.repeat(80));
    } finally { await f.gateway.close(); }
  });
});
