import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parserPackagePreflight,
  runDetachedScriptCheck,
  selectChangedFiles,
} from '../scripts/verify-changed.mjs';

// The spawned check resolves `typescript` as a bare specifier against the
// repo root, so real-parse cases pass the checkout root as `root` and
// absolute temp paths as `files`.
const repoRoot = process.cwd();

describe('selectChangedFiles detached script coverage', () => {
  it('selects script files under the independently-owned trees and skips near misses', () => {
    const selection = selectChangedFiles(
      [
        'src/raycast/src/pulse.tsx', 'src/raycast/src/util.ts', 'src/raycast/eslint.config.js',
        'src/raycast/src/types.d.mts', 'examples/universe-site/app/page.tsx',
        'examples/universe-site/scripts/generate-discovery.mjs', 'examples/universe-site/vite.config.ts',
        'src/raycast-other/x.ts', 'examples/universe-site-docs/x.ts', 'raycast/x.ts',
        'src/core/x.ts', 'workplans/helper.mjs', 'undefined/x.ts',
        'gone.tsx', 'src/raycast/gone.ts', 'examples/universe-site/gone.mjs',
      ],
      [
        'src/raycast/src/pulse.tsx', 'src/raycast/src/util.ts', 'src/raycast/eslint.config.js',
        'src/raycast/src/types.d.mts', 'examples/universe-site/app/page.tsx',
        'examples/universe-site/scripts/generate-discovery.mjs', 'examples/universe-site/vite.config.ts',
        'src/raycast-other/x.ts', 'examples/universe-site-docs/x.ts', 'raycast/x.ts',
        'src/core/x.ts', 'workplans/helper.mjs', 'undefined/x.ts',
      ],
    );
    expect(selection.detachedScriptFiles).toEqual([
      'examples/universe-site/app/page.tsx',
      'examples/universe-site/scripts/generate-discovery.mjs',
      'examples/universe-site/vite.config.ts',
      'src/raycast/eslint.config.js',
      'src/raycast/src/pulse.tsx',
      'src/raycast/src/types.d.mts',
      'src/raycast/src/util.ts',
    ]);
  });

  it('skips non-script files under the same trees', () => {
    const selection = selectChangedFiles(
      [
        'src/raycast/package.json', 'src/raycast/assets/icon.png', 'src/raycast/README.md',
        'src/raycast/styles/main.css', 'examples/universe-site/app/globals.css',
        'examples/universe-site/notes.ts.md', 'src/raycast/data.jsonl',
      ],
      [
        'src/raycast/package.json', 'src/raycast/assets/icon.png', 'src/raycast/README.md',
        'src/raycast/styles/main.css', 'examples/universe-site/app/globals.css',
        'examples/universe-site/notes.ts.md', 'src/raycast/data.jsonl',
      ],
    );
    expect(selection.detachedScriptFiles).toEqual([]);
  });
});

describe('runDetachedScriptCheck', () => {
  it('hands every changed file to one node --input-type=module -e run', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runDetachedScriptCheck('/repo', ['src/raycast/a.ts', 'examples/universe-site/b.tsx'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args[0]).toBe('--input-type=module');
    expect(calls[0]!.args[1]).toBe('-e');
    expect(calls[0]!.args[2]).toContain("from 'typescript'");
    expect(calls[0]!.args[2]).toContain('createSourceFile');
    expect(calls[0]!.args.slice(3)).toEqual(['src/raycast/a.ts', 'examples/universe-site/b.tsx']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero child result', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawn = () => ({ status: 1, stdout: '', stderr: 'src/raycast/bad.ts:1:15: Expression expected.', error: undefined, signal: null });
      expect(runDetachedScriptCheck('/repo', ['src/raycast/bad.ts'], spawn as never)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('returns false when the child cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runDetachedScriptCheck('/repo', ['src/raycast/a.ts'], spawn as never)).toBe(false);
  });

  it('parses real scripts across every detached extension and rejects real errors when typescript exists', () => {
    if (!parserPackagePreflight(repoRoot, 'typescript').ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-detached-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'ok.ts'), 'export const x: number = 1;\ninterface Y { a: string }\n');
      writeFileSync(join(root, 'ok.tsx'), 'export default function Page() { return <div className="x">hi</div>; }\n');
      writeFileSync(join(root, 'ok.mjs'), 'import { readFileSync } from \'node:fs\';\nexport const y = readFileSync;\n');
      writeFileSync(join(root, 'ok.d.ts'), 'declare const version: string;\nexport { version };\n');
      writeFileSync(join(root, 'ok.jsx'), 'export default () => <span>ok</span>;\n');
      writeFileSync(join(root, 'bad.ts'), 'const x: number = ;\n');
      writeFileSync(join(root, 'bad.tsx'), 'export default () => <div>{unclosed</div>\n');
      writeFileSync(join(root, 'bad.mjs'), 'import { a } from \'b\';\nconst x = ;\n');
      const ok = ['ok.ts', 'ok.tsx', 'ok.mjs', 'ok.d.ts', 'ok.jsx'].map((f) => join(root, f));
      const bad = ['bad.ts', 'bad.tsx', 'bad.mjs'].map((f) => join(root, f));
      expect(runDetachedScriptCheck(repoRoot, ok)).toBe(true);
      expect(runDetachedScriptCheck(repoRoot, bad)).toBe(false);
      expect(runDetachedScriptCheck(repoRoot, [...ok, ...bad])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.includes('bad.ts:1:'))).toBe(true);
      expect(reported.some((line) => line.includes('bad.mjs:2:'))).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
