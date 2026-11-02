import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRemoteAccessVerifier } from '../src/core/web/remote-access.js';
import { createRemoteDeviceStore } from '../src/core/web/remote-device-store.js';
import { startRemoteReadGateway } from '../src/core/web/remote-gateway.js';
import { createRemotePairing } from '../src/core/web/remote-pairing.js';

const MARKER = '<meta name="ashlr-remote-gateway" content="v1">';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const DEVICE_ID = '6335d417-61da-459d-899c-0a01c76a2f94';
const CONFIG = { publicOrigin: 'https://phone.example.com', teamDomain: 'https://team.cloudflareaccess.com',
  audience: 'b'.repeat(64), allowedSubjects: [SUBJECT] };
const dirs: string[] = [];
const servers = new Set<Server>();

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function fixture(mobileAssetsEnabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-shell-'));
  dirs.push(root);
  const assetsDir = join(root, 'public');
  const next = join(assetsDir, 'next');
  mkdirSync(next, { recursive: true });
  const devices = createRemoteDeviceStore(join(root, 'devices'));
  devices.add({ id: DEVICE_ID, label: 'Phone', subject: SUBJECT, email: 'owner@example.com',
    scopes: { read: true, act: false }, credentialId: randomBytes(32).toString('base64url'),
    publicKey: randomBytes(80).toString('base64url'), counter: 0, transports: ['internal'],
    deviceType: 'multiDevice', backedUp: true, createdAt: 1, lastUsedAt: null, revokedAt: null });
  const hub = createServer((_req, res) => { res.writeHead(401); res.end(); });
  servers.add(hub);
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const verifier = createRemoteAccessVerifier(CONFIG, createLocalJWKSet({ keys: [key] }));
  const jwt = await new SignJWT({ type: 'app', email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(CONFIG.teamDomain).setAudience(CONFIG.audience)
    .setSubject(SUBJECT).setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000) - 1).setExpirationTime('10m').sign(privateKey);
  const gateway = await startRemoteReadGateway({
    access: CONFIG, devices, verifier, pairing: createRemotePairing(CONFIG, devices), assetsDir, mobileAssetsEnabled,
    hub: { port: (hub.address() as { port: number }).port, readToken: 'a'.repeat(64) },
  });
  const session = gateway.issueDeviceSession({ subject: SUBJECT, email: 'owner@example.com', expiresAt: Date.now() + 600_000 }, DEVICE_ID);
  if (!session) throw new Error('fixture session missing');
  async function get(path: string, assertion = jwt, paired = false) {
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(`${gateway.url}${path}`, {
        headers: { host: 'phone.example.com', 'cf-access-jwt-assertion': assertion,
          ...(paired ? { cookie: session!.cookie.split(';', 1)[0]! } : {}) },
      }, (response) => resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: response.statusCode, headers: response.headers as HeadersInit,
      })));
      request.on('error', reject);
      request.end();
    });
  }
  return { next, get, close: gateway.close };
}

describe('remote mobile shell reload', () => {
  for (const marked of [false, true]) {
    it(`serves both aliases repeatedly with exactly one marker when ${marked ? 'marked' : 'unmarked'}`, async () => {
      const f = await fixture();
      try {
        const html = `<!doctype html><html><head>${marked ? MARKER : ''}<title>Phone</title></head><body></body></html>`;
        writeFileSync(join(f.next, 'index.html'), html);
        for (const path of ['/verse/m', '/verse/m/']) {
          for (let i = 0; i < 2; i++) {
            const response = await f.get(path);
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/html');
            expect(response.headers.get('cache-control')).toBe('no-store');
            const body = await response.text();
            expect(body.split(MARKER)).toHaveLength(2);
            expect(body).toBe(marked ? html : html.replace('<head>', `<head>${MARKER}`));
          }
        }
      } finally { await f.close(); }
    }, 20_000);
  }

  it('returns the bounded unavailable response for missing, unreadable, or malformed shells', async () => {
    const f = await fixture();
    try {
      const shell = join(f.next, 'index.html');
      const unavailable = async () => {
        for (const path of ['/verse/m', '/verse/m/']) {
          const response = await f.get(path);
          expect(response.status).toBe(503);
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(await response.json()).toEqual({ code: 'REMOTE_ASSETS_UNAVAILABLE', error: 'Mobile assets unavailable' });
        }
      };
      await unavailable();
      mkdirSync(shell);
      await unavailable();
      rmSync(shell, { recursive: true });
      for (const html of [
        '<html><head><title>missing close</title></html>',
        '<html></head><head></html>',
        '<html><head><head></head></html>',
        `<html><head>${MARKER}${MARKER}</head></html>`,
        `<html><head></head><body>${MARKER}</body></html>`,
        '<html><head><meta name="ashlr-remote-gateway" content="other"></head></html>',
      ]) {
        writeFileSync(shell, html);
        await unavailable();
      }
    } finally { await f.close(); }
  }, 20_000);

  it('retains Access authentication, asset gating, and the static allowlist', async () => {
    const f = await fixture();
    try {
      writeFileSync(join(f.next, 'index.html'), '<html><head></head><body></body></html>');
      writeFileSync(join(f.next, 'private.txt'), 'not public');
      expect((await f.get('/verse/m', '')).status).toBe(401);
      expect((await f.get('/next/private.txt', undefined, true)).status).toBe(404);
      expect((await f.get('/verse/m?extra=1', undefined, true)).status).toBe(404);
    } finally { await f.close(); }
    const disabled = await fixture(false);
    try {
      writeFileSync(join(disabled.next, 'index.html'), '<html><head></head></html>');
      expect((await disabled.get('/verse/m', undefined, true)).status).toBe(404);
    } finally { await disabled.close(); }
  }, 20_000);
});
