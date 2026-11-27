import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveReadWorkerEntrypoint } from '../src/core/web/bounded-read-worker.js';
import { isPublicHttpsOrigin } from '../src/core/web/remote-access.js';
import {
  assertPrivatePath, lstatOrNull, readPrivateJsonFile, readRemoteGatewayConfig, withPrivateFileLock,
} from '../src/core/web/remote-fs.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-web-helpers-'));
  chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

const VALID_CONFIG = {
  access: {
    publicOrigin: 'https://phone.example.com',
    teamDomain: 'https://team.cloudflareaccess.com',
    audience: 'a'.repeat(64),
    allowedSubjects: ['subject-12345678'],
  },
  gatewayPort: 43123,
};

describe('resolveReadWorkerEntrypoint', () => {
  it('emits a fixed tsx bootstrap URL when running from a matching TypeScript source file', () => {
    const caller = new URL('../src/core/web/read-projections.ts', import.meta.url);
    const resolved = resolveReadWorkerEntrypoint(caller.href, 'read-projections.ts', 'read-projection-worker');
    const loader = pathToFileURL(createRequire(caller).resolve('tsx/esm/api')).href;
    const source = new URL('./read-projection-worker.ts', caller).href;
    const expected = `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`;
    expect(resolved.href).toBe(`data:text/javascript,${encodeURIComponent(expected)}`);
  });

  it('resolves the sibling .js module when running from built or non-source URLs', () => {
    expect(resolveReadWorkerEntrypoint('file:///app/dist/core/web/read-projections.js', 'read-projections.ts', 'read-projection-worker').href)
      .toBe('file:///app/dist/core/web/read-projection-worker.js');
    expect(resolveReadWorkerEntrypoint('file:///$bunfs/root/_entry.js', 'read-projections.ts', 'read-projection-worker').href)
      .toBe('file:///$bunfs/root/read-projection-worker.js');
  });
});

describe('isPublicHttpsOrigin', () => {
  it('accepts canonical public HTTPS origins and rejects insecure, local, IP, or path-bearing URLs', () => {
    expect(isPublicHttpsOrigin('https://phone.example.com')).toBe(true);
    expect(isPublicHttpsOrigin('https://sub.phone.example.test')).toBe(true);
    for (const bad of [
      'http://phone.example.com', 'https://phone.example.com/', 'https://phone.example.com/verse/m',
      'https://localhost', 'https://app.localhost', 'https://127.0.0.1', 'https://[::1]', 'https://singlelabel', 'not-a-url',
    ]) expect(isPublicHttpsOrigin(bad), bad).toBe(false);
  });
});

describe('remote-fs helpers', () => {
  it('enforces ENOENT handling, file kind, symlink rejection, and 0600/0700 privacy', () => {
    const dir = makeTempDir();
    expect(lstatOrNull(join(dir, 'missing.json'))).toBeNull();
    const file = join(dir, 'secret.json');
    const link = join(dir, 'link.json');
    writeFileSync(file, '{}', { mode: 0o600 });
    symlinkSync(file, link);
    expect(lstatOrNull(file)?.isFile()).toBe(true);
    expect(assertPrivatePath(dir, 'directory', 'bad dir').isDirectory()).toBe(true);
    expect(assertPrivatePath(file, 'file', 'bad file').isFile()).toBe(true);
    expect(() => assertPrivatePath(dir, 'file', 'wrong kind')).toThrow('wrong kind');
    expect(() => assertPrivatePath(link, 'file', 'no symlink')).toThrow('no symlink');
    chmodSync(file, 0o644);
    expect(() => assertPrivatePath(file, 'file', 'too open')).toThrow('too open');
  });

  it('reads bounded private JSON files and surfaces caller error labels on failure', () => {
    const dir = makeTempDir();
    const file = join(dir, 'state.json');
    writeFileSync(file, '{"ok":true}', { mode: 0o600 });
    expect(readPrivateJsonFile(file, 64, 'Remote store')).toEqual({ ok: true });
    writeFileSync(file, '{bad json', { mode: 0o600 });
    expect(() => readPrivateJsonFile(file, 64, 'Remote store')).toThrow('Remote store is unreadable');
    writeFileSync(file, JSON.stringify({ pad: 'x'.repeat(100) }), { mode: 0o600 });
    expect(() => readPrivateJsonFile(file, 64, 'Remote store')).toThrow('Remote store is too large');
    chmodSync(file, 0o644);
    expect(() => readPrivateJsonFile(file, 1024, 'Remote store', 'Custom private err')).toThrow('Custom private err');
  });

  it('holds an exclusive lockfile during mutation, cleans up on error, and never steals an existing lock', () => {
    const dir = makeTempDir();
    const lockPath = join(dir, 'store.json.lock');
    expect(withPrivateFileLock(dir, lockPath, 'root open', 'lock open', () => {
      expect(existsSync(lockPath)).toBe(true);
      return 42;
    })).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
    expect(() => withPrivateFileLock(dir, lockPath, 'root open', 'lock open', () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
    writeFileSync(lockPath, 'held\n', { mode: 0o600 });
    expect(() => withPrivateFileLock(dir, lockPath, 'root open', 'lock open', () => 'never')).toThrow();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('reads valid private remote gateway configs and rejects insecure, oversized, or invalid ones', () => {
    const dir = makeTempDir();
    const file = join(dir, 'remote.json');
    writeFileSync(file, JSON.stringify(VALID_CONFIG), { mode: 0o600 });
    expect(readRemoteGatewayConfig(file)).toEqual(VALID_CONFIG);
    const link = join(dir, 'remote-link.json');
    symlinkSync(file, link);
    expect(() => readRemoteGatewayConfig(link)).toThrow(/private 0600 file/);
    chmodSync(file, 0o644);
    expect(() => readRemoteGatewayConfig(file)).toThrow(/private 0600 file/);
    writeFileSync(file, JSON.stringify({ ...VALID_CONFIG, extra: 'x'.repeat(9000) }), { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(() => readRemoteGatewayConfig(file)).toThrow(/private 0600 file/);
    writeFileSync(file, JSON.stringify({ ...VALID_CONFIG, extra: true }), { mode: 0o600 });
    expect(() => readRemoteGatewayConfig(file)).toThrow('Invalid remote gateway config');
    writeFileSync(file, JSON.stringify({ ...VALID_CONFIG, gatewayPort: 70_000 }), { mode: 0o600 });
    expect(() => readRemoteGatewayConfig(file)).toThrow('Remote gateway Access config or port is invalid');
  });
});
