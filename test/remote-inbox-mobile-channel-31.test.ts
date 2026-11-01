import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRemoteAccessVerifier } from '../src/core/web/remote-access.js';
import { createRemoteDeviceStore, type RemoteDevice } from '../src/core/web/remote-device-store.js';
import { startRemoteReadGateway } from '../src/core/web/remote-gateway.js';
import { createRemotePairing } from '../src/core/web/remote-pairing.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';
import { VERSE_FLEET_RUNS_INBOX_PATH as INBOX } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const ORIGIN = 'https://phone.example.com';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const DEVICE_ID = '6335d417-61da-459d-899c-0a01c76a2f94';
const TOKEN = 'a'.repeat(64);
const MTOKEN = 'c'.repeat(64);
const CONFIG = { publicOrigin: ORIGIN, teamDomain: 'https://team.cloudflareaccess.com', audience: 'b'.repeat(64), allowedSubjects: [SUBJECT] };
const active = new Set<Server>();
const gateways: { close: () => Promise<void> }[] = [];
const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

let ashlrHomeDir: string;
beforeEach(() => {
  // The bus mirror resolves $ASHLR_HOME/fleet per publish; root it in a temp
  // home so the test never touches the real store.
  ashlrHomeDir = tmp('mobile-channel-home-');
  vi.stubEnv('ASHLR_HOME', ashlrHomeDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of active) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  active.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The fleet inbox receiver mirrors accepted posts onto the durable bus inbox
// under $ASHLR_HOME/fleet; the envelope id and body.channel expose which
// channel the hub route attributed the write to.
function busEnvelopes(): { id: string; channel: string; text: string; dedupeKey: string }[] {
  let rows: unknown;
  try { rows = JSON.parse(readFileSync(join(ashlrHomeDir, 'fleet', 'bus-inbox', 'messages.json'), 'utf8')); }
  catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const envelope = (row as { envelope: { id: string; body: { channel: string; text: string; dedupeKey: string } } }).envelope;
    return { id: envelope.id, channel: envelope.body.channel, text: envelope.body.text, dedupeKey: envelope.body.dedupeKey };
  });
}

function device(): RemoteDevice {
  return { id: DEVICE_ID, label: 'Phone', subject: SUBJECT, email: 'owner@example.com',
    scopes: { read: true, act: true }, credentialId: randomBytes(32).toString('base64url'),
    publicKey: randomBytes(80).toString('base64url'), counter: 0, transports: ['internal'],
    deviceType: 'multiDevice', backedUp: true, createdAt: 1, lastUsedAt: null, revokedAt: null };
}

async function fixture() {
  const root = tmp('mobile-channel-devices-');
  const runsDir = tmp('mobile-channel-runs-');
  const devices = createRemoteDeviceStore(root);
  devices.add(device());
  const forwarded: { path: string; headers: Record<string, unknown>; body: string }[] = [];
  const fleetApi = createFleetRunsApi({ runsDir });
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
  // A desktop/console caller posts the hub route directly on loopback; the
  // mutation token is the gate, exactly like the shipped listener.
  async function postDirect(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`http://127.0.0.1:${hubPort}${INBOX}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ashlr-token': MTOKEN, ...headers },
      body: JSON.stringify(body),
    });
  }
  return { post, postDirect, forwarded, runsDir };
}

describe('remote inbox mobile channel (RQ-PHX-MOBILECHANNELEND2END31)', () => {
  it('attributes a phone post to the mobile channel end to end, separate from desktop', async () => {
    const { post, postDirect, forwarded, runsDir } = await fixture();
    const text = 'hold the release until the phone fix lands';

    const res = await post(INBOX, { text, source: 'Phantom desktop' });
    expect(res.status).toBe(201);
    const wire = await res.json() as Record<string, unknown>;
    expect(wire).toMatchObject({ ok: true, accepted: true, duplicate: false });

    // The gateway stamped its own channel assertion; the client never saw it.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.headers['x-ashlr-channel']).toBe('mobile');
    expect(forwarded[0]!.headers['x-ashlr-remote-device']).toBe(DEVICE_ID);
    expect(JSON.parse(forwarded[0]!.body)).toEqual({ text, source: 'Phantom mobile' });

    const inbox = await readInboxEntries({ runsDir, limit: 10 });
    expect(inbox.entries.map((entry) => entry.source)).toEqual(['Phantom mobile']);
    expect(inbox.entries[0]!.text).toBe(text);

    let bus = busEnvelopes();
    expect(bus).toHaveLength(1);
    expect(bus[0]!.id).toMatch(/^mason-mobile-[a-f0-9]{16}$/);
    expect(bus[0]!.channel).toBe('mobile');
    expect(bus[0]!.text).toBe(text);
    // The wire carries the 96-bit prefix of the envelope's durable dedupe key.
    expect(bus[0]!.dedupeKey.startsWith(String(wire.dedupeKey).slice(7))).toBe(true);

    // The same text posted straight to the hub route is a desktop sender:
    // it lands as its own envelope rather than deduping against the phone's.
    const direct = await postDirect({ text });
    expect(direct.status).toBe(201);
    const directWire = await direct.json() as Record<string, unknown>;
    expect(directWire).toMatchObject({ ok: true, accepted: true, duplicate: false });
    expect(directWire.dedupeKey).not.toBe(wire.dedupeKey);

    const after = await readInboxEntries({ runsDir, limit: 10 });
    expect(after.entries.map((entry) => entry.source)).toEqual(['Phantom desktop', 'Phantom mobile']);
    bus = busEnvelopes();
    expect(bus).toHaveLength(2);
    expect(bus.map((row) => row.id)).toEqual([
      expect.stringMatching(/^mason-mobile-[a-f0-9]{16}$/),
      expect.stringMatching(/^mason-desktop-[a-f0-9]{16}$/),
    ]);

    // Within its own channel a resend still dedupes — per-channel, not global.
    const again = await post(INBOX, { text });
    expect(again.status).toBe(200);
    expect(await again.json() as Record<string, unknown>).toMatchObject({ accepted: false, duplicate: true });
    const againDirect = await postDirect({ text });
    expect(againDirect.status).toBe(200);
    expect(await againDirect.json() as Record<string, unknown>).toMatchObject({ accepted: false, duplicate: true });
    expect((await readInboxEntries({ runsDir, limit: 10 })).entries).toHaveLength(2);
    expect(busEnvelopes()).toHaveLength(2);
  });
});

describe('fleet runs inbox channel header mapping', () => {
  interface Reply { status: number; wire: Record<string, unknown> | null }
  async function post(api: ReturnType<typeof createFleetRunsApi>, body: unknown,
      opts: { channel?: string | string[]; token?: string | null } = {}): Promise<Reply> {
    const req = Readable.from([JSON.stringify(body ?? {})]) as unknown as IncomingMessage;
    req.url = INBOX;
    req.method = 'POST';
    const token = opts.token === undefined ? TOKEN : opts.token;
    req.headers = { 'content-type': 'application/json' };
    if (typeof token === 'string') req.headers['x-ashlr-token'] = token;
    if (opts.channel !== undefined) req.headers['x-ashlr-channel'] = opts.channel;
    let status = 0;
    let wire: Record<string, unknown> | null = null;
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; this.headersSent = true; },
      end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
    } as unknown as ServerResponse;
    const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true } as VerseApiContext;
    await api(ctx, req, res, INBOX, 'POST');
    return { status, wire };
  }

  it('maps x-ashlr-channel: mobile to the mobile channel and sender', async () => {
    const api = createFleetRunsApi({ runsDir: tmp('mobile-channel-runs-') });
    const reply = await post(api, { text: 'phone order' }, { channel: 'mobile' });
    expect(reply.status).toBe(201);
    expect(reply.wire).toMatchObject({ accepted: true, duplicate: false });
    const bus = busEnvelopes();
    expect(bus).toHaveLength(1);
    expect(bus[0]!.id).toMatch(/^mason-mobile-[a-f0-9]{16}$/);
    expect(bus[0]!.channel).toBe('mobile');
  });

  it('keeps the desktop mapping for a missing or untrusted header value', async () => {
    const api = createFleetRunsApi({ runsDir: tmp('mobile-channel-runs-') });
    for (const [index, channel] of [undefined, 'desktop', 'Mobile', 'mobile ', 'telegram', ['mobile']].entries()) {
      const reply = await post(api, { text: `desktop order ${index}` }, { channel });
      expect(reply.status).toBe(201);
      expect(reply.wire).toMatchObject({ accepted: true, duplicate: false });
    }
    const bus = busEnvelopes();
    expect(bus).toHaveLength(6);
    for (const row of bus) {
      expect(row.id).toMatch(/^mason-desktop-[a-f0-9]{16}$/);
      expect(row.channel).toBe('desktop');
    }
  });

  it('accepts a headered post only with the mutation token', async () => {
    const api = createFleetRunsApi({ runsDir: tmp('mobile-channel-runs-') });
    for (const token of [null, 'not-the-token']) {
      const reply = await post(api, { text: 'spoofed phone' }, { channel: 'mobile', token });
      expect(reply.status).toBe(401);
    }
    expect(busEnvelopes()).toHaveLength(0);
    const reply = await post(api, { text: 'spoofed phone' }, { channel: 'mobile' });
    expect(reply.status).toBe(201);
    expect(busEnvelopes()[0]!.id).toMatch(/^mason-mobile-/);
  });

  it('dedupes the same text per channel, never across them', async () => {
    const api = createFleetRunsApi({ runsDir: tmp('mobile-channel-runs-') });
    const mobile = await post(api, { text: 'same words' }, { channel: 'mobile' });
    const desktop = await post(api, { text: 'same words' });
    expect(mobile.status).toBe(201);
    expect(desktop.status).toBe(201);
    expect(desktop.wire?.dedupeKey).not.toBe(mobile.wire?.dedupeKey);
    const mobileRetry = await post(api, { text: 'same words' }, { channel: 'mobile' });
    const desktopRetry = await post(api, { text: 'same words' });
    expect(mobileRetry.status).toBe(200);
    expect(desktopRetry.status).toBe(200);
    expect(mobileRetry.wire?.dedupeKey).toBe(mobile.wire?.dedupeKey);
    expect(desktopRetry.wire?.dedupeKey).toBe(desktop.wire?.dedupeKey);
    expect(busEnvelopes().map((row) => row.id)).toEqual([
      expect.stringMatching(/^mason-mobile-/),
      expect.stringMatching(/^mason-desktop-/),
    ]);
  });
});
