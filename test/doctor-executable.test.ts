import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findDoctorExecutable } from '../src/doctor/executable.js';

const children = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), spawnSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:child_process', () => children);

let root: string;
let first: string;
let second: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-executable-')));
  first = join(root, 'first'); second = join(root, 'second');
  mkdirSync(first); mkdirSync(second);
  vi.stubEnv('PATH', [first, second].join(delimiter));
  for (const mock of Object.values(children)) mock.mockClear();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function executable(directory: string, name = 'inert-tool'): string {
  const path = join(directory, name);
  writeFileSync(path, 'fixture; never executed', { mode: 0o700 });
  return path;
}

describe('doctor executable discovery', () => {
  it('uses PATH order without launching a locator or candidate', () => {
    executable(second);
    expect(findDoctorExecutable('inert-tool')).toBe(join(second, 'inert-tool'));
    executable(first);
    expect(findDoctorExecutable('inert-tool')).toBe(join(first, 'inert-tool'));
    for (const mock of Object.values(children)) expect(mock).not.toHaveBeenCalled();
  });
  it('continues past missing files, directories and non-executable files', () => {
    expect(findDoctorExecutable('inert-tool')).toBeNull();
    mkdirSync(join(first, 'inert-tool'));
    executable(second);
    expect(findDoctorExecutable('inert-tool')).toBe(join(second, 'inert-tool'));
    rmSync(join(first, 'inert-tool'), { recursive: true });
    executable(first);
    chmodSync(join(first, 'inert-tool'), 0o600);
    expect(findDoctorExecutable('inert-tool')).toBe(join(second, 'inert-tool'));
  });
  it('returns the located symlink path and ignores dangling links', () => {
    const target = executable(second, 'real-tool');
    symlinkSync(target, join(first, 'inert-tool'));
    expect(findDoctorExecutable('inert-tool')).toBe(join(first, 'inert-tool'));
    rmSync(target);
    expect(findDoctorExecutable('inert-tool')).toBeNull();
  });
  it('sees replacements, removals and PATH changes immediately', () => {
    executable(first); executable(second);
    expect(findDoctorExecutable('inert-tool')).toBe(join(first, 'inert-tool'));
    rmSync(join(first, 'inert-tool'));
    expect(findDoctorExecutable('inert-tool')).toBe(join(second, 'inert-tool'));
    executable(first);
    vi.stubEnv('PATH', second);
    expect(findDoctorExecutable('inert-tool')).toBe(join(second, 'inert-tool'));
    vi.stubEnv('PATH', first);
    expect(findDoctorExecutable('inert-tool')).toBe(join(first, 'inert-tool'));
  });
  it('supports relative and empty POSIX PATH entries', () => {
    const cwd = process.cwd();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      executable(first);
      vi.stubEnv('PATH', 'first');
      expect(findDoctorExecutable('inert-tool')).toBe(join(first, 'inert-tool'));
      executable(root);
      vi.stubEnv('PATH', ['', first].join(delimiter));
      expect(findDoctorExecutable('inert-tool')).toBe(join(root, 'inert-tool'));
      vi.stubEnv('PATH', '');
      expect(findDoctorExecutable('inert-tool')).toBe(join(root, 'inert-tool'));
    } finally {
      vi.mocked(process.cwd).mockRestore();
      expect(process.cwd()).toBe(cwd);
    }
  });
  it('refuses path traversal, path names, options and unavailable PATH', () => {
    executable(first);
    for (const binary of ['../inert-tool', './inert-tool', '/inert-tool', '-tool', '', 'a\0b', 'a\\b']) {
      expect(findDoctorExecutable(binary)).toBeNull();
    }
    vi.stubEnv('PATH', undefined);
    expect(findDoctorExecutable('inert-tool')).toBeNull();
  });
  it('leaves Windows discovery to the trusted platform locator, without searching cwd', () => {
    executable(first);
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    expect(findDoctorExecutable('inert-tool')).toBeNull();
    for (const mock of Object.values(children)) expect(mock).not.toHaveBeenCalled();
  });
});
