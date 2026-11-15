import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runChangedTests, selectChangedTests } from '../src/core/test-changed.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'changed-tests-')); roots.push(root);
  const put = (name: string, text: string) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  put('package.json', JSON.stringify({ scripts: { test: 'node runner.cjs vitest' } }));
  put('runner.cjs', "require('node:fs').writeFileSync('ran', process.argv.slice(2).join(' '))");
  put('src/direct.ts', 'export const direct = 1;');
  put('src/indirect.ts', "export { direct } from './direct.js';");
  put('test/direct.test.ts', "import { direct } from '../src/direct.js';");
  put('test/indirect.test.ts', "import { direct } from '../src/indirect.js';");
  put('src/orphan.ts', 'export const orphan = 1;');
  git('add', '.'); git('commit', '-m', 'fixture');
  return { root, put };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('changed test selection', () => {
  it('finds direct and transitive imports against a base', () => {
    const { root, put } = fixture(); put('src/direct.ts', 'export const direct = 2;');
    expect(selectChangedTests(root)).toMatchObject({ mode: 'related', tests: ['test/direct.test.ts', 'test/indirect.test.ts'] });
  });
  it('passes selected files to a Vitest script', () => {
    const { root, put } = fixture();
    put('src/direct.ts', 'export const direct = 2;');
    const result = runChangedTests(root, 'HEAD', true);
    expect(result).toMatchObject({ mode: 'related', exitCode: 0 });
    expect(readFileSync(join(root, 'ran'), 'utf8')).toBe('vitest test/direct.test.ts test/indirect.test.ts');
  });
  it('falls back and runs the full script for an unknown mapping', () => {
    const { root, put } = fixture(); put('src/orphan.ts', 'export const orphan = 2;');
    expect(runChangedTests(root, 'HEAD', true)).toMatchObject({ mode: 'full', reason: 'Unknown mapping for src/orphan.ts.', exitCode: 0 });
  });
  it('fails for an invalid base', () => {
    const { root } = fixture(); expect(() => selectChangedTests(root, 'missing-ref')).toThrow('base ref');
  });
});
