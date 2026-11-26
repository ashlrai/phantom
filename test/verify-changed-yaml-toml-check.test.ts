import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parserPackagePreflight,
  runTomlSyntaxCheck,
  runYamlSyntaxCheck,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

// The spawned checks resolve `yaml`/`smol-toml` as bare specifiers against
// the repo root, so real-parse cases pass the checkout root as `root` and
// absolute temp paths as `files`.
const repoRoot = process.cwd();

describe('selectChangedFiles yaml and toml coverage', () => {
  it('selects existing .yml, .yaml, .cff and .toml files and skips deleted or near-miss paths', () => {
    const selection = selectChangedFiles(
      [
        '.github/workflows/ci.yml', 'pnpm-workspace.yaml', 'agent-network.toml',
        'CITATION.cff', 'docs/citation.cff', 'gone.cff', 'notes.cff.txt',
        'src/core/x.ts', 'gone.yaml', 'config.yml.bak', 'notes.yml.md', 'Cargo.toml',
      ],
      [
        '.github/workflows/ci.yml', 'pnpm-workspace.yaml', 'agent-network.toml',
        'CITATION.cff', 'docs/citation.cff', 'notes.cff.txt',
        'src/core/x.ts', 'config.yml.bak', 'notes.yml.md', 'Cargo.toml',
      ],
    );
    expect(selection.yamlFiles).toEqual([
      '.github/workflows/ci.yml', 'CITATION.cff', 'docs/citation.cff', 'pnpm-workspace.yaml',
    ]);
    expect(selection.tomlFiles).toEqual(['Cargo.toml', 'agent-network.toml']);
  });

  it('selects Cargo.lock at any depth for the toml check and skips near-miss names', () => {
    const selection = selectChangedFiles(
      [
        'Cargo.lock', 'desktop/src-tauri/Cargo.lock', 'deep/nested/Cargo.lock',
        'Cargo.lock.bak', 'my-Cargo.lock', 'cargo.lock', 'gone/Cargo.lock',
      ],
      [
        'Cargo.lock', 'desktop/src-tauri/Cargo.lock', 'deep/nested/Cargo.lock',
        'Cargo.lock.bak', 'my-Cargo.lock', 'cargo.lock',
      ],
    );
    expect(selection.tomlFiles).toEqual([
      'Cargo.lock', 'deep/nested/Cargo.lock', 'desktop/src-tauri/Cargo.lock',
    ]);
  });
});

describe('parserPackagePreflight', () => {
  it('is ok when the package manifest exists under node_modules', () => {
    const exists = (path: string) => path === resolve('/fake/root', 'node_modules/yaml/package.json');
    expect(parserPackagePreflight('/fake/root', 'yaml', exists as never).ok).toBe(true);
  });

  it('fails closed naming the absent package manifest', () => {
    const result = parserPackagePreflight('/fake/root', 'smol-toml', (() => false) as never);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
    expect(result.reason).toContain('node_modules/smol-toml/package.json');
  });
});

describe('runYamlSyntaxCheck', () => {
  it('hands every changed file to one node --input-type=module -e run', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runYamlSyntaxCheck('/repo', ['a.yml', 'dir/b.yaml'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args[0]).toBe('--input-type=module');
    expect(calls[0]!.args[1]).toBe('-e');
    expect(calls[0]!.args[2]).toContain("from 'yaml'");
    expect(calls[0]!.args.slice(3)).toEqual(['a.yml', 'dir/b.yaml']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero child result', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawn = () => ({ status: 1, stdout: '', stderr: 'bad.yml: bad indent at line 3, column 1:', error: undefined, signal: null });
      expect(runYamlSyntaxCheck('/repo', ['bad.yml'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when the child cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runYamlSyntaxCheck('/repo', ['a.yml'], spawn as never)).toBe(false);
  });

  it('parses real YAML, accepts multi-document files and rejects real errors when the package exists', () => {
    if (!parserPackagePreflight(repoRoot, 'yaml').ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-yaml-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'ok.yml'), 'name: CI\non:\n  push:\n    branches: [master]\njobs: {}\n');
      writeFileSync(join(root, 'multi.yaml'), 'a: 1\n---\nb: 2\n');
      writeFileSync(join(root, 'dup.yaml'), 'a: 1\na: 2\n');
      writeFileSync(join(root, 'tab.yaml'), 'a:\n\tb: 1\n');
      writeFileSync(join(root, 'multi-bad.yaml'), 'a: 1\n---\nb: [2,\n');
      const ok = [join(root, 'ok.yml'), join(root, 'multi.yaml')];
      const bad = [join(root, 'dup.yaml'), join(root, 'tab.yaml'), join(root, 'multi-bad.yaml')];
      expect(runYamlSyntaxCheck(repoRoot, ok)).toBe(true);
      expect(runYamlSyntaxCheck(repoRoot, bad)).toBe(false);
      expect(runYamlSyntaxCheck(repoRoot, [...ok, ...bad])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses the committed CITATION.cff manifest when the package exists', () => {
    if (!parserPackagePreflight(repoRoot, 'yaml').ok) return;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(runYamlSyntaxCheck(repoRoot, [join(repoRoot, 'CITATION.cff')])).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('runTomlSyntaxCheck', () => {
  it('hands every changed file to one node --input-type=module -e run', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runTomlSyntaxCheck('/repo', ['a.toml', 'dir/b.toml'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args[0]).toBe('--input-type=module');
    expect(calls[0]!.args[1]).toBe('-e');
    expect(calls[0]!.args[2]).toContain("from 'smol-toml'");
    expect(calls[0]!.args.slice(3)).toEqual(['a.toml', 'dir/b.toml']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero child result', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawn = () => ({ status: 1, stdout: '', stderr: 'bad.toml: Invalid TOML document: expected comma or end of structure', error: undefined, signal: null });
      expect(runTomlSyntaxCheck('/repo', ['bad.toml'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when the child cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runTomlSyntaxCheck('/repo', ['a.toml'], spawn as never)).toBe(false);
  });

  it('parses real TOML and rejects real errors when the package exists', () => {
    if (!parserPackagePreflight(repoRoot, 'smol-toml').ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-toml-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'ok.toml'), '[package]\nname = "x"\nversion = "1.0.0"\nkeywords = ["a", "b"]\nwhen = 1979-05-27T07:32:00Z\n');
      writeFileSync(join(root, 'empty.toml'), '# only a comment\n');
      writeFileSync(join(root, 'dup.toml'), 'a = 1\na = 2\n');
      writeFileSync(join(root, 'bad.toml'), 'a = [1, 2\n');
      expect(runTomlSyntaxCheck(repoRoot, [join(root, 'ok.toml'), join(root, 'empty.toml')])).toBe(true);
      expect(runTomlSyntaxCheck(repoRoot, [join(root, 'dup.toml')])).toBe(false);
      expect(runTomlSyntaxCheck(repoRoot, [join(root, 'bad.toml')])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses the committed Cargo.lock manifest when the package exists', () => {
    if (!parserPackagePreflight(repoRoot, 'smol-toml').ok) return;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(runTomlSyntaxCheck(repoRoot, [join(repoRoot, 'desktop/src-tauri/Cargo.lock')])).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});
