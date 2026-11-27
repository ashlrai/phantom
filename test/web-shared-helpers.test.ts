import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSiblingWorkerEntrypoint,
  validateScopedConsolePath,
  validateSingleIdPayload,
} from '../src/core/web/bounded-read-worker.js';
import { createPhoneSessionCustody } from '../src/core/web/phone-session-custody.js';
import { summarizeWorldForPhone } from '../src/core/web/phone-world-summary.js';
import { isPublicHttpsOrigin } from '../src/core/web/remote-access.js';
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  isBase64UrlBytes,
  lstatOrNull,
  readBoundedResponseBody,
  readPrivateJsonRecord,
  readRemoteGatewayConfig,
  withPrivateFileLock,
} from '../src/core/web/remote-store-helpers.js';
import {
  applyScopedConsoleSecurityHeaders,
  isLoopbackPortHost,
  listenLoopbackServer,
} from '../src/core/web/scoped-console-http.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-shared-helpers-'));
  roots.push(dir);
  return dir;
}

describe('remote-store-helpers and remote-access', () => {
  it('validates public HTTPS origins and base64url byte lengths', () => {
    expect(isPublicHttpsOrigin('https://phone.example.com')).toBe(true);
    for (const bad of ['http://phone.example.com', 'https://localhost', 'https://a.localhost', 'https://127.0.0.1', 'https://phone.example.com/path', 'not-a-url']) {
      expect(isPublicHttpsOrigin(bad)).toBe(false);
    }
    const key32 = Buffer.alloc(32, 7).toString('base64url');
    expect(isBase64UrlBytes(key32, 32)).toBe(true);
    expect(isBase64UrlBytes(key32, 65)).toBe(false);
    expect(isBase64UrlBytes('not+valid/chars', 10)).toBe(false);
  });

  it('enforces private paths, locks, JSON record bounds, and remote gateway config validation', () => {
    const dir = makeRoot();
    const nested = join(dir, 'private');
    ensurePrivateDirectory(nested, 'not private');
    expect(lstatOrNull(join(nested, 'missing'))).toBeNull();
    const file = join(nested, 'data.json');
    const lock = `${file}.lock`;
    const value = withPrivateFileLock(nested, lock, 'dir bad', 'lock bad', () => {
      expect(existsSync(lock)).toBe(true);
      writeFileSync(file, JSON.stringify({ ok: true }), { mode: 0o600 });
      return 42;
    });
    expect(value).toBe(42);
    expect(existsSync(lock)).toBe(false);

    const labels = { notPrivate: 'priv', tooLarge: 'big', unreadable: 'unreadable', invalid: 'invalid' };
    expect(readPrivateJsonRecord(file, 1024, labels)).toEqual({ ok: true });
    expect(() => readPrivateJsonRecord(file, 4, labels)).toThrow('big');
    chmodSync(file, 0o644);
    expect(() => assertPrivatePath(file, 'file', 'priv')).toThrow('priv');
    chmodSync(file, 0o600);
    const link = join(nested, 'link.json');
    symlinkSync(file, link);
    expect(() => assertPrivatePath(link, 'file', 'priv')).toThrow('priv');

    const cfgPath = join(nested, 'remote.json');
    writeFileSync(cfgPath, JSON.stringify({
      access: {
        publicOrigin: 'https://phone.example.com',
        teamDomain: 'https://team.cloudflareaccess.com',
        audience: 'a'.repeat(64),
        allowedSubjects: ['subject-12345678'],
      },
      gatewayPort: 43210,
    }), { mode: 0o600 });
    expect(readRemoteGatewayConfig(cfgPath).gatewayPort).toBe(43210);
    chmodSync(cfgPath, 0o644);
    expect(() => readRemoteGatewayConfig(cfgPath)).toThrow(/private 0600/);
  });

  it('bounds streamed fetch responses by content-length and actual bytes', async () => {
    const ok = await readBoundedResponseBody(new Response('hello'), 10);
    expect(ok?.toString('utf8')).toBe('hello');
    expect(await readBoundedResponseBody(new Response('hello world'), 5)).toBeNull();
    expect(await readBoundedResponseBody(new Response('hi', { headers: { 'content-length': '99' } }), 5)).toBeNull();
  });
});

describe('bounded-read-worker and scoped-console-http', () => {
  it('resolves dev .ts and compiled .js sibling worker entrypoints', () => {
    const devUrl = createSiblingWorkerEntrypoint(new URL('../src/core/web/read-projections.ts', import.meta.url).href, 'read-projection-worker')();
    expect(devUrl.protocol).toBe('data:');
    expect(decodeURIComponent(devUrl.href)).toContain('read-projection-worker.ts');
    const prodUrl = createSiblingWorkerEntrypoint('file:///opt/phantom/dist/core/web/read-projections.js', 'read-projection-worker')();
    expect(prodUrl.href).toBe('file:///opt/phantom/dist/core/web/read-projection-worker.js');
  });

  it('validates scoped console paths and single-id payloads', () => {
    expect(validateScopedConsolePath('/tmp/demo', 'bad')).toBe('/tmp/demo');
    expect(() => validateScopedConsolePath('/', 'bad')).toThrow('bad');
    expect(() => validateScopedConsolePath('relative/path', 'bad')).toThrow('bad');
    expect(() => validateScopedConsolePath('/tmp/\u0007bad', 'bad')).toThrow('bad');
    expect(validateSingleIdPayload({ campaignId: 'camp-1' }, 'campaignId')).toEqual({ campaignId: 'camp-1' });
    expect(validateSingleIdPayload({ campaignId: 'camp-1', extra: 1 }, 'campaignId')).toBeNull();
    expect(validateSingleIdPayload({ campaignId: 'UPPER' }, 'campaignId')).toBeNull();
  });

  it('sets scoped security headers, checks loopback host, and binds loopback port', async () => {
    const headers = new Map<string, string>();
    applyScopedConsoleSecurityHeaders({ setHeader: (k: string, v: string) => { headers.set(k, v); } } as unknown as ServerResponse);
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(isLoopbackPortHost('127.0.0.1:7777', 7777)).toBe(true);
    expect(isLoopbackPortHost('[::1]:7777', 7777)).toBe(true);
    expect(isLoopbackPortHost('example.com:7777', 7777)).toBe(false);

    const server = createServer();
    try {
      const bound = await listenLoopbackServer(server, 0, 'unavailable');
      expect(bound.port).toBeGreaterThan(0);
      expect(bound.origin).toBe(`http://127.0.0.1:${bound.port}`);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('phone custody and world summary clarity', () => {
  it('replaces prior token for the same device/subject in one pass without dropping other devices', () => {
    const custody = createPhoneSessionCustody(makeRoot(), () => 1_000);
    const first = custody.issue({ deviceId: '11111111-1111-1111-1111-111111111111', subject: 'sub-1', scope: 'read', expiresAt: 5_000, token: 'a'.repeat(43) });
    const other = custody.issue({ deviceId: '22222222-2222-2222-2222-222222222222', subject: 'sub-1', scope: 'read', expiresAt: 5_000, token: 'b'.repeat(43) });
    const second = custody.issue({ deviceId: '11111111-1111-1111-1111-111111111111', subject: 'sub-1', scope: 'act', expiresAt: 5_000, token: 'c'.repeat(43) });
    expect(custody.tokenFor(first.handle)).toBeNull();
    expect(custody.tokenFor(second.handle)).toBe('c'.repeat(43));
    expect(custody.tokenFor(other.handle)).toBe('b'.repeat(43));
    expect(custody.list()).toHaveLength(2);
  });

  it('preserves stale/unknown/fresh freshness without fabricating zero values', () => {
    const summary = summarizeWorldForPhone({
      schema: 'ashlr.world-model/v1',
      sensors: { lanes: [{ lane: 'claude', headroom: { value: Number.NaN, freshness: 'stale' } }] },
      releases: { updateCheck: { value: '', freshness: 'fresh' }, train: { value: 'v3', freshness: 'stale' } },
      bottlenecks: { count: { value: 0, freshness: 'unknown' } },
    });
    expect(summary?.lanes[0]?.headroom).toEqual({ value: null, freshness: 'stale' });
    expect(summary?.releases.updateCheck).toEqual({ value: null, freshness: 'fresh' });
    expect(summary?.releases.train).toEqual({ value: 'v3', freshness: 'stale' });
    expect(summary?.bottlenecks).toEqual({ value: null, freshness: 'unknown' });
  });
});
