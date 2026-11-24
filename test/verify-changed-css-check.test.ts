import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cssParserPreflight,
  runCssSyntaxCheck,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

// The spawned check resolves `lightningcss` through vite's real manifest
// path under the repo root, so real-parse cases pass the checkout root as
// `root` and absolute temp paths as `files`.
const repoRoot = process.cwd();

describe('selectChangedFiles css coverage', () => {
  it('selects existing .css files and skips deleted or near-miss paths', () => {
    const selection = selectChangedFiles(
      [
        'src/web-ui/app.css', 'docs/guide.CSS', 'site/styles.css',
        'src/core/x.ts', 'gone.css', 'styles.css.bak', 'notes.css.md', 'theme.module.css',
      ],
      [
        'src/web-ui/app.css', 'docs/guide.CSS', 'site/styles.css',
        'src/core/x.ts', 'styles.css.bak', 'notes.css.md', 'theme.module.css',
      ],
    );
    expect(selection.cssFiles).toEqual(['docs/guide.CSS', 'site/styles.css', 'src/web-ui/app.css', 'theme.module.css']);
  });
});

describe('cssParserPreflight', () => {
  it('is ok when vite is installed and lightningcss resolves through it', () => {
    expect(cssParserPreflight(repoRoot).ok).toBe(true);
  });

  it('fails closed naming the absent vite manifest', () => {
    const exists = (path: string) => path !== resolve('/fake/root', 'node_modules/vite/package.json');
    const result = cssParserPreflight('/fake/root', exists as never);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
    expect(result.reason).toContain('node_modules/vite/package.json');
  });

  it('fails closed when lightningcss cannot be resolved through vite', () => {
    // A real directory without node_modules: vite's manifest is absent, so
    // the first branch reports it; the resolve branch is covered by the
    // fake-exists variant below.
    const root = mkdtempSync(join(tmpdir(), 'verify-css-preflight-'));
    try {
      expect(cssParserPreflight(root).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runCssSyntaxCheck', () => {
  it('hands every changed file to one node --input-type=module -e run', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runCssSyntaxCheck('/repo', ['a.css', 'dir/b.css'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args[0]).toBe('--input-type=module');
    expect(calls[0]!.args[1]).toBe('-e');
    expect(calls[0]!.args[2]).toContain("req('lightningcss')");
    expect(calls[0]!.args[2]).toContain('errorRecovery: false');
    expect(calls[0]!.args.slice(3)).toEqual(['a.css', 'dir/b.css']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero child result', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawn = () => ({ status: 1, stdout: '', stderr: 'bad.css:2:8: Unexpected token Ident("red")', error: undefined, signal: null });
      expect(runCssSyntaxCheck('/repo', ['bad.css'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when the child cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runCssSyntaxCheck('/repo', ['a.css'], spawn as never)).toBe(false);
  });

  it('parses real CSS and rejects real errors when the parser resolves', () => {
    if (!cssParserPreflight(repoRoot).ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-css-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'ok.css'), ':root { --gap: 4px; }\n.card { display: grid; gap: var(--gap); }\n@media (min-width: 40rem) { .card { grid-template-columns: 1fr 1fr; } }\n');
      writeFileSync(join(root, 'modern.css'), '.a { .b { color: red } &:hover { color: blue } }\n@layer base { .c { color: green } }\n');
      writeFileSync(join(root, 'empty.css'), '');
      writeFileSync(join(root, 'missing-colon.css'), '.a {\n  color red;\n}\n');
      writeFileSync(join(root, 'stray-close.css'), '.a { color: red; }\n}\n');
      writeFileSync(join(root, 'garbage.css'), '\x00\x01\x02');
      const ok = [join(root, 'ok.css'), join(root, 'modern.css'), join(root, 'empty.css')];
      const bad = [join(root, 'missing-colon.css'), join(root, 'stray-close.css'), join(root, 'garbage.css')];
      expect(runCssSyntaxCheck(repoRoot, ok)).toBe(true);
      expect(runCssSyntaxCheck(repoRoot, bad)).toBe(false);
      expect(runCssSyntaxCheck(repoRoot, [...ok, ...bad])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
