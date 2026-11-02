import { createServer, request as httpRequest, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createRemoteAccessVerifier } from '../src/core/web/remote-access.js';
import { createRemoteDeviceStore, type RemoteDevice } from '../src/core/web/remote-device-store.js';
import { startRemoteReadGateway } from '../src/core/web/remote-gateway.js';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';

const PATH = '/api/verse/leader/resources';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const DEVICE_ID = '6335d417-61da-459d-899c-0a01c76a2f94';
const READ_TOKEN = 'a'.repeat(64); // Plainly fake, but in the required hexadecimal format.
const CONFIG = {
  publicOrigin: 'https://phone.example.com', teamDomain: 'https://team.cloudflareaccess.com',
  audience: 'b'.repeat(64), allowedSubjects: [SUBJECT],
};

describe('remote leader resource ledger', () => {
  it('allows only the exact GET without any query or alternate path spelling', () => {
    expect(classifyRemoteRoute('GET', PATH)).toEqual({ kind: 'read', path: PATH });
    for (const method of ['POST', 'DELETE', 'HEAD', 'PUT']) {
      expect(classifyRemoteRoute(method, PATH)).toEqual({ kind: 'deny' });
    }
    for (const target of [
      `${PATH}?`, `${PATH}?limit=1`, `${PATH}?limit=1&limit=2`, `${PATH}??`,
      `${PATH}/`, `${PATH}/extra`, `${PATH}.json`, `${PATH}#fragment`,
      '/api/verse/leader/%72esources', '/api/verse/leader/resources%2f',
      '/api/verse/leader/%2572esources', '/api/verse/leader//resources',
      '/api/verse/leader/./resources', '/api/verse/leader/other/../resources',
      '/api/verse/leader\\resources', '//api/verse/leader/resources',
      '/api/session', '/api/token', '/api/verse/bootstrap/token',
    ]) expect(classifyRemoteRoute('GET', target), target).toEqual({ kind: 'deny' });
  });

  it('requires Access and a live paired device before forwarding the exact ledger read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'phantom-remote-ledger-'));
    const devices = createRemoteDeviceStore(root);
    const device: RemoteDevice = {
      id: DEVICE_ID, label: 'Fake phone', subject: SUBJECT, email: 'owner@example.com',
      scopes: { read: true, act: false }, credentialId: randomBytes(32).toString('base64url'),
      publicKey: randomBytes(80).toString('base64url'), counter: 0, transports: ['internal'],
      deviceType: 'multiDevice', backedUp: true, createdAt: 1, lastUsedAt: null, revokedAt: null,
    };
    devices.add(device);
    const received: { method: string | undefined; path: string | undefined; token: string | string[] | undefined }[] = [];
    const hub: Server = createServer((req, res) => {
      received.push({ method: req.method, path: req.url, token: req.headers['x-ashlr-token'] });
      if (req.method !== 'GET' || req.url !== PATH || req.headers['x-ashlr-token'] !== READ_TOKEN) {
        res.writeHead(404).end(); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ v: 1, lanes: [{ lane: 'fake-provider' }] }));
    });
    let gateway: Awaited<ReturnType<typeof startRemoteReadGateway>> | undefined;
    try {
      await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
      const port = (hub.address() as { port: number }).port;
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const key = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
      const verifier = createRemoteAccessVerifier(CONFIG, createLocalJWKSet({ keys: [key] }));
      const sign = (expiry: number) => new SignJWT({ type: 'app', email: 'owner@example.com' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(CONFIG.teamDomain).setAudience(CONFIG.audience)
        .setSubject(SUBJECT).setIssuedAt(Math.floor(Date.now() / 1000) - 10)
        .setNotBefore(Math.floor(Date.now() / 1000) - 10).setExpirationTime(expiry).sign(privateKey);
      const assertion = await sign(Math.floor(Date.now() / 1000) + 600);
      const expired = await sign(Math.floor(Date.now() / 1000) - 5);
      gateway = await startRemoteReadGateway({ access: CONFIG, devices, verifier, hub: { port, readToken: READ_TOKEN } });
      const session = gateway.issueDeviceSession({ subject: SUBJECT, email: 'owner@example.com', expiresAt: Date.now() + 600_000 }, DEVICE_ID);
      if (!session) throw new Error('fake device session was not issued');
      const cookie = session.cookie.split(';', 1)[0]!;
      const url = gateway.url;
      const get = (headers: Record<string, string>) => new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const req = httpRequest(`${url}${PATH}`, { headers: { host: 'phone.example.com', ...headers } }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });
      expect((await get({ cookie })).status).toBe(401);
      expect((await get({ cookie, 'cf-access-jwt-assertion': expired })).status).toBe(401);
      expect((await get({ 'cf-access-jwt-assertion': assertion })).status).toBe(401);
      expect(received).toHaveLength(0);
      const response = await get({ cookie, 'cf-access-jwt-assertion': assertion });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ v: 1, lanes: [{ lane: 'fake-provider' }] });
      expect(received).toEqual([{ method: 'GET', path: PATH, token: READ_TOKEN }]);
      devices.revoke(DEVICE_ID, Date.now());
      expect((await get({ cookie, 'cf-access-jwt-assertion': assertion })).status).toBe(401);
      expect(received).toHaveLength(1);
    } finally {
      await gateway?.close();
      hub.closeAllConnections();
      if (hub.listening) await new Promise<void>((resolve) => hub.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
