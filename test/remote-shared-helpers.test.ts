import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPhoneSessionCustody } from '../src/core/web/phone-session-custody.js';
import {
  REMOTE_BASE64URL_RE,
  REMOTE_SUBJECT_RE,
  REMOTE_TOKEN_RE,
  REMOTE_UUID_RE,
  assertPrivatePath,
  ensurePrivateDirectory,
  isBase64UrlOfByteLength,
  isPrivateOwnedStat,
  isPublicHttpsOrigin,
  isRemoteRecord,
  lstatOrNull,
  readBoundedResponse,
  readPrivateJsonObject,
  readRemoteGatewayConfig,
  sha256Hex,
  withExclusivePrivateLock,
} from '../src/core/web/remote-access.js';

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'remote-shared-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots.length = 0;
});

describe('remote shared guards, validators, and digest helpers', () => {
  it('validates plain records, identifiers, base64url byte lengths, and SHA-256 digests', () => {
    expect(isRemoteRecord({})).toBe(true);
    expect(isRemoteRecord(null)).toBe(false);
    expect(isRemoteRecord([])).toBe(false);
    expect(isRemoteRecord('x')).toBe(false);

    expect(REMOTE_UUID_RE.test('7335d417-61da-459d-899c-0a01c76a2f94')).toBe(true);
    expect(REMOTE_UUID_RE.test('not-a-uuid')).toBe(false);
    expect(REMOTE_SUBJECT_RE.test('subject_0123')).toBe(true);
    expect(REMOTE_SUBJECT_RE.test('short')).toBe(false);
    expect(REMOTE_BASE64URL_RE.test('abc_123-XYZ')).toBe(true);
    expect(REMOTE_BASE64URL_RE.test('abc+123=')).toBe(false);
    expect(REMOTE_TOKEN_RE.test('A'.repeat(43))).toBe(true);
    expect(REMOTE_TOKEN_RE.test('A'.repeat(42))).toBe(false);

    const key32 = Buffer.alloc(32, 7).toString('base64url');
    expect(isBase64UrlOfByteLength(key32, 32)).toBe(true);
    expect(isBase64UrlOfByteLength(key32, 65)).toBe(false);
    expect(isBase64UrlOfByteLength(`${key32}=`, 32)).toBe(false);
    expect(isBase64UrlOfByteLength(null, 32)).toBe(false);

    expect(sha256Hex('phantom')).toBe(sha256Hex(new TextEncoder().encode('phantom')));
    expect(sha256Hex('phantom')).toHaveLength(64);
  });

  it('accepts only public HTTPS origins and rejects localhost, IP literals, and paths', () => {
    expect(isPublicHttpsOrigin('https://phone.example.com')).toBe(true);
    for (const bad of [
      'http://phone.example.com',
      'https://localhost',
      'https://sub.localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://phone.example.com/',
      'https://phone.example.com/verse/m',
      'https://intranet',
      'not-a-url',
      null,
    ]) {
      expect(isPublicHttpsOrigin(bad)).toBe(false);
    }
  });
});

describe('remote shared private storage, locking, config, and response helpers', () => {
  it('enforces private owned paths and exclusive lock cleanup on both success and throw', () => {
    const root = tempRoot();
    const nested = join(root, 'nested');
    expect(lstatOrNull(nested)).toBeNull();

    ensurePrivateDirectory(nested, 'dir not private');
    const dirStat = assertPrivatePath(nested, 'directory', 'dir not private');
    expect(isPrivateOwnedStat(dirStat, 'directory')).toBe(true);
    expect(isPrivateOwnedStat(dirStat, 'file')).toBe(false);

    const file = join(nested, 'store.json');
    writeFileSync(file, '{"v":1}\n', { mode: 0o600 });
    expect(readPrivateJsonObject(file, 1024, 'Store')).toEqual({ v: 1 });

    const link = join(nested, 'link.json');
    symlinkSync(file, link);
    expect(() => readPrivateJsonObject(link, 1024, 'Store')).toThrow('Store is not private');

    chmodSync(file, 0o644);
    expect(() => readPrivateJsonObject(file, 1024, 'Store')).toThrow('Store is not private');
    chmodSync(file, 0o600);

    expect(() => readPrivateJsonObject(file, 2, 'Store')).toThrow('Store is too large');
    writeFileSync(file, '[]', { mode: 0o600 });
    expect(() => readPrivateJsonObject(file, 1024, 'Store')).toThrow('Store is invalid');
    writeFileSync(file, '{', { mode: 0o600 });
    expect(() => readPrivateJsonObject(file, 1024, 'Store')).toThrow('Store is unreadable');

    const lockPath = join(nested, 'store.lock');
    expect(withExclusivePrivateLock(nested, lockPath, { dir: 'd', lock: 'l' }, () => {
      expect(existsSync(lockPath)).toBe(true);
      expect(() => withExclusivePrivateLock(nested, lockPath, { dir: 'd', lock: 'l' }, () => 0)).toThrow();
      return 42;
    })).toBe(42);
    expect(existsSync(lockPath)).toBe(false);

    expect(() => withExclusivePrivateLock(nested, lockPath, { dir: 'd', lock: 'l' }, () => {
      throw new Error('boom');
    })).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reads valid private gateway configs and rejects insecure, symlinked, or malformed ones', () => {
    const root = tempRoot();
    const path = join(root, 'remote.json');
    const valid = {
      access: {
        publicOrigin: 'https://phone.example.com',
        teamDomain: 'https://team.cloudflareaccess.com',
        audience: 'a'.repeat(64),
        allowedSubjects: ['subject-1234'],
      },
      gatewayPort: 43210,
    };
    writeFileSync(path, JSON.stringify(valid), { mode: 0o600 });
    expect(readRemoteGatewayConfig(path)).toEqual(valid);

    const link = join(root, 'link.json');
    symlinkSync(path, link);
    expect(() => readRemoteGatewayConfig(link)).toThrow(/private 0600/);

    chmodSync(path, 0o644);
    expect(() => readRemoteGatewayConfig(path)).toThrow(/private 0600/);
    chmodSync(path, 0o600);

    writeFileSync(path, JSON.stringify({ ...valid, extra: true }), { mode: 0o600 });
    expect(() => readRemoteGatewayConfig(path)).toThrow('Invalid remote gateway config');

    writeFileSync(path, JSON.stringify({ ...valid, gatewayPort: 0 }), { mode: 0o600 });
    expect(() => readRemoteGatewayConfig(path)).toThrow('Remote gateway Access config or port is invalid');
  });

  it('bounds streamed HTTP responses and rejects oversized or empty-body responses', async () => {
    const ok = await readBoundedResponse(new Response('{"ok":true}'), 64);
    expect(ok?.toString('utf8')).toBe('{"ok":true}');

    const headerTooBig = new Response('ok', { headers: { 'content-length': '999' } });
    expect(await readBoundedResponse(headerTooBig, 64)).toBeNull();

    const streamTooBig = new Response('x'.repeat(100));
    expect(await readBoundedResponse(streamTooBig, 64)).toBeNull();

    expect(await readBoundedResponse(new Response(null), 64)).toBeNull();
  });

  it('replaces a prior phone custody handle for the same device and subject in one pass', () => {
    const root = tempRoot();
    const custody = createPhoneSessionCustody(root, () => 1_000);
    const deviceId = '7335d417-61da-459d-899c-0a01c76a2f94';
    const first = custody.issue({ deviceId, subject: 'subject-1234', scope: 'read', expiresAt: 5_000, token: 'a'.repeat(43) });
    const second = custody.issue({ deviceId, subject: 'subject-1234', scope: 'act', expiresAt: 6_000, token: 'b'.repeat(43) });

    expect(custody.tokenFor(first.handle)).toBeNull();
    expect(custody.tokenFor(second.handle)).toBe('b'.repeat(43));
    expect(custody.list()).toEqual([second]);
  });
});
