import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { codexAuthOrLogin, inspectCodexHome, realCodexHomeFs, type CodexHomeFs } from '../src/core/providers/coding-cli/codex-home.js';

describe('preserved Codex home probe', () => {
  it.each(['ENOENT', 'ENOTDIR', 'EACCES'])('classifies an inaccessible home (%s)', code => {
    const fs: CodexHomeFs = {
      stat: () => { throw Object.assign(new Error('probe failed'), { code }); },
      access: vi.fn(), exists: vi.fn(),
    };
    expect(inspectCodexHome('/fixture', fs)).toBe(code === 'EACCES' ? 'unreadable' : 'missing');
    expect(fs.access).not.toHaveBeenCalled();
    expect(fs.exists).not.toHaveBeenCalled();
  });

  it('does not probe auth when the directory is unreadable', () => {
    const exists = vi.fn();
    expect(inspectCodexHome('/fixture', {
      stat: () => ({ isDirectory: () => true }),
      access: () => { throw new Error('denied'); }, exists,
    })).toBe('unreadable');
    expect(exists).not.toHaveBeenCalled();
  });

  it('checks only auth.json existence and leaves auth and backups byte-identical', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-home-'));
    try {
      const primary = join(root, 'primary');
      mkdirSync(primary);
      const auth = join(primary, 'auth.json');
      const backup = join(primary, 'auth.json.backup');
      const content = 'opaque fixture; deliberately not JSON';
      writeFileSync(backup, content, { mode: 0o600 });
      const fs = realCodexHomeFs();
      expect(inspectCodexHome(primary, fs)).toBe('auth-missing');
      writeFileSync(auth, content, { mode: 0o600 });
      expect(inspectCodexHome(primary, fs)).toBeNull();
      expect(() => fs.exists(backup)).toThrow('auth.json only');
      expect(readFileSync(auth, 'utf8')).toBe(content);
      expect(readFileSync(backup, 'utf8')).toBe(content);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['could not refresh token', 'auth'],
    ['not logged in', 'login'],
    ['rate limit exceeded', null],
  ])('classifies CLI account failure text without exposing it (%s)', (text, expected) => {
    expect(codexAuthOrLogin(text)).toBe(expected);
  });
});
