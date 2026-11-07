import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deadCodeReport, reportJson } from '../scripts/dead-code-report.mjs';

const roots: string[] = [];
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'phantom-dead-code-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('dead-code report', () => {
  it('walks every package bin, public export, desktop and test entry through cycles and reexports', () => {
    const root = fixture({
      'package.json': JSON.stringify({ bin: { a: 'bin/a.mjs', b: 'bin/b.mjs' }, exports: { '.': { import: './dist/api.js' } } }),
      'bin/a.mjs': "import '../dist/a.js';",
      'bin/b.mjs': "import '../dist/b.js';",
      'src/a.ts': "export * from './shared.js';",
      'src/b.ts': '',
      'src/shared.ts': "import './a.js';",
      'src/api.ts': "export * from './library/index.js';",
      'src/library/index.ts': '',
      'desktop/main.ts': "import '../src/desktop.js';",
      'src/desktop.ts': '',
      'test/feature.test.ts': "import '../src/tested.js';",
      'src/tested.ts': '',
      'src/dead-a.ts': "import './dead-b.js';",
      'src/dead-b.ts': "import './dead-a.js';",
    });
    const report = deadCodeReport(root);
    expect(report.unreachable).toEqual(['src/dead-a.ts', 'src/dead-b.ts']);
    expect(report.testOnly).toEqual(['src/tested.ts']);
  });

  it('protects dynamic imports even in otherwise unreachable modules and reports computed loaders', () => {
    const report = deadCodeReport(fixture({
      'src/loader.ts': "import(('./lazy.js' as unknown as string)); import(userProvidedUrl); import(`./chunk-${name}.js`);",
      'src/lazy.ts': "export * from './lazy-dependency.js';",
      'src/lazy-dependency.ts': '',
      'src/chunk-one.ts': '',
      'test/lazy.test.ts': "import('../src/only-tested.js');",
      'src/only-tested.ts': '',
      'src/dead.ts': '',
    }));
    expect(report.unreachable).toEqual(['src/dead.ts']);
    expect(report.testOnly).toEqual(['src/only-tested.ts']);
    expect(report.diagnostics).toContainEqual({ path: 'src/loader.ts', reason: 'computed-loader' });
  });

  it('protects contracts, declarations, public assets, scripts, require and import types', () => {
    const report = deadCodeReport(fixture({
      'src/contracts/dormant.ts': "import '../contract-dependency.js';",
      'src/contract-dependency.ts': '',
      'src/types.d.ts': "import './declared.js';",
      'src/declared.ts': '',
      'src/web-ui/public/sw.js': '',
      'scripts/maintenance.mjs': "require('../src/required.cjs'); const path = 'dist/scripted.js';",
      'src/required.cts': '',
      'src/scripted.ts': '',
      'test/type.test.ts': "type T = import('../src/type-only.js').T;",
      'src/type-only.ts': '',
      'src/dead.ts': '',
    }));
    expect(report.unreachable).toEqual(['src/dead.ts']);
  });

  it('retains worker URLs, computed worker templates, glob discoveries and text-read dependencies', () => {
    const report = deadCodeReport(fixture({
      'desktop/main.ts': "new URL('../src/worker.js', import.meta.url); new URL(`../src/probe-${kind}.js`, import.meta.url);",
      'src/worker.ts': '',
      'src/probe-account.ts': '',
      'src/not-a-probe.ts': '',
      'src/web-ui/discovery.ts': "import.meta.glob(['./panes/*.tsx', './single/?.tsx', './brace/{One,Two}.tsx', './range/[AB].tsx']);",
      'src/web-ui/panes/Useful.tsx': '',
      'src/web-ui/single/A.tsx': '',
      'src/web-ui/brace/One.tsx': '',
      'src/web-ui/range/B.tsx': '',
      '.github/tests/read.test.mjs': "readFileSync('src/read-as-text.ts');",
      'src/read-as-text.ts': '',
      'test/read.test.ts': "readFileSync(new URL('../src/other.ts', import.meta.url));",
      'src/other.ts': '',
    }));
    expect(report.unreachable).toEqual(['src/not-a-probe.ts']);
  });

  it('roots HTML modules and independently packaged Raycast commands', () => {
    const report = deadCodeReport(fixture({
      'src/web-ui/index.html': '<script type="module" src="./main.tsx"></script>',
      'src/web-ui/main.tsx': "import './ui';",
      'src/web-ui/ui/index.ts': '',
      'src/raycast/package.json': JSON.stringify({ commands: [{ name: 'search' }] }),
      'src/raycast/src/search.tsx': '',
      'src/raycast/src/unused.ts': '',
    }));
    expect(report.unreachable).toEqual(['src/raycast/src/unused.ts']);
  });

  it('reports unresolved relative imports and malformed source without executing it', () => {
    const report = deadCodeReport(fixture({
      'test/broken.test.ts': "import '../src/missing.js';",
      'src/broken.ts': 'export const = ;',
      'src/throw.ts': "throw new Error('must never execute candidate code');",
    }));
    expect(report.diagnostics).toEqual([
      { path: 'src/broken.ts', reason: 'parse-error' },
      { path: 'test/broken.test.ts', reason: 'unresolved-relative-import', specifier: '../src/missing.js' },
    ]);
  });

  it('ignores generated trees and symlinks outside the checkout', () => {
    const root = fixture({ 'src/dead.ts': '', 'node_modules/pkg/index.ts': '', 'dist/generated.ts': '' });
    const outside = fixture({ 'external.ts': "throw new Error('do not follow');" });
    symlinkSync(outside, join(root, 'src', 'linked'), 'dir');
    expect(deadCodeReport(root).unreachable).toEqual(['src/dead.ts']);
  });

  it('formats deterministic CLI JSON for an explicit root without changing source files', () => {
    const root = fixture({ 'src/dead.ts': 'export const unused = true;' });
    const run = () => reportJson(['--root', root]);
    const output = run();
    expect(run()).toBe(output);
    expect(JSON.parse(output)).toMatchObject({ schema: 'phantom-dead-code-report/v1', advisoryOnly: true, unreachable: ['src/dead.ts'] });
    expect(readFileSync(join(root, 'src/dead.ts'), 'utf8')).toBe('export const unused = true;');
    expect(() => reportJson(['--unknown'])).toThrow('Usage:');
    expect(() => reportJson(['--root'])).toThrow('Usage:');
  });
});
