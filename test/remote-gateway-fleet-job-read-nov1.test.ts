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
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';

const ORIGIN = 'https://phone.example.com';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const DEVICE_ID = '6335d417-61da-459d-899c-0a01c76a2f94';
const TOKEN = 'a'.repeat(64);
const CONFIG = { publicOrigin: ORIGIN, teamDomain: 'https://team.cloudflareaccess.com', audience: 'b'.repeat(64), allowedSubjects: [SUBJECT] };
const JOB = 'RQ-PHX-EXAMPLE31';
const DETAIL = {
  schema: 'fleet.job.v1',
  generatedAt: '2026-10-31T00:12:00.000Z',
  job: JOB,
  state: 'running',
  lane: 'codex-personal',
  tier: 'work',
  model: 'fake-model',
  pid: 4242,
  launchedAt: '2026-10-31T00:00:00.000Z',
  baseSha: '0'.repeat(40),
  branch: 'codex-bridge/fake',
  promptBytes: 512,
  publish: { prUrl: 'https://github.com/example/phantom/pull/31', autoMerge: true, testLine: 'TEST pass 12/12', sensitive: null },
  notes: { hasNotes: true, hasBody: false, notesBytes: 256 },
  log: { source: 'live', bytes: 2048, tail: ['worker tail line one', 'worker tail line two'], truncated: false },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' },
};

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
    scopes: { read: true, act: false }, credentialId: randomBytes(32).toString('base64url'),
    publicKey: randomBytes(80).toString('base64url'), counter: 0, transports: ['internal'],
    deviceType: 'multiDevice', backedUp: true, createdAt: 1, lastUsedAt: null, revokedAt: null };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-remote-job-'));
  dirs.push(root);
  const devices = createRemoteDeviceStore(root);
  devices.add(device());
  const received: { path: string; headers: Record<string, unknown> }[] = [];
  const hub = createServer((req, res) => {
    received.push({ path: req.url ?? '', headers: { ...req.headers } });
    if (req.url === `/api/fleet/job?id=${JOB}` && req.headers['x-ashlr-token'] === TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(DETAIL));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{}');
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
    hub: { port: hubPort, readToken: TOKEN },
  });
  const identity = { subject: SUBJECT, email: 'owner@example.com', expiresAt: Date.now() + 600_000 };
  const session = gateway.issueDeviceSession(identity, DEVICE_ID);
  if (!session) throw new Error('fixture session missing');
  const headers = { host: 'phone.example.com', 'cf-access-jwt-assertion': jwt, cookie: session.cookie.split(';', 1)[0]! };
  async function get(path: string, overrides: Record<string, string | undefined> = {}, method = 'GET') {
    const merged: Record<string, string> = { ...headers };
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete merged[name];
      else merged[name] = value;
    }
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(`${gateway.url}${path}`, { method, headers: merged }, (incoming) => {
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status: incoming.statusCode, headers: incoming.headers as HeadersInit,
        }));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  }
  return { gateway, devices, received, get };
}

describe('remote gateway fleet job read policy', () => {
  it('reads /api/fleet/job with exactly one well-formed id', () => {
    expect(classifyRemoteRoute('GET', `/api/fleet/job?id=${JOB}`)).toEqual({ kind: 'read', path: '/api/fleet/job' });
    expect(classifyRemoteRoute('GET', '/api/fleet/job?id=JOB9')).toEqual({ kind: 'read', path: '/api/fleet/job' });
    expect(classifyRemoteRoute('GET', `/api/fleet/job?id=${'x'.repeat(80)}`)).toEqual({ kind: 'read', path: '/api/fleet/job' });
  });

  it('denies bare, empty, traversal, spaced, overlong and extra-param job reads', () => {
    for (const target of [
      '/api/fleet/job',
      '/api/fleet/job?id=',
      '/api/fleet/job?id=../x',
      '/api/fleet/job?id=a%20b',
      `/api/fleet/job?id=${'x'.repeat(81)}`,
      '/api/fleet/job?id=ab',
      '/api/fleet/job?id=a/b',
      '/api/fleet/job?id=a%2Fb',
      '/api/fleet/job?id=RQ-FAKE&id=RQ-OTHER',
      '/api/fleet/job?id=RQ-FAKE&limit=1',
      '/api/fleet/job?limit=1&id=RQ-FAKE',
      '/api/fleet/job/other?id=RQ-FAKE',
    ]) expect(classifyRemoteRoute('GET', target)).toEqual({ kind: 'deny' });
  });

  it('denies non-GET methods on the job route', () => {
    expect(classifyRemoteRoute('POST', '/api/fleet/job')).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('POST', `/api/fleet/job?id=${JOB}`)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('DELETE', `/api/fleet/job?id=${JOB}`)).toEqual({ kind: 'deny' });
  });
});

describe('remote gateway fleet job read through the running gateway', () => {
  it('serves the Hub detail to a paired read-scope device', async () => {
    const f = await fixture();
    try {
      const response = await f.get(`/api/fleet/job?id=${JOB}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(DETAIL);
      const upstream = f.received.at(-1);
      expect(upstream?.path).toBe(`/api/fleet/job?id=${JOB}`);
      expect(upstream?.headers['x-ashlr-token']).toBe(TOKEN);
      expect(response.headers.get('x-ashlr-token')).toBeNull();
    } finally { await f.gateway.close(); }
  });

  it('keeps denied job query shapes off the Hub', async () => {
    const f = await fixture();
    try {
      for (const target of [
        '/api/fleet/job',
        '/api/fleet/job?id=',
        '/api/fleet/job?id=../x',
        `/api/fleet/job?id=${'x'.repeat(81)}`,
        '/api/fleet/job?id=RQ-FAKE&limit=1',
      ]) {
        const response = await f.get(target);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'ROUTE_DENIED' });
      }
      expect(f.received).toHaveLength(0);
    } finally { await f.gateway.close(); }
  });

  it('still refuses an unpaired request before the route check', async () => {
    const f = await fixture();
    try {
      const noCookie = await f.get(`/api/fleet/job?id=${JOB}`, { cookie: undefined });
      expect(noCookie.status).toBe(401);
      expect(await noCookie.json()).toMatchObject({ code: 'DEVICE_SESSION_REQUIRED' });
      const noAssertion = await f.get(`/api/fleet/job?id=${JOB}`, { 'cf-access-jwt-assertion': '', cookie: undefined });
      expect(noAssertion.status).toBe(401);
      expect(f.received).toHaveLength(0);
    } finally { await f.gateway.close(); }
  });
});
