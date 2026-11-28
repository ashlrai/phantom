import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  batsPreflight,
  batsPreprocessPath,
  runBatsSyntaxCheck,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

describe('selectChangedFiles bats coverage', () => {
  it('selects existing .bats files and skips deleted, non-bats and fixture paths', () => {
    const selection = selectChangedFiles(
      ['staging/RQ-X/precheck_dup_match.bats', 'tests/smoke.bats', 'src/core/x.ts', 'gone.bats', 'test/fixtures/bats/broken.bats', 'README.md'],
      ['staging/RQ-X/precheck_dup_match.bats', 'tests/smoke.bats', 'src/core/x.ts', 'test/fixtures/bats/broken.bats', 'README.md'],
    );
    expect(selection.batsFiles).toEqual(['staging/RQ-X/precheck_dup_match.bats', 'tests/smoke.bats']);
  });
});

function fakeBatsInstall(layout: 'libexec' | 'lib'): { root: string; pathDir: string; preprocess: string } {
  const root = mkdtempSync(join(tmpdir(), 'verify-bats-install-'));
  const binDir = join(root, 'bin');
  const libDir = layout === 'libexec' ? 'libexec' : 'lib';
  const preprocessDir = join(root, libDir, 'bats-core');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(preprocessDir, { recursive: true });
  writeFileSync(join(binDir, 'bats'), '#!/usr/bin/env bash\nexit 0\n');
  const preprocess = join(preprocessDir, 'bats-preprocess');
  writeFileSync(preprocess, '#!/usr/bin/env bash\nexit 0\n');
  // batsPreprocessPath realpaths the bats entry, so expectations name the
  // resolved root (tmpdir may sit behind a symlink, e.g. /var on macOS).
  const resolvedRoot = realpathSync(root);
  return { root: resolvedRoot, pathDir: binDir, preprocess: join(resolvedRoot, libDir, 'bats-core', 'bats-preprocess') };
}

describe('batsPreprocessPath', () => {
  it('finds the preprocessor under a libexec install root', () => {
    const install = fakeBatsInstall('libexec');
    try {
      const found = batsPreprocessPath(install.pathDir);
      expect(found).toEqual({ path: install.preprocess, root: install.root });
    } finally {
      rmSync(install.root, { recursive: true, force: true });
    }
  });

  it('finds the preprocessor under a lib install root', () => {
    const install = fakeBatsInstall('lib');
    try {
      const found = batsPreprocessPath(install.pathDir);
      expect(found).toEqual({ path: install.preprocess, root: install.root });
    } finally {
      rmSync(install.root, { recursive: true, force: true });
    }
  });

  it('resolves a symlinked bats entry to its real install root', () => {
    const install = fakeBatsInstall('libexec');
    const linkDir = mkdtempSync(join(tmpdir(), 'verify-bats-path-'));
    try {
      symlinkSync(join(install.pathDir, 'bats'), join(linkDir, 'bats'));
      const found = batsPreprocessPath(linkDir);
      expect(found).toEqual({ path: install.preprocess, root: install.root });
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
      rmSync(install.root, { recursive: true, force: true });
    }
  });

  it('scans PATH entries in order and skips entries without a bats file', () => {
    const install = fakeBatsInstall('libexec');
    const emptyDir = mkdtempSync(join(tmpdir(), 'verify-bats-empty-'));
    try {
      const found = batsPreprocessPath(`${emptyDir}${delimiter}${install.pathDir}`);
      expect(found).toEqual({ path: install.preprocess, root: install.root });
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
      rmSync(install.root, { recursive: true, force: true });
    }
  });

  it('returns null when bats or its preprocessor is absent', () => {
    expect(batsPreprocessPath('')).toBeNull();
    const root = mkdtempSync(join(tmpdir(), 'verify-bats-noproc-'));
    try {
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(join(root, 'bin', 'bats'), '#!/usr/bin/env bash\n');
      expect(batsPreprocessPath(join(root, 'bin'))).toBeNull();
      mkdirSync(join(root, 'bin', 'bats.d'), { recursive: true });
      rmSync(join(root, 'bin', 'bats'));
      mkdirSync(join(root, 'bin', 'bats'));
      expect(batsPreprocessPath(join(root, 'bin'))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('batsPreflight', () => {
  it('is ok when bats runs and bats-preprocess resolves', () => {
    const install = fakeBatsInstall('libexec');
    try {
      const spawn = () => ({ status: 0, stdout: 'Bats 1.13.0', stderr: '', error: undefined, signal: null });
      const preflight = batsPreflight(spawn as never, install.pathDir);
      expect(preflight.ok).toBe(true);
      expect(preflight).toHaveProperty('preprocess');
    } finally {
      rmSync(install.root, { recursive: true, force: true });
    }
  });

  it('fails closed when bats errors, is killed, or exits non-zero', () => {
    for (const result of [
      { status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null },
      { status: null, stdout: '', stderr: '', error: undefined, signal: 'SIGTERM' },
      { status: 1, stdout: '', stderr: 'no bats', error: undefined, signal: null },
    ]) {
      const spawn = () => result;
      const preflight = batsPreflight(spawn as never, '');
      expect(preflight.ok).toBe(false);
      expect(preflight).toHaveProperty('reason');
    }
  });

  it('reports SKIP when bats runs but bats-preprocess cannot be located', () => {
    const spawn = () => ({ status: 0, stdout: 'Bats 1.13.0', stderr: '', error: undefined, signal: null });
    const preflight = batsPreflight(spawn as never, '');
    expect(preflight.ok).toBe(false);
    expect((preflight as { reason?: string }).reason).toContain('bats-preprocess');
  });
});

describe('runBatsSyntaxCheck', () => {
  const preprocess = { path: '/opt/bats/libexec/bats-core/bats-preprocess', root: '/opt/bats' };

  it('preprocesses each file then parses the emitted bash with bash -n', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      if (args[0] === '-n') return { status: 0, stdout: '', stderr: '', error: undefined, signal: null };
      return { status: 0, stdout: `transformed:${args[1]}`, stderr: '', error: undefined, signal: null };
    };
    expect(runBatsSyntaxCheck('/repo', ['a.bats', 'dir/b.bats'], preprocess, spawn as never)).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[0]!.cmd).toBe('bash');
    expect(calls[0]!.args).toEqual([preprocess.path, './a.bats']);
    expect(calls[0]!.opts['cwd']).toBe('/repo');
    const env = calls[0]!.opts['env'] as Record<string, string>;
    expect(env['BATS_ROOT']).toBe('/opt/bats');
    expect(env['BATS_LIBDIR']).toBe('lib');
    expect(env['CHECK_BATS_COMMENT_COMMANDS']).toBe('1');
    expect(calls[1]!.cmd).toBe('bash');
    expect(calls[1]!.args).toEqual(['-n']);
    expect(calls[1]!.opts['input']).toBe('transformed:./a.bats');
    expect(calls[2]!.args).toEqual([preprocess.path, './dir/b.bats']);
  });

  it('returns false naming the file when the preprocessor fails', () => {
    const calls: string[] = [];
    const spawn = (_cmd: string, args: string[]) => {
      calls.push(args[0]!);
      return args[0] === '-n'
        ? { status: 0, stdout: '', stderr: '', error: undefined, signal: null }
        : { status: 1, stdout: '', stderr: 'preprocess error', error: undefined, signal: null };
    };
    expect(runBatsSyntaxCheck('/repo', ['bad.bats'], preprocess, spawn as never)).toBe(false);
    expect(calls).toEqual([preprocess.path]);
  });

  it('returns false naming the file when bash -n rejects the emitted bash', () => {
    const spawn = (_cmd: string, args: string[]) => args[0] === '-n'
      ? { status: 2, stdout: '', stderr: 'syntax error near unexpected token', error: undefined, signal: null }
      : { status: 0, stdout: 'emitted bash', stderr: '', error: undefined, signal: null };
    expect(runBatsSyntaxCheck('/repo', ['bad.bats'], preprocess, spawn as never)).toBe(false);
  });

  it('returns false when either interpreter cannot be spawned', () => {
    const spawnError = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runBatsSyntaxCheck('/repo', ['a.bats'], preprocess, spawnError as never)).toBe(false);
    const spawn = (_cmd: string, args: string[]) => args[0] === '-n'
      ? { status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null }
      : { status: 0, stdout: 'emitted bash', stderr: '', error: undefined, signal: null };
    expect(runBatsSyntaxCheck('/repo', ['a.bats'], preprocess, spawn as never)).toBe(false);
  });

  it('parses a real valid suite and rejects a real syntax error when bats exists', () => {
    const preflight = batsPreflight();
    if (!preflight.ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-bats-'));
    try {
      writeFileSync(join(root, 'ok.bats'), '#!/usr/bin/env bats\n@test "ok" { true; }\n');
      writeFileSync(join(root, 'bad.bats'), '@test "broken" {\n  if true; then\n    echo hi\n  fi\n  broken ( syntax\n}\n');
      expect(runBatsSyntaxCheck(root, ['ok.bats'], preflight.preprocess)).toBe(true);
      expect(runBatsSyntaxCheck(root, ['bad.bats'], preflight.preprocess)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
