import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, it, vi } from 'vitest';
import { createRemoteAccessVerifier } from '../src/core/web/remote-access.js';
import { sendRemoteAdminCommand, startRemoteAdminSocket } from '../src/core/web/remote-admin.js';
import { createRemoteDeviceStore, type RemoteDevice } from '../src/core/web/remote-device-store.js';
import { startRemoteReadGateway } from '../src/core/web/remote-gateway.js';
import { createRemotePairing } from '../src/core/web/remote-pairing.js';

const ORIGIN = 'https://phone.example.com';
const SUBJECT = '11111111-1111-4111-8111-111111111111';
const PHONE = '22222222-2222-4222-8222-222222222222';
const OTHER_PHONE = '33333333-3333-4333-8333-333333333333';
const READ_TOKEN = 'a'.repeat(64); // Fake local Hub credential.
const CONFIG = { publicOrigin: ORIGIN, teamDomain: 'https://team.cloudflareaccess.com',
  audience: 'b'.repeat(64), allowedSubjects: [SUBJECT] };
const FLEET_PATH = '/api/verse/fleet/live';
const FLEET = { v: 1, runs: [{ id: 'fake-job-1' }] };

function fakeDevice(id: string): RemoteDevice {
  return { id, label: 'Fake phone', subject: SUBJECT, email: 'fake@example.invalid',
    scopes: { read: true, act: false }, credentialId: randomBytes(32).toString('base64url'),
    publicKey: randomBytes(80).toString('base64url'), counter: 0, transports: ['internal'],
    deviceType: 'multiDevice', backedUp: true, createdAt: 1, lastUsedAt: null, revokedAt: null };
}

it('revokes one paired phone through Mac administration without interrupting another phone or local desktop', async () => {
  // Darwin's Unix socket path limit can be exceeded by a nested TMPDIR.
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'phx-revoke-'));
  const devices = createRemoteDeviceStore(root);
  devices.add(fakeDevice(PHONE));
  devices.add(fakeDevice(OTHER_PHONE));
  const pairing = createRemotePairing(CONFIG, devices);
  let allowRevoke = false;
  const confirm = vi.fn(async () => allowRevoke);
  const received: string[] = [];
  const hub = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === FLEET_PATH && req.headers['x-ashlr-token'] === READ_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(FLEET));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  let admin: Awaited<ReturnType<typeof startRemoteAdminSocket>> | undefined;
  let gateway: Awaited<ReturnType<typeof startRemoteReadGateway>> | undefined;
  try {
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
    const hubPort = (hub.address() as { port: number }).port;
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const key = { ...await exportJWK(publicKey), kid: 'fake-key', alg: 'RS256', use: 'sig' };
    const verifier = createRemoteAccessVerifier(CONFIG, createLocalJWKSet({ keys: [key] }));
    const jwt = await new SignJWT({ type: 'app', email: 'fake@example.invalid' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-key' }).setIssuer(CONFIG.teamDomain)
      .setAudience(CONFIG.audience).setSubject(SUBJECT).setIssuedAt().setNotBefore('0s')
      .setExpirationTime('10m').sign(privateKey);
    gateway = await startRemoteReadGateway({ access: CONFIG, devices, pairing, verifier,
      hub: { port: hubPort, readToken: READ_TOKEN } });
    admin = await startRemoteAdminSocket(pairing, devices, root, confirm);
    const identity = { subject: SUBJECT, email: 'fake@example.invalid', expiresAt: Date.now() + 600_000 };
    const phone = gateway.issueDeviceSession(identity, PHONE);
    const other = gateway.issueDeviceSession(identity, OTHER_PHONE);
    expect(phone).not.toBeNull();
    expect(other).not.toBeNull();
    const gatewayUrl = gateway.url;
    async function read(cookie: string) {
      return new Promise<Response>((resolve, reject) => {
        const req = httpRequest(`${gatewayUrl}${FLEET_PATH}`, { headers: {
          host: 'phone.example.com', 'cf-access-jwt-assertion': jwt, cookie,
        } }, (res) => resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
          status: res.statusCode, headers: res.headers as HeadersInit,
        })));
        req.on('error', reject);
        req.end();
      });
    }
    const phoneCookie = phone!.cookie.split(';', 1)[0]!;
    const otherCookie = other!.cookie.split(';', 1)[0]!;
    const before = await read(phoneCookie);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual(FLEET);
    expect(received).toEqual([`GET ${FLEET_PATH}`]);

    expect(await sendRemoteAdminCommand({ action: 'revoke', id: PHONE }, root))
      .toEqual({ error: 'Mac operator confirmation required' });
    expect(devices.getActive(PHONE, SUBJECT)?.id).toBe(PHONE);
    allowRevoke = true;
    expect(await sendRemoteAdminCommand({ action: 'revoke', id: PHONE }, root)).toEqual({ revoked: true });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledWith('revoke', PHONE);
    expect(createRemoteDeviceStore(root).getActive(PHONE, SUBJECT)).toBeNull();

    const callsBeforeReplay = received.length;
    const replay = await read(phoneCookie);
    expect(replay.status).toBe(401);
    expect(received).toHaveLength(callsBeforeReplay);
    const otherRead = await read(otherCookie);
    expect(otherRead.status).toBe(200);
    expect(await otherRead.json()).toEqual(FLEET);
    expect(received).toHaveLength(callsBeforeReplay + 1);

    // Model the desktop's direct local Hub read, independently of phone sessions.
    const desktop = await fetch(`http://127.0.0.1:${hubPort}${FLEET_PATH}`, { headers: { 'x-ashlr-token': READ_TOKEN } });
    expect(desktop.status).toBe(200);
    expect(await desktop.json()).toEqual(FLEET);
    expect(received).toHaveLength(callsBeforeReplay + 2);
  } finally {
    if (admin) await admin.close();
    if (gateway) await gateway.close();
    hub.closeAllConnections();
    if (hub.listening) await new Promise<void>((resolve) => hub.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
