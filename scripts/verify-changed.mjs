import { execFileSync, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pure selection: keep deleted paths for the web decision, but never lint them. */
export function selectChangedFiles(changedPaths, existingPaths) {
  const changed = [...new Set(changedPaths)].filter(Boolean).sort();
  const existing = new Set(existingPaths);
  return {
    lintFiles: changed.filter((path) => existing.has(path) && /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/.test(path)),
    webTypecheck: changed.some((path) => path.startsWith('src/web-ui/')),
  };
}

/** Include committed changes, index/worktree edits, deletions and untracked files. */
export function collectChangedPaths(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const base = git('merge-base', 'HEAD', 'origin/master').trim();
  // NUL delimiters preserve whitespace/newlines; disabling renames includes both sides.
  return [
    ...git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--').split('\0'),
    ...git('diff', '--cached', '--name-only', '--no-renames', '-z', '--').split('\0'),
    ...git('diff', '--name-only', '--no-renames', '-z', '--').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean);
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let selection;
  try {
    const changed = collectChangedPaths(root);
    const existing = changed.filter((path) => {
      try {
        return statSync(resolve(root, path)).isFile();
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      }
    });
    selection = selectChangedFiles(changed, existing);
    console.log('PASS file selection');
  } catch (error) {
    console.error(`FAIL file selection: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const run = (name, script, args = []) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
    const passed = !result.error && result.status === 0;
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
    if (result.error) console.error(result.error.message);
    if (!passed) process.exitCode = 1;
  };
  if (selection.lintFiles.length) {
    // ESLint applies its own config/ignores; explicit ignored paths are silent.
    run('eslint changed files', 'node_modules/eslint/bin/eslint.js', ['--no-warn-ignored', '--', ...selection.lintFiles.map((path) => `./${path}`)]);
  } else {
    console.log('PASS eslint skipped: no lintable file changed');
  }
  run('tsc --noEmit', 'node_modules/typescript/bin/tsc', ['--noEmit']);
  if (selection.webTypecheck) {
    run('web typecheck', 'node_modules/typescript/bin/tsc', ['--noEmit', '-p', 'src/web-ui/tsconfig.json']);
  } else {
    console.log('PASS web typecheck skipped: no changed path under src/web-ui/');
  }
  run('realio lane lint', 'scripts/check-realio-lane-membership.mjs');
  run('verse sync-I/O lint', 'scripts/check-verse-sync-io.mjs');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
