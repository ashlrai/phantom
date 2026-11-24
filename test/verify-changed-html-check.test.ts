import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cssParserPreflight,
  htmlPayloadPreflight,
  runHtmlPayloadCheck,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

// The spawned check resolves `jsdom` as a bare specifier and `lightningcss`
// through vite's real manifest path under the repo root, so real-parse cases
// pass the checkout root as `root` and absolute temp paths as `files`.
const repoRoot = process.cwd();

describe('selectChangedFiles html coverage', () => {
  it('selects existing .html/.htm files outside test/fixtures and skips near misses', () => {
    const selection = selectChangedFiles(
      [
        'site/index.html', 'docs/page.htm', 'test/fixtures/browser/injection.html',
        'src/core/x.ts', 'gone.html', 'notes.html.md', 'site/index.html.bak',
      ],
      [
        'site/index.html', 'docs/page.htm', 'test/fixtures/browser/injection.html',
        'src/core/x.ts', 'notes.html.md', 'site/index.html.bak',
      ],
    );
    expect(selection.htmlFiles).toEqual(['docs/page.htm', 'site/index.html']);
  });
});

describe('htmlPayloadPreflight', () => {
  it('is ok when jsdom is installed', () => {
    expect(htmlPayloadPreflight(repoRoot).ok).toBe(true);
  });

  it('fails closed naming the absent jsdom manifest', () => {
    const exists = (path: string) => path !== resolve('/fake/root', 'node_modules/jsdom/package.json');
    const result = htmlPayloadPreflight('/fake/root', exists as never);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
    expect(result.reason).toContain('node_modules/jsdom/package.json');
  });
});

describe('runHtmlPayloadCheck', () => {
  it('hands every changed file to one node run with module parsing enabled', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runHtmlPayloadCheck('/repo', ['site/index.html', 'docs/page.htm'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args.slice(0, 4)).toEqual(['--no-warnings', '--experimental-vm-modules', '--input-type=module', '-e']);
    expect(calls[0]!.args[4]).toContain("from 'jsdom'");
    expect(calls[0]!.args[4]).toContain('SourceTextModule');
    expect(calls[0]!.args.slice(5)).toEqual(['site/index.html', 'docs/page.htm']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero child result', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawn = () => ({ status: 1, stdout: '', stderr: 'site/index.html script block 1 line 3: Unexpected token', error: undefined, signal: null });
      expect(runHtmlPayloadCheck('/repo', ['site/index.html'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when the child cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runHtmlPayloadCheck('/repo', ['site/index.html'], spawn as never)).toBe(false);
  });

  it('parses real payloads and rejects real errors when jsdom exists', () => {
    if (!htmlPayloadPreflight(repoRoot).ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-html-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'ok.html'), [
        '<!doctype html><html><head>',
        '<script type="application/ld+json">{"@context":"https://schema.org","name":"x"}</script>',
        '<style>.a { color: red; } @media (min-width: 1px) { .b { display: grid; } }</style>',
        '</head><body>',
        '<script>const x = 1; function f() { return x + 1; }</script>',
        '<script type="module">import { x } from \'./m.js\'; export const y = x + 1;</script>',
        '<script type="text/plain">this is { not json }</script>',
        '<script type="application/json">{"ok": true}</script>',
        '<script src="/app.js"></script>',
        '<script></script>',
        '<noscript><script>let broken = ;</script></noscript>',
        '<template><script>let t = 1;</script><style>.t { color: blue; }</style></template>',
        '</body></html>',
      ].join('\n'));
      writeFileSync(join(root, 'bad-script.html'), '<html><body><script>let x = ;</script></body></html>');
      writeFileSync(join(root, 'bad-module.html'), '<html><body><script type="module">export const y = ;</script></body></html>');
      writeFileSync(join(root, 'bad-json.html'), '<html><body><script type="application/ld+json">{"a": }</script></body></html>');
      writeFileSync(join(root, 'bad-template.html'), '<html><body><template><script>let t = ;</script></template></body></html>');
      const ok = [join(root, 'ok.html')];
      const bad = ['bad-script.html', 'bad-module.html', 'bad-json.html', 'bad-template.html'].map((f) => join(root, f));
      expect(runHtmlPayloadCheck(repoRoot, ok)).toBe(true);
      expect(runHtmlPayloadCheck(repoRoot, bad)).toBe(false);
      expect(runHtmlPayloadCheck(repoRoot, [...ok, ...bad])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.includes('bad-script.html script block 1 line 1'))).toBe(true);
      expect(reported.some((line) => line.includes('bad-module.html module script block 1'))).toBe(true);
      expect(reported.some((line) => line.includes('bad-json.html json block 1'))).toBe(true);
      expect(reported.some((line) => line.includes('bad-template.html script block 1'))).toBe(true);
      // A style payload is only a failure when lightningcss resolves; the
      // child warn-skips it otherwise, matching the .css check's SKIP path.
      if (cssParserPreflight(repoRoot).ok) {
        writeFileSync(join(root, 'bad-style.html'), '<html><body><style>.a { color red; }</style></body></html>');
        expect(runHtmlPayloadCheck(repoRoot, [join(root, 'bad-style.html')])).toBe(false);
      }
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
