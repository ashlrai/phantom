import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRemoteAccessVerifier } from '../src/core/web/remote-access.js';
import { createRemoteDeviceStore, type RemoteDevice } from '../src/core/web/remote-device-store.js';
import { pinRemoteInboxBody, startRemoteReadGateway } from '../src/core/web/remote-gateway.js';
import { createRemotePairing } from '../src/core/web/remote-pairing.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const ORIGIN = 'https://phone.example.com';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const DEVICE_ID = '6335d417-61da-459d-899c-0a01c76a2f94';
const TOKEN = 'a'.repeat(64);
const MTOKEN = 'c'.repeat(64);
const INBOX = '/api/verse/fleet/runs/inbox';
const CONFIG = { publicOrigin: ORIGIN, teamDomain: 'https://team.cloudflareaccess.com', audience: 'b'.repeat(64), allowedSubjects: [SUBJECT] };
const active = new Set<Server>();
const gateways: { close: () => Promise<void> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
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
  const root = mkdtempSync(join(tmpdir(), 'ashlr-remote-inbox-pin-'));
  dirs.push(root);
  const devices = createRemoteDeviceStore(root);
  devices.add(device());
  const append = vi.fn(async (_text: string, _source: string) => ({ ok: true, at: 'fake-at', bytes: 1 }));
  const forwarded: { path: string; headers: Record<string, unknown>; body: string }[] = [];
  const fleetApi = createFleetRunsApi({ appendInbox: append });
  const hubCtx = { cfg: {} as AshlrConfig, token: MTOKEN, allowDispatch: true } as VerseApiContext;
  const hub = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      forwarded.push({ path: req.url ?? '', headers: { ...req.headers }, body: raw });
      const replay = Readable.from([raw]) as unknown as IncomingMessage;
      replay.url = req.url;
      replay.method = req.method;
      replay.headers = req.headers;
      const handled = await fleetApi(hubCtx, replay, res, (req.url ?? '').split('?')[0]!, req.method ?? '');
      if (!handled && !res.writableEnded) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); }
    })().catch(() => { if (!res.headersSent) { res.writeHead(500); res.end('{}'); } });
  });
  active.add(hub);
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const hubPort = (hub.address() as { port: number }).port;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const verifier = createRemoteAccessVerifier(CONFIG, createLocalJWKSet({ keys: [key] }));
  const jwt = await new SignJWT({ type: 'app', email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(CONFIG.teamDomain).setAudience(CONFIG.audience)
    .setSubject(SUBJECT).setIssuedAt(Math.floor(Date.now() / 1000) - 1).setNotBefore(Math.floor(Date.now() / 1000) - 1)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600).sign(privateKey);
  const gateway = await startRemoteReadGateway({
    access: CONFIG, devices, verifier,
    hub: { port: hubPort, readToken: TOKEN, mutationToken: MTOKEN },
    pairing: createRemotePairing(CONFIG, devices),
  });
  gateways.push(gateway);
  const identity = { subject: SUBJECT, email: 'owner@example.com', expiresAt: Date.now() + 600_000 };
  const session = gateway.issueDeviceSession(identity, DEVICE_ID);
  if (!session) throw new Error('fixture session missing');
  const headers = { host: 'phone.example.com', 'cf-access-jwt-assertion': jwt, cookie: session.cookie.split(';', 1)[0]! };
  async function post(path: string, body: unknown) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(`${gateway.url}${path}`, {
        method: 'POST',
        headers: {
          ...headers, 'content-type': 'application/json', origin: ORIGIN,
          'x-ashlr-remote-csrf': session.csrfToken,
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
  return { post, append, forwarded };
}

describe('pinRemoteInboxBody', () => {
  it('re-serializes the inbox body with the pinned mobile source', () => {
    const raw = JSON.stringify({ text: 'ship it', source: 'Phantom desktop' });
    const pinned = pinRemoteInboxBody(INBOX, { text: 'ship it', source: 'Phantom desktop' }, raw);
    expect(JSON.parse(pinned)).toEqual({ text: 'ship it', source: 'Phantom mobile' });
    expect(JSON.parse(pinRemoteInboxBody(INBOX, { text: 'ship it' }, raw))).toEqual({ text: 'ship it', source: 'Phantom mobile' });
  });

  it('returns the raw body for every other path', () => {
    const raw = JSON.stringify({ lane: 'codex-personal', target: 24 });
    for (const path of ['/api/verse/fleet/control/lanes', '/api/verse/sessions', '/api/verse/leader/thread', '/api/verse/queue/abc']) {
      expect(pinRemoteInboxBody(path, { lane: 'x' }, raw)).toBe(raw);
    }
    expect(pinRemoteInboxBody(`${INBOX}?limit=50`, {}, raw)).toBe(raw);
  });
});

describe('remote gateway inbox source pin', () => {
  it('forwards a pinned body and the device header end to end', async () => {
    const { post, append, forwarded } = await fixture();
    const res = await post(INBOX, { text: 'from phone', source: 'Phantom desktop' });
    expect(res.status).toBe(201);
    const wire = await res.json() as Record<string, unknown>;
    expect(wire.accepted).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith('from phone', 'Phantom mobile');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.headers['x-ashlr-remote-device']).toBe(DEVICE_ID);
    expect(JSON.parse(forwarded[0]!.body)).toEqual({ text: 'from phone', source: 'Phantom mobile' });
  });

  it('returns the hub duplicate answer unchanged on a repeat post', async () => {
    const { post, append, forwarded } = await fixture();
    const first = await post(INBOX, { text: 'from phone', source: 'Phantom desktop' });
    expect(first.status).toBe(201);
    const second = await post(INBOX, { text: 'from phone', source: 'Phantom desktop' });
    expect(second.status).toBe(200);
    const wire = await second.json() as Record<string, unknown>;
    expect(wire.duplicate).toBe(true);
    expect(wire.accepted).toBe(false);
    expect(append).toHaveBeenCalledTimes(1);
    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]!.headers['x-ashlr-remote-device']).toBe(DEVICE_ID);
  });

  it('rejects an out-of-shape body before any forward', async () => {
    const { post, append, forwarded } = await fixture();
    const res = await post(INBOX, { text: 'from phone', source: 'Phantom desktop', extra: 1 });
    expect(res.status).toBe(400);
    const wire = await res.json() as Record<string, unknown>;
    expect(wire.code).toBe('INVALID_MUTATION');
    expect(append).not.toHaveBeenCalled();
    expect(forwarded).toHaveLength(0);
  });
});
