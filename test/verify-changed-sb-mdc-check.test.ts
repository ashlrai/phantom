import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parserPackagePreflight,
  runMdcSyntaxCheck,
  runSeatbeltSyntaxCheck,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

// The spawned mdc check resolves `yaml` as a bare specifier against the repo
// root, so real-parse cases pass the checkout root as `root` and absolute
// temp paths as `files` — the same convention as the yaml/toml check tests.
const repoRoot = process.cwd();

describe('selectChangedFiles seatbelt and mdc coverage', () => {
  it('selects existing .sb and .mdc files and skips deleted or near-miss paths', () => {
    const selection = selectChangedFiles(
      [
        'contrib/mac/sandbox/sb17-block.sb', 'contrib/mac/host-integration/agent.SB',
        '.cursor/rules/agents.mdc', 'src/core/x.ts', 'gone.sb', 'gone.mdc',
        'profile.sbar', 'notes.sb.md', 'rules.mdc.bak', 'plain.md',
      ],
      [
        'contrib/mac/sandbox/sb17-block.sb', 'contrib/mac/host-integration/agent.SB',
        '.cursor/rules/agents.mdc', 'src/core/x.ts', 'profile.sbar', 'notes.sb.md',
        'rules.mdc.bak', 'plain.md',
      ],
    );
    expect(selection.seatbeltFiles).toEqual([
      'contrib/mac/host-integration/agent.SB',
      'contrib/mac/sandbox/sb17-block.sb',
    ]);
    expect(selection.mdcFiles).toEqual(['.cursor/rules/agents.mdc']);
  });
});

describe('runSeatbeltSyntaxCheck', () => {
  it('parses real SBPL — filters, regex literals, define/param forms and comments', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-sb-'));
    try {
      writeFileSync(join(root, 'ok.sb'), [
        '(version 1)',
        '(allow default)',
        '; a comment with (parens) and "quotes"',
        '(deny file-write*',
        '  (subpath "/Users/x/Projects") (literal "/Users/x/.netrc")',
        '  (regex #"^/Users/x/[^/]+\\.git(/|$)")',
        '  (require-all (subpath "/a") (regex #"b$c")))',
        '(define (wp n) (or (param n) "/private/var/empty/x"))',
        '(allow file-read* file-write* (subpath (wp "WEYV_GIT_WT")) (literal (string-append (wp "WEYV_GIT_WT") "/config")))',
        '(with partial-symbolication',
        '  (allow file-read* (subpath "/usr/lib")))',
        '()',
        '',
      ].join('\n'));
      writeFileSync(join(root, 'empty.sb'), '');
      writeFileSync(join(root, 'comments.sb'), '; nothing but comments\n;; and more\n');
      expect(runSeatbeltSyntaxCheck(root, ['ok.sb', 'empty.sb', 'comments.sb'])).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses every committed .sb profile without a false positive', () => {
    const profiles = [
      'contrib/mac/host-integration/agy.sb',
      'contrib/mac/host-integration/zai.sb',
      'contrib/mac/host-integration/agent.sb',
      'contrib/mac/sandbox/sb17-block.sb',
    ];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(runSeatbeltSyntaxCheck(repoRoot, profiles)).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  it('rejects unbalanced parens, unterminated literals and non-list top forms', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-sb-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'open.sb'), '(version 1)\n(allow file-read* (subpath "/x"\n');
      writeFileSync(join(root, 'str.sb'), '(deny file-read* (literal "/unterminated)\n');
      writeFileSync(join(root, 're.sb'), '(deny file-write* (regex #"/unterminated)\n');
      writeFileSync(join(root, 'atom.sb'), 'version 1\n');
      writeFileSync(join(root, 'close.sb'), '(version 1))\n');
      writeFileSync(join(root, 'head.sb'), '((nested) arg)\n');
      writeFileSync(join(root, 'ok.sb'), '(version 1)\n(allow default)\n');
      expect(runSeatbeltSyntaxCheck(root, ['open.sb'])).toBe(false);
      expect(runSeatbeltSyntaxCheck(root, ['str.sb'])).toBe(false);
      expect(runSeatbeltSyntaxCheck(root, ['re.sb'])).toBe(false);
      expect(runSeatbeltSyntaxCheck(root, ['atom.sb'])).toBe(false);
      expect(runSeatbeltSyntaxCheck(root, ['close.sb'])).toBe(false);
      expect(runSeatbeltSyntaxCheck(root, ['head.sb'])).toBe(false);
      expect(runSeatbeltSyntaxCheck(root, ['ok.sb'])).toBe(true);
      expect(runSeatbeltSyntaxCheck(root, ['ok.sb', 'open.sb'])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the failing file with its line and column', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-sb-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'one.sb'), '(version 1)\n(allow default)\n(deny (literal "/x"\n');
      writeFileSync(join(root, 'two.sb'), '(version 1)\n(bad\n');
      expect(runSeatbeltSyntaxCheck(root, ['one.sb', 'two.sb'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.includes('one.sb:3:'))).toBe(true);
      expect(reported.some((line) => line.includes('two.sb:2:'))).toBe(true);
      expect(reported.every((line) => line.startsWith('FAIL seatbelt syntax check: '))).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when a file cannot be read and passes an empty list', () => {
    const read = () => {
      throw new Error('EACCES: permission denied');
    };
    expect(runSeatbeltSyntaxCheck('/repo', ['locked.sb'], read as never)).toBe(false);
    expect(runSeatbeltSyntaxCheck('/repo', [], read as never)).toBe(true);
  });
});

describe('runMdcSyntaxCheck', () => {
  it('hands every changed file to one node --input-type=module -e run', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runMdcSyntaxCheck('/repo', ['a.mdc', 'dir/b.mdc'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args[0]).toBe('--input-type=module');
    expect(calls[0]!.args[1]).toBe('-e');
    expect(calls[0]!.args[2]).toContain("from 'yaml'");
    expect(calls[0]!.args.slice(3)).toEqual(['a.mdc', 'dir/b.mdc']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero child result', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawn = () => ({ status: 1, stdout: '', stderr: 'bad.mdc: bad indent', error: undefined, signal: null });
      expect(runMdcSyntaxCheck('/repo', ['bad.mdc'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when the child cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runMdcSyntaxCheck('/repo', ['a.mdc'], spawn as never)).toBe(false);
  });

  it('parses frontmatter, accepts plain markdown and rejects real errors when the package exists', () => {
    if (!parserPackagePreflight(repoRoot, 'yaml').ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-mdc-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'plain.mdc'), '# Rules\n\nJust markdown, no fence.\n');
      writeFileSync(join(root, 'ok.mdc'), '---\ndescription: Agent rules\nglobs: src/**\nalwaysApply: true\n---\n# Body\n');
      writeFileSync(join(root, 'dots.mdc'), '---\ndescription: x\n...\n# Body\n');
      writeFileSync(join(root, 'empty.mdc'), '---\n---\n# Body\n');
      writeFileSync(join(root, 'crlf.mdc'), '---\r\ndescription: x\r\n---\r\n# Body\r\n');
      writeFileSync(join(root, 'bom.mdc'), '﻿---\ndescription: x\n---\n# Body\n');
      writeFileSync(join(root, 'open.mdc'), '---\ndescription: x\n# Body\n');
      writeFileSync(join(root, 'bad.mdc'), '---\ndescription: [unclosed\n---\n# Body\n');
      const ok = ['plain.mdc', 'ok.mdc', 'dots.mdc', 'empty.mdc', 'crlf.mdc', 'bom.mdc']
        .map((name) => join(root, name));
      const bad = ['open.mdc', 'bad.mdc'].map((name) => join(root, name));
      expect(runMdcSyntaxCheck(repoRoot, ok)).toBe(true);
      expect(runMdcSyntaxCheck(repoRoot, bad)).toBe(false);
      expect(runMdcSyntaxCheck(repoRoot, [...ok, ...bad])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
