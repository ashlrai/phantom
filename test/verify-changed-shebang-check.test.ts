import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFirstLine, runNodeSyntaxCheck, selectShebangScripts, shebangInterpreter } from '../scripts/verify-changed.mjs';

describe('shebangInterpreter', () => {
  it('classifies python, node and POSIX shell interpreters', () => {
    const cases: [string, string | null][] = [
      ['#!/usr/bin/env python3', 'python'],
      ['#!/usr/bin/python3', 'python'],
      ['#!/usr/bin/env python3.12', 'python'],
      ['#!/usr/bin/env node', 'node'],
      ['#!/usr/bin/env nodejs', 'node'],
      ['#!/bin/sh', 'shell'],
      ['#!/bin/bash', 'shell'],
      ['#!/usr/bin/env bash', 'shell'],
      ['#!/usr/bin/env dash', 'shell'],
      ['#!/usr/bin/env -S node --no-warnings', 'node'],
      ['#!/usr/bin/env -S bash -e', 'shell'],
      ['#!/usr/bin/env FOO=bar python3', 'python'],
      ['#!/usr/bin/perl', 'perl'],
      ['#!/usr/bin/env perl', 'perl'],
      ['#!/usr/bin/perl5.34', 'perl'],
      ['#!/usr/bin/env -S perl -w', 'perl'],
    ];
    for (const [line, kind] of cases) expect(shebangInterpreter(line), line).toBe(kind);
  });

  it('returns null for non-shebangs and interpreters without a grammar step', () => {
    for (const line of [
      '',
      '# comment',
      '#!/usr/bin/env zsh',
      '#!/usr/bin/env ksh',
      '#!/usr/bin/env fish',
      '#!/usr/bin/env bats',
      '#!/usr/bin/env python3-config',
      '#!',
    ]) {
      expect(shebangInterpreter(line), line).toBeNull();
    }
    expect(shebangInterpreter(undefined)).toBeNull();
    expect(shebangInterpreter(42)).toBeNull();
  });
});

describe('selectShebangScripts', () => {
  const lines: Record<string, string> = {
    'bin/tool': '#!/usr/bin/env node\n',
    'contrib/mac/metrics-outcomes': '#!/usr/bin/env python3\n',
    'contrib/router/ashlr-router': '#!/usr/bin/env bash\n',
    'scripts/changelog-sync': '#!/bin/sh\n',
    'scripts/scrub-fixtures': '#!/usr/bin/env perl\n',
    'LICENSE': 'MIT License\n',
    'checksums/SHA256SUMS': 'deadbeef  file\n',
  };

  it('buckets extensionless shebang files and skips everything else', () => {
    const selection = selectShebangScripts(
      ['bin/tool', 'contrib/mac/metrics-outcomes', 'contrib/router/ashlr-router', 'scripts/changelog-sync', 'scripts/scrub-fixtures', 'LICENSE', 'checksums/SHA256SUMS', 'docs/guide.md', 'gone', 'src/core/x.ts'],
      ['bin/tool', 'contrib/mac/metrics-outcomes', 'contrib/router/ashlr-router', 'scripts/changelog-sync', 'scripts/scrub-fixtures', 'LICENSE', 'checksums/SHA256SUMS', 'docs/guide.md', 'src/core/x.ts'],
      (path) => lines[path] ?? '',
    );
    expect(selection.node).toEqual(['bin/tool']);
    expect(selection.python).toEqual(['contrib/mac/metrics-outcomes']);
    expect(selection.shell).toEqual(['contrib/router/ashlr-router', 'scripts/changelog-sync']);
    expect(selection.perl).toEqual(['scripts/scrub-fixtures']);
  });

  it('skips dotted basenames even when their first line is a shebang', () => {
    const selection = selectShebangScripts(
      ['script.sh', 'tool.py', 'run.command', '.envrc'],
      ['script.sh', 'tool.py', 'run.command', '.envrc'],
      () => '#!/usr/bin/env python3\n',
    );
    expect(selection).toEqual({ python: [], shell: [], node: [], perl: [] });
  });

  it('classifies an unreadable first line to nothing', () => {
    const selection = selectShebangScripts(
      ['bin/tool'],
      ['bin/tool'],
      () => { throw new Error('EACCES'); },
    );
    expect(selection).toEqual({ python: [], shell: [], node: [], perl: [] });
  });
});

describe('readFirstLine', () => {
  it('returns only the first line of a real file', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-shebang-'));
    try {
      writeFileSync(join(root, 'tool'), '#!/usr/bin/env node\nconst x = 1;\n');
      expect(readFirstLine(root, 'tool')).toBe('#!/usr/bin/env node');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runNodeSyntaxCheck', () => {
  it('spawns node --check once per file under the repo root', () => {
    const calls: { cmd: string; args: string[]; opts: { cwd: string } }[] = [];
    const spawn = (cmd: string, args: string[], opts: { cwd: string }) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runNodeSyntaxCheck('/repo', ['bin/a', 'tools/b'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(['--check', 'bin/a']);
    expect(calls[1]!.args).toEqual(['--check', 'tools/b']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false on the first non-zero result and names the file', () => {
    const calls: string[] = [];
    const spawn = (_cmd: string, args: string[]) => {
      calls.push(args[1]!);
      return { status: calls.length === 1 ? 0 : 1, stdout: '', stderr: 'SyntaxError: bad', error: undefined, signal: null };
    };
    expect(runNodeSyntaxCheck('/repo', ['bin/good', 'bin/bad', 'bin/never'], spawn as never)).toBe(false);
    expect(calls).toEqual(['bin/good', 'bin/bad']);
  });

  it('returns false when the interpreter cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runNodeSyntaxCheck('/repo', ['bin/a'], spawn as never)).toBe(false);
  });

  it('parses a real valid file and rejects a real syntax error', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-node-'));
    try {
      writeFileSync(join(root, 'ok'), '#!/usr/bin/env node\nconst answer = 42;\nconsole.log(answer);\n');
      writeFileSync(join(root, 'bad'), '#!/usr/bin/env node\nconst = ;\n');
      expect(runNodeSyntaxCheck(root, ['ok'])).toBe(true);
      expect(runNodeSyntaxCheck(root, ['bad'])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
