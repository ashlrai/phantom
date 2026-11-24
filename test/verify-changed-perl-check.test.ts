import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { perlPreflight, runPerlSyntaxCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles perl coverage', () => {
  it('selects existing .pl files and skips deleted or non-perl paths', () => {
    const selection = selectChangedFiles(
      ['.github/tests/secret-shape/scrub.pl', 'tools/helper.PL', 'src/core/x.ts', 'gone.pl', 'README.md'],
      ['.github/tests/secret-shape/scrub.pl', 'tools/helper.PL', 'src/core/x.ts', 'README.md'],
    );
    expect(selection.perlFiles).toEqual(['.github/tests/secret-shape/scrub.pl', 'tools/helper.PL']);
  });
});

describe('perlPreflight', () => {
  it('is ok when perl --version exits 0', () => {
    const spawn = () => ({ status: 0, stdout: '', stderr: 'This is perl 5', error: undefined, signal: null });
    expect(perlPreflight(spawn as never).ok).toBe(true);
  });

  it('fails closed when perl errors, is killed, or exits non-zero', () => {
    for (const result of [
      { status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null },
      { status: null, stdout: '', stderr: '', error: undefined, signal: 'SIGTERM' },
      { status: 1, stdout: '', stderr: 'no perl', error: undefined, signal: null },
    ]) {
      const spawn = () => result;
      const preflight = perlPreflight(spawn as never);
      expect(preflight.ok).toBe(false);
      expect(preflight).toHaveProperty('reason');
    }
  });
});

describe('runPerlSyntaxCheck', () => {
  it('spawns perl -c once per file under the repo root with ./ prefixes', () => {
    const calls: { cmd: string; args: string[]; opts: { cwd: string } }[] = [];
    const spawn = (cmd: string, args: string[], opts: { cwd: string }) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runPerlSyntaxCheck('/repo', ['a.pl', 'dir/b.pl'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe('perl');
    expect(calls[0]!.args).toEqual(['-c', './a.pl']);
    expect(calls[1]!.args).toEqual(['-c', './dir/b.pl']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false on the first non-zero result and names the file', () => {
    const calls: string[] = [];
    const spawn = (_cmd: string, args: string[]) => {
      calls.push(args[1]!);
      return { status: calls.length === 1 ? 0 : 255, stdout: '', stderr: 'syntax error', error: undefined, signal: null };
    };
    expect(runPerlSyntaxCheck('/repo', ['good.pl', 'bad.pl', 'never.pl'], spawn as never)).toBe(false);
    expect(calls).toEqual(['./good.pl', './bad.pl']);
  });

  it('returns false when the interpreter cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runPerlSyntaxCheck('/repo', ['a.pl'], spawn as never)).toBe(false);
  });

  it('parses a real valid script and rejects a real syntax error when perl exists', () => {
    if (!perlPreflight().ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-perl-'));
    try {
      writeFileSync(join(root, 'ok.pl'), "#!/usr/bin/perl\nuse strict;\nmy $answer = 42;\nprint qq{$answer\\n};\n");
      writeFileSync(join(root, 'bad.pl'), "#!/usr/bin/perl\nuse strict;\nmy $answer = ;\n");
      expect(runPerlSyntaxCheck(root, ['ok.pl'])).toBe(true);
      expect(runPerlSyntaxCheck(root, ['bad.pl'])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
