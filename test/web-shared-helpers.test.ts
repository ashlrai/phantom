import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isWebRecord, readBoundedResponseBody, timingSafeTextEqual } from '../src/core/web/api-http-helpers.js';
import { resolveBoundedWorkerEntrypoint } from '../src/core/web/bounded-read-worker.js';
import { createPhoneSessionCustody } from '../src/core/web/phone-session-custody.js';
import { summarizeWorldForPhone } from '../src/core/web/phone-world-summary.js';
import {
  assertPrivatePath, isBase64UrlOfByteLength, isPublicHttpsOrigin, lstatOrNull,
  parseRemoteGatewayConfigRecord, readPrivateJsonRecord, withPrivateFileLock,
} from '../src/core/web/remote-access.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-web-shared-helpers-'));
  chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}
afterEach(() => { while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

describe('web shared HTTP, worker, and remote helpers', () => {
  it('guards plain records, compares tokens in constant time, and bounds response reads', async () => {
    expect(isWebRecord({ ok: true })).toBe(true);
    expect([null, undefined, ['a'], 'text', 42].some(isWebRecord)).toBe(false);

    expect(timingSafeTextEqual('secret-token', 'secret-token')).toBe(true);
    expect(timingSafeTextEqual('secret-token', 'secret-tokeN')).toBe(false);
    expect(timingSafeTextEqual('short', 'longer')).toBe(false);
    expect(timingSafeTextEqual('café', 'café')).toBe(true);
    expect(timingSafeTextEqual('café', 'cafe')).toBe(false);

    expect((await readBoundedResponseBody(new Response('{"ok":true}'), 64))?.toString('utf8')).toBe('{"ok":true}');
    expect(await readBoundedResponseBody(new Response('hi', { headers: { 'content-length': '100' } }), 10)).toBeNull();
    expect(await readBoundedResponseBody(new Response('0123456789abcdef'), 8)).toBeNull();
    expect(await readBoundedResponseBody(new Response(null, { status: 204 }), 64)).toBeNull();
  });

  it('resolves source tsx bootstrap and compiled sibling worker entrypoints', () => {
    const sourceCaller = pathToFileURL(join(process.cwd(), 'src/core/web/read-projections.ts')).href;
    const sourceUrl = resolveBoundedWorkerEntrypoint(sourceCaller, 'read-projections.ts', 'read-projection-worker');
    expect(sourceUrl.protocol).toBe('data:');
    expect(decodeURIComponent(sourceUrl.href)).toContain('read-projection-worker.ts');

    const distCaller = pathToFileURL(join(process.cwd(), 'dist/core/web/read-projections.js')).href;
    const distUrl = resolveBoundedWorkerEntrypoint(distCaller, 'read-projections.ts', 'read-projection-worker');
    expect(distUrl.protocol).toBe('file:');
    expect(distUrl.pathname.endsWith('/dist/core/web/read-projection-worker.js')).toBe(true);
  });

  it('validates public HTTPS origins and remote gateway config records', () => {
    const access = {
      publicOrigin: 'https://phone.example.com',
      teamDomain: 'https://team.cloudflareaccess.com',
      audience: 'a'.repeat(64),
      allowedSubjects: ['subject_12345678'],
    };
    expect(isPublicHttpsOrigin('https://phone.example.com')).toBe(true);
    for (const bad of ['http://phone.example.com', 'https://phone.example.com/p', 'https://localhost', 'https://a.localhost', 'https://127.0.0.1', 'bad']) {
      expect(isPublicHttpsOrigin(bad)).toBe(false);
    }
    expect(parseRemoteGatewayConfigRecord({ access, gatewayPort: 8443 })).toEqual({ access, gatewayPort: 8443 });
    expect(parseRemoteGatewayConfigRecord({ access, gatewayPort: 8443, extra: 1 })).toBeNull();
    expect(parseRemoteGatewayConfigRecord({ access, gatewayPort: 0 })).toBeNull();
    expect(parseRemoteGatewayConfigRecord('invalid')).toBeNull();
  });

  it('enforces private paths, bounded JSON reads, exclusive locks, and base64url lengths', () => {
    const dir = makeTempDir();
    const file = join(dir, 'state.json');
    const link = join(dir, 'link.json');
    expect(lstatOrNull(join(dir, 'missing.json'))).toBeNull();
    writeFileSync(file, '{"v":1}\n', { mode: 0o600 });
    symlinkSync(file, link);

    expect(assertPrivatePath(dir, 'directory', 'bad dir').isDirectory()).toBe(true);
    expect(() => assertPrivatePath(file, 'directory', 'wrong kind')).toThrow('wrong kind');
    expect(() => assertPrivatePath(link, 'file', 'no symlink')).toThrow('no symlink');

    const labels = { notPrivate: 'not private', tooLarge: 'too large', unreadable: 'unreadable', invalid: 'invalid' };
    expect(readPrivateJsonRecord(file, 64, labels)).toEqual({ v: 1 });
    expect(() => readPrivateJsonRecord(file, 2, labels)).toThrow('too large');
    chmodSync(file, 0o644);
    expect(() => readPrivateJsonRecord(file, 64, labels)).toThrow('not private');
    chmodSync(file, 0o600);
    writeFileSync(file, 'not-json', { mode: 0o600 });
    expect(() => readPrivateJsonRecord(file, 64, labels)).toThrow('unreadable');
    writeFileSync(file, '[]', { mode: 0o600 });
    expect(() => readPrivateJsonRecord(file, 64, labels)).toThrow('invalid');

    const lockPath = join(dir, 'state.json.lock');
    expect(withPrivateFileLock(dir, lockPath, 'dir bad', 'lock bad', () => {
      expect(existsSync(lockPath)).toBe(true);
      return 'ok';
    })).toBe('ok');
    expect(existsSync(lockPath)).toBe(false);
    expect(() => withPrivateFileLock(dir, lockPath, 'dir bad', 'lock bad', () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);

    const b64 = Buffer.alloc(16, 7).toString('base64url');
    expect(isBase64UrlOfByteLength(b64, 16)).toBe(true);
    expect(isBase64UrlOfByteLength(b64, 32)).toBe(false);
    expect(isBase64UrlOfByteLength('bad+chars/', 7)).toBe(false);
  });

  it('preserves measured zeros/unknowns in phone world summary and replaces phone session handles cleanly', () => {
    expect(summarizeWorldForPhone({
      schema: 'ashlr.world-model/v1',
      sensors: { lanes: [{ lane: 'claude', headroom: { value: 0, freshness: 'fresh' } }, { lane: 'codex', headroom: { value: 5, freshness: 'unknown' } }] },
      outcomes: { repos: [{ repo: 'phantom', mergedPerDay: { value: 3, freshness: 'stale' } }] },
      releases: { updateCheck: { value: 'up-to-date', freshness: 'fresh' }, train: { value: '', freshness: 'stale' } },
      bottlenecks: { count: { value: Number.NaN, freshness: 'fresh' } },
    })).toEqual({
      lanes: [{ lane: 'claude', headroom: { value: 0, freshness: 'fresh' } }, { lane: 'codex', headroom: { value: null, freshness: 'unknown' } }],
      pulls: [{ repo: 'phantom', mergedPerDay: { value: 3, freshness: 'stale' } }],
      releases: { updateCheck: { value: 'up-to-date', freshness: 'fresh' }, train: { value: null, freshness: 'stale' } },
      bottlenecks: { value: null, freshness: 'fresh' },
    });

    const dir = makeTempDir();
    const now = 1_700_000_000_000;
    const custody = createPhoneSessionCustody(dir, () => now);
    const devA = '11111111-1111-4111-8111-111111111111';
    const devB = '22222222-2222-4222-8222-222222222222';
    const first = custody.issue({ deviceId: devA, subject: 'sub_owner_1', scope: 'read', expiresAt: now + 60_000, token: 'a'.repeat(43) });
    const other = custody.issue({ deviceId: devB, subject: 'sub_owner_1', scope: 'act', expiresAt: now + 60_000, token: 'b'.repeat(43) });
    const next = custody.issue({ deviceId: devA, subject: 'sub_owner_1', scope: 'act', expiresAt: now + 120_000, token: 'c'.repeat(43) });
    expect(custody.tokenFor(first.handle)).toBeNull();
    expect(custody.tokenFor(other.handle)).toBe('b'.repeat(43));
    expect(custody.tokenFor(next.handle)).toBe('c'.repeat(43));
    expect(custody.list().map((s) => s.handle)).toEqual([other.handle, next.handle]);
  });
});
