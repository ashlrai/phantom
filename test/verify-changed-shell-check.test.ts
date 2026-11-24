import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runShellSyntaxCheck, selectChangedFiles, shellPreflight } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles shell coverage', () => {
  it('selects existing .sh files and skips deleted or non-shell paths', () => {
    const selection = selectChangedFiles(
      ['contrib/mac/install.sh', 'install.sh', 'src/core/x.ts', 'gone.sh', 'README.md'],
      ['contrib/mac/install.sh', 'install.sh', 'src/core/x.ts', 'README.md'],
    );
    expect(selection.shellFiles).toEqual(['contrib/mac/install.sh', 'install.sh']);
  });
});

describe('shellPreflight', () => {
  it('is ok when bash --version exits 0', () => {
    const spawn = () => ({ status: 0, stdout: 'GNU bash, version 5.2', stderr: '', error: undefined, signal: null });
    expect(shellPreflight(spawn as never).ok).toBe(true);
  });

  it('fails closed when bash errors, is killed, or exits non-zero', () => {
    for (const result of [
      { status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null },
      { status: null, stdout: '', stderr: '', error: undefined, signal: 'SIGTERM' },
      { status: 1, stdout: '', stderr: 'no bash', error: undefined, signal: null },
    ]) {
      const spawn = () => result;
      const preflight = shellPreflight(spawn as never);
      expect(preflight.ok).toBe(false);
      expect(preflight).toHaveProperty('reason');
    }
  });
});

describe('runShellSyntaxCheck', () => {
  it('hands every changed file to one bash -c batch run', () => {
    const calls: { cmd: string; args: string[]; opts: { cwd: string } }[] = [];
    const spawn = (cmd: string, args: string[], opts: { cwd: string }) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runShellSyntaxCheck('/repo', ['a.sh', 'dir/b.sh'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('bash');
    expect(calls[0]!.args[0]).toBe('-c');
    expect(calls[0]!.args.slice(3)).toEqual(['a.sh', 'dir/b.sh']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero interpreter result', () => {
    const spawn = () => ({ status: 1, stdout: '', stderr: 'bad.sh: line 1: syntax error near unexpected token', error: undefined, signal: null });
    expect(runShellSyntaxCheck('/repo', ['bad.sh'], spawn as never)).toBe(false);
  });

  it('returns false when the interpreter cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runShellSyntaxCheck('/repo', ['a.sh'], spawn as never)).toBe(false);
  });

  it('parses a real valid script and rejects a real syntax error when bash exists', () => {
    if (!shellPreflight().ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-shell-'));
    try {
      writeFileSync(join(root, 'ok.sh'), '#!/bin/bash\necho ok\n');
      writeFileSync(join(root, 'bad.sh'), 'if then\n');
      expect(runShellSyntaxCheck(root, ['ok.sh'])).toBe(true);
      expect(runShellSyntaxCheck(root, ['bad.sh'])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
