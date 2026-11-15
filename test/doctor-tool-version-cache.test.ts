import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolVersionCacheSession } from '../src/doctor/tool-version-cache.js';

let home: string;
let executable: string;
let file: string;
const NOW = 1_793_000_000_000;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-version-cache-')));
  vi.stubEnv('HOME', home);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  executable = join(home, 'inert-tool');
  writeFileSync(executable, 'fixture', { mode: 0o700 });
  file = join(home, '.ashlr', 'cache', 'doctor', 'versions.json');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const cache = (args = ['--version']) => {
  const session = createToolVersionCacheSession();
  const entry = session.forExecutable(executable, args);
  return { read: () => entry.read(), write(version: string) { entry.write(version); session.flush(); } };
};

describe('display-only tool version cache', () => {
  it('batches an inventory into one publication and rechecks executable identity at flush', () => {
    const session = createToolVersionCacheSession();
    session.forExecutable(executable, ['--version']).write('1.0.0');
    session.forExecutable(executable, ['version']).write('2.0.0');
    expect(() => lstatSync(file)).toThrow();
    session.flush();
    expect(cache().read()).toBe('1.0.0');
    expect(cache(['version']).read()).toBe('2.0.0');
    const replaced = createToolVersionCacheSession();
    replaced.forExecutable(executable, ['--version']).write('3.0.0');
    writeFileSync(executable, 'replacement binary');
    replaced.flush();
    expect(cache().read()).toBeNull();
  });
  it('persists bounded semantic versions for independent invocations without raw paths or output', () => {
    expect(cache().read()).toBeNull();
    cache().write('1.2.3-beta.4+build.5');
    expect(cache().read()).toBe('1.2.3-beta.4+build.5');
    expect(cache(['version']).read()).toBeNull();
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(executable);
    expect(text).not.toContain('--version');
    if (process.platform !== 'win32') expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });
  it('invalidates changed executables and refuses a result from a probe spanning replacement', () => {
    const probing = cache();
    probing.write('1.0.0');
    writeFileSync(join(home, 'replacement'), 'new binary', { mode: 0o700 });
    renameSync(join(home, 'replacement'), executable);
    expect(cache().read()).toBeNull();
    probing.write('1.0.0');
    expect(cache().read()).toBeNull();
    cache().write('2.0.0');
    expect(cache().read()).toBe('2.0.0');
  });
  it('expires at sixty seconds and refuses future timestamps', () => {
    cache().write('1.0.0');
    vi.mocked(Date.now).mockReturnValue(NOW + 59_999);
    expect(cache().read()).toBe('1.0.0');
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    expect(cache().read()).toBeNull();
    vi.mocked(Date.now).mockReturnValue(NOW - 1);
    expect(cache().read()).toBeNull();
  });
  it('misses corrupt and oversized documents and rejects arbitrary command text', () => {
    cache().write('error: secret-shaped-output');
    expect(cache().read()).toBeNull();
    cache().write('1.0.0');
    writeFileSync(file, '{broken');
    expect(cache().read()).toBeNull();
    writeFileSync(file, ' '.repeat(65 * 1024));
    expect(cache().read()).toBeNull();
  });
  it('bounds retained records and ignores records with unknown fields', () => {
    cache().write('1.0.0');
    const seed = JSON.parse(readFileSync(file, 'utf8'));
    for (let i = 0; i < 127; i++) seed.entries.push({
      key: createHash('sha256').update(String(i)).digest('hex'), at: NOW, version: '1.0.0',
    });
    writeFileSync(file, JSON.stringify(seed));
    cache(['version']).write('2.0.0');
    const document = JSON.parse(readFileSync(file, 'utf8'));
    expect(document.entries).toHaveLength(128);
    expect(cache().read()).toBeNull();
    expect(cache(['version']).read()).toBe('2.0.0');
    document.entries[127].output = 'untrusted';
    writeFileSync(file, JSON.stringify(document));
    expect(cache(['version']).read()).toBeNull();
  });
  it('refuses symlinked files and ancestors without changing their targets', () => {
    cache().write('1.0.0');
    const target = join(home, 'untouched');
    writeFileSync(target, 'original', { mode: 0o600 });
    rmSync(file);
    symlinkSync(target, file);
    expect(cache().read()).toBeNull();
    cache().write('2.0.0');
    expect(readFileSync(target, 'utf8')).toBe('original');
    rmSync(join(home, '.ashlr'), { recursive: true });
    const redirected = join(home, 'redirected');
    mkdirSync(redirected);
    symlinkSync(redirected, join(home, '.ashlr'), 'dir');
    cache().write('2.0.0');
    expect(cache().read()).toBeNull();
    expect(() => lstatSync(join(redirected, 'cache'))).toThrow();
  });
  it('fails harmlessly when cache storage cannot be used', () => {
    writeFileSync(join(home, '.ashlr'), 'blocked');
    expect(() => cache().write('1.0.0')).not.toThrow();
    expect(cache().read()).toBeNull();
  });
  it('refuses writable cache directories and files on POSIX', () => {
    cache().write('1.0.0');
    if (process.platform === 'win32') return;
    chmodSync(file, 0o666);
    expect(cache().read()).toBeNull();
    cache().write('2.0.0');
    expect(readFileSync(file, 'utf8')).toContain('1.0.0');
    chmodSync(file, 0o600);
    chmodSync(join(home, '.ashlr', 'cache', 'doctor'), 0o777);
    expect(cache().read()).toBeNull();
  });
});
