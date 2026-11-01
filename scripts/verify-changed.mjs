import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
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

/** Preflight check that a local eslint install is complete. */
export function eslintPreflight(root, exists = existsSync) {
  const binPath = resolve(root, 'node_modules/eslint/bin/eslint.js');
  const libPath = resolve(root, 'node_modules/eslint/lib/cli.js');
  if (exists(binPath) && exists(libPath)) {
    return { ok: true };
  }
  if (!exists(binPath)) {
    return { ok: false, reason: 'node_modules/eslint/bin/eslint.js is absent; run npm ci to restore it' };
  }
  return { ok: false, reason: 'node_modules/eslint/lib/cli.js is absent; run npm ci to restore it' };
}

/** Resolve the local and shared incremental build-info paths for this checkout. */
export function tscCachePaths(root, env = process.env) {
  const config = readFileSync(resolve(root, 'tsconfig.json'));
  const lock = readFileSync(resolve(root, 'package-lock.json'));
  const buildInfo = JSON.parse(config.toString()).compilerOptions?.tsBuildInfoFile;
  if (typeof buildInfo !== 'string' || !buildInfo) throw new Error('tsconfig.json must specify tsBuildInfoFile');
  const hash = createHash('sha256').update(String(lock.length)).update(':').update(lock).update(config).digest('hex');
  const commonDir = env.PHANTOM_TSC_CACHE_DIR || resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(), 'phantom-tsc-cache');
  return { local: resolve(root, buildInfo), shared: resolve(root, commonDir, `${hash}.tsbuildinfo`) };
}

/** Copy through a unique sibling so readers never see a partially written cache. */
export function copyBuildInfo(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Native diagnostics (exit 1/2) are final; only crashes use the JS compiler. */
export function runNativeTypecheck(root, timeout, spawn = spawnSync, exists = existsSync, config = 'tsconfig.json') {
  const binary = resolve(root, 'node_modules/.bin/tsgo');
  if (!exists(binary)) return null;
  const result = spawn(binary, ['--noEmit', '-p', config], {
    cwd: root, stdio: 'inherit', timeout: timeout * 1000, killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ETIMEDOUT') return false;
  if (result.error || result.signal || result.status === null || result.status > 2) {
    console.warn('Native compiler crashed; falling back to tsc');
    return null;
  }
  return result.status === 0;
}

/** Run the web compiler with the backend's native-first diagnostic policy. */
export function runWebTypecheck(root, timeout, run, spawn = spawnSync, exists = existsSync) {
  const config = 'src/web-ui/tsconfig.json';
  const native = runNativeTypecheck(root, timeout, spawn, exists, config);
  if (native === null) return run('web typecheck', 'node_modules/typescript/bin/tsc', ['--noEmit', '-p', config], timeout);
  console.log(`${native ? 'PASS' : 'FAIL'} web typecheck`);
  return native;
}

/** Scope the guard's failing file lists while preserving unexpected failures. */
export function runRealioCheck(root, changed, spawn = spawnSync) {
  const result = spawn(process.execPath, ['scripts/check-realio-lane-membership.mjs'], {
    cwd: root, encoding: 'utf8',
  });
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL realio lane lint');
    return false;
  }
  const files = [];
  let failingSection = false;
  for (const line of (result.stderr || '').split('\n')) {
    if (line.startsWith('[check-realio-lane-membership]')) {
      failingSection = /(?:The following test files|stale KNOWN_FAST_SPAWN_FILES|stale REAL_IO_TEST_FILES)/.test(line);
    }
    if (failingSection && /^ {2}test\//.test(line)) files.push(line.slice(2));
  }
  if (result.status === 1 && files.length === 0) {
    if (result.stderr) console.error(result.stderr.trimEnd());
    console.log('FAIL realio lane lint: unrecognized guard failure');
    return false;
  }
  const changedSet = new Set(changed);
  const relevant = files.filter((file) => changedSet.has(file));
  const unrelated = files.filter((file) => !changedSet.has(file));
  if (unrelated.length) console.warn(`WARN realio lane lint: unchanged files: ${unrelated.join(', ')}`);
  if (relevant.length) console.error(`Realio lane violations in changed files: ${relevant.join(', ')}`);
  if (result.status === 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.warn(result.stderr.trimEnd());
  }
  console.log(`${relevant.length ? 'FAIL' : 'PASS'} realio lane lint`);
  return relevant.length === 0;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let selection;
  let changed;
  try {
    changed = collectChangedPaths(root);
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
  const run = (name, script, args = [], timeoutSeconds) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root, stdio: 'inherit', timeout: timeoutSeconds && timeoutSeconds * 1000,
      killSignal: timeoutSeconds ? 'SIGKILL' : undefined,
    });
    const passed = !result.error && result.status === 0;
    if (result.error?.code === 'ETIMEDOUT') console.log(`FAIL tsc timed out after ${timeoutSeconds}s`);
    else console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
    if (result.error && result.error.code !== 'ETIMEDOUT') console.error(result.error.message);
    if (!passed) process.exitCode = 1;
    return passed;
  };
  const preflight = eslintPreflight(root);
  if (!preflight.ok) {
    console.log(`SKIP eslint: ${preflight.reason}; Merge Gate lints on CI`);
  } else if (selection.lintFiles.length) {
    // ESLint applies its own config/ignores; explicit ignored paths are silent.
    run('eslint changed files', 'node_modules/eslint/bin/eslint.js', ['--no-warn-ignored', '--', ...selection.lintFiles.map((path) => `./${path}`)]);
  } else {
    console.log('PASS eslint skipped: no lintable file changed');
  }
  try {
    const timeout = Number(process.env.PHANTOM_TSC_TIMEOUT_SECONDS ?? 900);
    if (!Number.isFinite(timeout) || !Number.isInteger(timeout * 1000) || timeout * 1000 < 1 || timeout * 1000 > 2_147_483_647) {
      throw new Error('PHANTOM_TSC_TIMEOUT_SECONDS must be a positive number of seconds within the supported timeout range');
    }
    const native = runNativeTypecheck(root, timeout);
    if (native !== null) {
      console.log(`${native ? 'PASS' : 'FAIL'} tsgo --noEmit`);
      if (!native) process.exitCode = 1;
    } else {
      const cache = tscCachePaths(root);
      try {
        copyBuildInfo(cache.shared, cache.local);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (run('tsc --noEmit', 'node_modules/typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.json'], timeout)) {
        copyBuildInfo(cache.local, cache.shared);
      }
    }
    if (selection.webTypecheck) {
      if (!runWebTypecheck(root, timeout, run)) process.exitCode = 1;
    } else {
      console.log('PASS web typecheck skipped: no changed path under src/web-ui/');
    }
  } catch (error) {
    console.error(`FAIL tsc cache: ${error.message}`);
    process.exitCode = 1;
  }
  if (!runRealioCheck(root, changed)) process.exitCode = 1;
  run('verse sync-I/O lint', 'scripts/check-verse-sync-io.mjs');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
