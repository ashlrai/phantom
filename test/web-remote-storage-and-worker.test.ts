import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isPublicHttpsOrigin } from '../src/core/web/remote-access.js';
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  isPrivateStat,
  isValidBase64UrlBytes,
  lstatOrNull,
  readBoundedResponseBuffer,
  readPrivateJsonFile,
  readRemoteGatewayConfig,
  withPrivateExclusiveLock,
} from '../src/core/web/remote-storage.js';
import { resolveWorkerEntrypoint } from '../src/core/web/bounded-read-worker.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-web-shared-'));
  dirs.push(dir);
  return dir;
}

describe('web remote storage and origin helpers', () => {
  it('validates public HTTPS origins and rejects localhost, IP literals, and non-origins', () => {
    expect(isPublicHttpsOrigin('https://remote.ashlr.ai')).toBe(true);
    expect(isPublicHttpsOrigin('https://phone.example.test:8443')).toBe(true);
    for (const bad of [
      null,
      123,
      'http://remote.ashlr.ai',
      'https://localhost',
      'https://sub.localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://remote.ashlr.ai/',
      'https://remote.ashlr.ai/path',
      'https://intranet',
    ]) {
      expect(isPublicHttpsOrigin(bad)).toBe(false);
    }
  });

  it('validates exact base64url byte lengths', () => {
    const key32 = randomBytes(32).toString('base64url');
    expect(isValidBase64UrlBytes(key32, 32)).toBe(true);
    expect(isValidBase64UrlBytes(key32, 65)).toBe(false);
    expect(isValidBase64UrlBytes(`${key32}=`, 32)).toBe(false);
    expect(isValidBase64UrlBytes(42, 32)).toBe(false);
  });

  it('checks private directory/file stats, symlinks, and exclusive locks', () => {
    const root = tempDir();
    const nested = join(root, 'nested');
    expect(lstatOrNull(nested)).toBeNull();
    ensurePrivateDirectory(nested, 'dir not private');
    const dirStat = assertPrivatePath(nested, 'directory', 'dir not private');
    expect(isPrivateStat(dirStat, 'directory')).toBe(true);
    expect(isPrivateStat(dirStat, 'file')).toBe(false);

    const file = join(nested, 'data.json');
    writeFileSync(file, '{"ok":true}\n', { mode: 0o600 });
    expect(readPrivateJsonFile(file, 64, { notPrivate: 'np', tooLarge: 'tl', unreadable: 'ur' })).toEqual({ ok: true });

    const link = join(nested, 'link.json');
    symlinkSync(file, link);
    expect(() => readPrivateJsonFile(link, 64, { notPrivate: 'np', tooLarge: 'tl', unreadable: 'ur' })).toThrow('np');

    chmodSync(file, 0o644);
    expect(() => readPrivateJsonFile(file, 64, { notPrivate: 'np', tooLarge: 'tl', unreadable: 'ur' })).toThrow('np');
    chmodSync(file, 0o600);
    expect(() => readPrivateJsonFile(file, 5, { notPrivate: 'np', tooLarge: 'tl', unreadable: 'ur' })).toThrow('tl');

    writeFileSync(file, '{not-json', { mode: 0o600 });
    expect(() => readPrivateJsonFile(file, 64, { notPrivate: 'np', tooLarge: 'tl', unreadable: 'ur' })).toThrow('ur');

    const lockPath = join(nested, 'data.json.lock');
    expect(withPrivateExclusiveLock(nested, lockPath, { dirNotPrivate: 'dnp', lockNotPrivate: 'lnp' }, () => {
      expect(existsSync(lockPath)).toBe(true);
      expect(() => withPrivateExclusiveLock(nested, lockPath, { dirNotPrivate: 'dnp', lockNotPrivate: 'lnp' }, () => 1)).toThrow();
      return 'done';
    })).toBe('done');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reads and validates private remote gateway config files', () => {
    const root = tempDir();
    const file = join(root, 'gateway.json');
    const valid = {
      access: {
        publicOrigin: 'https://phone.example.test',
        teamDomain: 'https://fake.cloudflareaccess.com',
        audience: 'a'.repeat(64),
        allowedSubjects: ['fake-subject-123'],
      },
      gatewayPort: 43210,
    };
    writeFileSync(file, JSON.stringify(valid), { mode: 0o600 });
    expect(readRemoteGatewayConfig(file)).toEqual(valid);

    writeFileSync(file, JSON.stringify({ ...valid, extra: true }), { mode: 0o600 });
    expect(() => readRemoteGatewayConfig(file)).toThrow('Invalid remote gateway config');

    writeFileSync(file, JSON.stringify({ ...valid, gatewayPort: 70000 }), { mode: 0o600 });
    expect(() => readRemoteGatewayConfig(file)).toThrow('Remote gateway Access config or port is invalid');
  });

  it('reads bounded Fetch responses and returns null when content exceeds the limit', async () => {
    const ok = new Response('hello world', { headers: { 'content-length': '11' } });
    expect((await readBoundedResponseBuffer(ok, 16))?.toString('utf8')).toBe('hello world');

    const declaredTooBig = new Response('hello', { headers: { 'content-length': '99' } });
    expect(await readBoundedResponseBuffer(declaredTooBig, 16)).toBeNull();

    const streamed = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    }));
    expect(await readBoundedResponseBuffer(streamed, 16)).toBeNull();
  });
});

describe('resolveWorkerEntrypoint', () => {
  it('builds a tsx bootstrap data URL for source .ts callers and sibling .js URLs for compiled callers', () => {
    const sourceCaller = new URL('../src/core/web/read-projections.ts', import.meta.url).href;
    const devUrl = resolveWorkerEntrypoint(sourceCaller, 'read-projections.ts', 'read-projection-worker');
    expect(devUrl.protocol).toBe('data:');
    const decoded = decodeURIComponent(devUrl.href);
    expect(decoded).toContain('tsx');
    expect(decoded).toContain('read-projection-worker.ts');

    const distCaller = 'file:///opt/phantom/dist/core/web/read-projections.js';
    const distUrl = resolveWorkerEntrypoint(distCaller, 'read-projections.ts', 'read-projection-worker');
    expect(distUrl.href).toBe('file:///opt/phantom/dist/core/web/read-projection-worker.js');
  });
});
