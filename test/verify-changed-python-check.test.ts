import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pythonPreflight, runPythonSyntaxCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles python coverage', () => {
  it('selects existing .py files and skips deleted or non-python paths', () => {
    const selection = selectChangedFiles(
      ['contrib/mac/dispatchd.py', 'fleet/sync.py', 'src/core/x.ts', 'gone.py', 'README.md'],
      ['contrib/mac/dispatchd.py', 'fleet/sync.py', 'src/core/x.ts', 'README.md'],
    );
    expect(selection.pythonFiles).toEqual(['contrib/mac/dispatchd.py', 'fleet/sync.py']);
  });
});

describe('pythonPreflight', () => {
  it('is ok when python3 --version exits 0', () => {
    const spawn = () => ({ status: 0, stdout: 'Python 3.12.1', stderr: '', error: undefined, signal: null });
    expect(pythonPreflight(spawn as never).ok).toBe(true);
  });

  it('fails closed when python3 errors, is killed, or exits non-zero', () => {
    for (const result of [
      { status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null },
      { status: null, stdout: '', stderr: '', error: undefined, signal: 'SIGTERM' },
      { status: 1, stdout: '', stderr: 'no python', error: undefined, signal: null },
    ]) {
      const spawn = () => result;
      const preflight = pythonPreflight(spawn as never);
      expect(preflight.ok).toBe(false);
      expect(preflight).toHaveProperty('reason');
    }
  });
});

describe('runPythonSyntaxCheck', () => {
  it('hands every changed file to one python3 -c compile run', () => {
    const calls: { cmd: string; args: string[]; opts: { cwd: string } }[] = [];
    const spawn = (cmd: string, args: string[], opts: { cwd: string }) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runPythonSyntaxCheck('/repo', ['a.py', 'dir/b.py'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('python3');
    expect(calls[0]!.args[0]).toBe('-c');
    expect(calls[0]!.args.slice(2)).toEqual(['a.py', 'dir/b.py']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero interpreter result', () => {
    const spawn = () => ({ status: 1, stdout: '', stderr: '  File "bad.py", line 2\nSyntaxError: invalid syntax', error: undefined, signal: null });
    expect(runPythonSyntaxCheck('/repo', ['bad.py'], spawn as never)).toBe(false);
  });

  it('returns false when the interpreter cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runPythonSyntaxCheck('/repo', ['a.py'], spawn as never)).toBe(false);
  });

  it('compiles a real valid file and rejects a real syntax error when python3 exists', () => {
    if (!pythonPreflight().ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-python-'));
    try {
      writeFileSync(join(root, 'ok.py'), 'def f():\n    return 1\n');
      writeFileSync(join(root, 'bad.py'), 'def f(:\n    pass\n');
      expect(runPythonSyntaxCheck(root, ['ok.py'])).toBe(true);
      expect(runPythonSyntaxCheck(root, ['bad.py'])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
