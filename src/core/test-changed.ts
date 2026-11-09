import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export interface TestSelection { base: string; changed: string[]; tests: string[]; mode: 'related' | 'full'; reason: string }
const moduleFile = /\.[cm]?[jt]sx?$/;
const testFile = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Select only when every changed file has a known path to a test. */
export function selectChangedTests(root: string, base = 'HEAD'): TestSelection {
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Cannot read changes from git; check the base ref');
    return result.stdout.split('\0').filter(Boolean);
  };
  const changed = [...new Set([...git('diff', '--name-only', '-z', base, '--'), ...git('ls-files', '--others', '--exclude-standard', '-z')])].sort();
  const files = [...new Set([...git('ls-files', '-z'), ...git('ls-files', '--others', '--exclude-standard', '-z')])];
  const fileSet = new Set(files);
  const tests = files.filter((f) => testFile.test(f) && existsSync(resolve(root, f))).sort();
  const full = (reason: string): TestSelection => ({ base, changed, tests, mode: 'full', reason });
  if (!changed.length) return { base, changed, tests: [], mode: 'related', reason: 'No changed files.' };
  if (!tests.length) return full('No test files were discovered.');
  const reverse = new Map<string, Set<string>>();
  for (const file of files.filter((f) => moduleFile.test(f) && existsSync(resolve(root, f)))) {
    const text = readFileSync(resolve(root, file), 'utf8');
    // Relative literal imports and re-exports are the only supported dependency edges.
    const imports = text.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['"](\.[^'"]+)['"]/g);
    for (const match of imports) {
      const target = resolve(root, dirname(file), match[1]!);
      const stem = /\.[cm]?js$/.test(target) ? target.replace(/\.[cm]?js$/, '') : target;
      const candidates = [target, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].map((ext) => stem + ext), ...['index.ts', 'index.tsx', 'index.js'].map((name) => resolve(target, name))];
      const found = candidates.find((candidate) => fileSet.has(relative(root, candidate)) && existsSync(candidate));
      if (found) {
        const key = relative(root, found);
        const dependents = reverse.get(key) ?? new Set<string>();
        dependents.add(file);
        reverse.set(key, dependents);
      }
    }
  }
  const selected = new Set<string>();
  for (const file of changed) {
    if (!moduleFile.test(file) || !existsSync(resolve(root, file))) return full(`Unknown mapping for ${file}.`);
    const visited = new Set([file]);
    const queue = [file];
    while (queue.length) {
      const current = queue.shift()!;
      if (testFile.test(current)) selected.add(current);
      for (const dependent of reverse.get(current) ?? []) if (!visited.has(dependent)) { visited.add(dependent); queue.push(dependent); }
    }
    if (![...visited].some((item) => tests.includes(item))) return full(`Unknown mapping for ${file}.`);
  }
  return { base, changed, tests: [...selected].sort(), mode: 'related', reason: 'Tests import every changed file directly or transitively.' };
}

/** Execute the repository's npm test script; JSON callers receive no child output. */
export function runChangedTests(root: string, base: string, quiet: boolean): TestSelection & { exitCode: number } {
  const selection = selectChangedTests(root, base);
  if (!selection.changed.length) return { ...selection, exitCode: 0 };
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  if (!pkg.scripts?.test) throw new Error('No npm test script is configured');
  // Only Vitest is known to accept file arguments with these semantics.
  if (selection.mode === 'related' && !/\bvitest\b/.test(pkg.scripts.test)) {
    selection.mode = 'full'; selection.reason = 'The test runner is not known to accept Vitest file filters.';
  }
  const args = ['test', ...(selection.mode === 'related' ? ['--', ...selection.tests] : [])];
  const result = spawnSync('npm', args, { cwd: root, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  return { ...selection, exitCode: result.status ?? 1 };
}
