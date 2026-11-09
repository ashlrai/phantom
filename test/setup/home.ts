/**
 * Global test setup: isolate every Vitest worker from the developer's home and
 * make `homedir()` follow `process.env.HOME` on every platform.
 *
 * Setup files run before each test module. The worker marker keeps one stable
 * temporary home for that worker, so tests may further relocate HOME and restore
 * the value they captured at module load without escaping the suite boundary.
 * Reasserting the boundary here also contains a preceding file that forgot to
 * restore its environment.
 *
 * The `node:os` mock reaches both named and default imports. It is required on
 * Windows, where the native `homedir()` ignores HOME and reads USERPROFILE.
 *
 * FAIL-LOUD BOUNDARY (root-caused 2026-08-05/06 incident — real ~/.ashlr/daemon.json
 * was corrupted by a test run):
 *   The previous mock was `process.env['HOME'] || actual.homedir()` — a FAIL-OPEN
 *   fallback. The instant any test cleared/deleted HOME (a bug, a thrown exception
 *   between an override and its restore, a stray `delete process.env.HOME`) OR
 *   accidentally reassigned HOME back to the real value, `homedir()` would SILENTLY
 *   resolve to the developer's REAL home with no error — and daemon/state writers
 *   (which recompute `homedir()` fresh on every call, by design, to honor mid-test
 *   relocation) would happily persist real state there. Nothing ever told you it
 *   happened.
 *
 *   `guardedHomedir()` below removes that fallback entirely. HOME falsy, or HOME
 *   resolving to the exact real developer home captured before this file's first
 *   override, is now a thrown error — the offending test fails immediately and
 *   loudly instead of the suite quietly writing through the isolation boundary.
 */
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { enableCompileCache } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

const workerHomeKey = 'ASHLR_VITEST_WORKER_HOME';
const workerPidKey = 'ASHLR_VITEST_WORKER_PID';
const realHomeKey = 'ASHLR_VITEST_REAL_HOME';
const workerHomeParentKey = 'ASHLR_VITEST_HOME_PARENT';
const workerCompileCacheKey = 'ASHLR_VITEST_COMPILE_CACHE';
let workerHome = process.env[workerHomeKey];

export function resolveWorkerHomeParent(
  configured = process.env[workerHomeParentKey],
): string {
  if (!configured) return tmpdir();
  if (!isAbsolute(configured) || typeof process.getuid !== 'function') {
    throw new Error(`${workerHomeParentKey} must name an absolute owned private directory`);
  }
  const canonical = realpathSync(configured);
  const identity = lstatSync(configured);
  if (resolve(configured) !== canonical || !identity.isDirectory() || identity.isSymbolicLink()
    || identity.uid !== process.getuid() || (identity.mode & 0o7777) !== 0o700) {
    throw new Error(`${workerHomeParentKey} must name a canonical current-user-owned mode 0700 directory`);
  }
  for (let cursor = canonical; ; cursor = dirname(cursor)) {
    const ancestor = lstatSync(cursor);
    if (realpathSync(cursor) !== cursor || !ancestor.isDirectory() || ancestor.isSymbolicLink()
      || ![0, process.getuid()].includes(ancestor.uid) || (ancestor.mode & 0o022) !== 0) {
      throw new Error(`${workerHomeParentKey} must have owned non-writable custody ancestors`);
    }
    if (cursor === sep) break;
  }
  return canonical;
}

if (!workerHome || process.env[workerPidKey] !== String(process.pid)) {
  // First setup-file execution for this worker process: process.env.HOME (if
  // set at all) still holds whatever the ambient shell/CI environment gave us —
  // the REAL developer home. Capture it now, before it is overwritten below, as
  // the exact boundary no resolved path may ever cross again for this worker's
  // lifetime.
  if (!process.env[realHomeKey]) {
    const ambientHome = process.env['HOME'] || process.env['USERPROFILE'];
    if (ambientHome) process.env[realHomeKey] = resolve(ambientHome);
  }

  // macOS commonly exposes its temporary directory through a symlink. Keep
  // the canonical identity so custody checks and exit cleanup agree.
  workerHome = realpathSync(mkdtempSync(join(resolveWorkerHomeParent(), 'ashlr-vitest-home-')));
  process.env[workerHomeKey] = workerHome;
  process.env[workerPidKey] = String(process.pid);
  // Compile-cache beside (not inside) the worker home: tests snapshot homedir()
  // to prove fixtures untouched, so cache entries must not land there. The many
  // Node children tests spawn (tsx CLI fixtures, `node -e` probes) then reuse V8
  // code cache instead of recompiling the same modules per child. Tests needing
  // a guaranteed cold child keep their explicit NODE_DISABLE_COMPILE_CACHE.
  if (!process.env['NODE_DISABLE_COMPILE_CACHE']) {
    const compileCache = realpathSync(mkdtempSync(join(resolveWorkerHomeParent(), 'ashlr-vitest-ncc-')));
    process.env[workerCompileCacheKey] = compileCache;
    try {
      enableCompileCache(compileCache);
    } catch {
      // Compile cache is an optimization only; never let it gate a test run.
    }
    const cacheIdentity = lstatSync(compileCache);
    process.once('exit', () => {
      try {
        const current = lstatSync(compileCache);
        if (current.isDirectory() && !current.isSymbolicLink()
          && current.dev === cacheIdentity.dev && current.ino === cacheIdentity.ino
          && current.uid === cacheIdentity.uid
          && realpathSync(compileCache) === compileCache) {
          rmSync(compileCache, { recursive: true, force: true });
        }
      } catch {
        // Process shutdown must not turn best-effort cleanup into a failure.
      }
    });
  }
  const homeToRemove = workerHome;
  const homeIdentity = lstatSync(homeToRemove);
  process.once('exit', () => {
    try {
      const current = lstatSync(homeToRemove);
      if (current.isDirectory() && !current.isSymbolicLink()
        && current.dev === homeIdentity.dev && current.ino === homeIdentity.ino
        && current.uid === homeIdentity.uid && (current.mode & 0o7777) === 0o700
        && realpathSync(homeToRemove) === homeToRemove) {
        rmSync(homeToRemove, { recursive: true, force: true });
      }
    } catch {
      // Process shutdown must not turn a best-effort fixture cleanup into a failure.
    }
  });
}

process.env.HOME = workerHome;
process.env.USERPROFILE = workerHome;
process.env.ASHLR_HOME = join(workerHome, '.ashlr');
// Hermetic: fleet-truth never shells out to the real `gh` from a test (tests inject a runner).
process.env.ASHLR_FLEET_TRUTH_GH = 'off';
// Authority (KILL, pause, send policy, config.json) resolves from the ACCOUNT
// home (src/core/util/real-home.ts), which HOME cannot move. Point it back at
// os.homedir() (the guarded HOME above, or a suite's own node:os mock) so every
// suite stays hermetic. Set on the global the module reads, not through an
// import, so a test file's own vi.mock('node:os') still reaches the module.
// test/real-home-authority.test.ts pins a separate account home to prove HOME
// is ignored.
(globalThis as Record<symbol, unknown>)[Symbol.for('ashlr.realHome.testOverride')] = { kind: 'homedir' };
// Node children (tsx CLI fixtures, `node -e` probes) get the same seam through
// a test-only preload. Children spawned with a scrubbed env do not, and then
// resolve the real account home; those must not touch authority state.
// --require, not --import: any --import sends the child's main entry through
// the ESM loader, which rejects extensionless fixture binaries with a dot in
// their name (engine fakes such as grok-0.2.118-macos-aarch64).
const realHomeChildPreload = `--require=${JSON.stringify(fileURLToPath(new URL('./real-home-child.cjs', import.meta.url)))}`;
if (!(process.env['NODE_OPTIONS'] ?? '').includes(realHomeChildPreload)) {
  process.env['NODE_OPTIONS'] = [process.env['NODE_OPTIONS'], realHomeChildPreload].filter(Boolean).join(' ');
}
// Reassert per module like HOME: a child that inherits this env gets the
// worker-private compile cache; an explicit NODE_DISABLE_COMPILE_CACHE in a
// child's own env still wins (Node gives the disable flag priority).
if (process.env[workerCompileCacheKey] && !process.env['NODE_DISABLE_COMPILE_CACHE']) {
  process.env['NODE_COMPILE_CACHE'] = process.env[workerCompileCacheKey];
}
// HOME does not override explicit XDG locations inherited from the shell.
// Reassert these for every module, just like HOME, including for subprocesses.
for (const [key, name] of Object.entries({
  XDG_CONFIG_HOME: 'config',
  XDG_CACHE_HOME: 'cache',
  XDG_DATA_HOME: 'data',
  XDG_STATE_HOME: 'state',
  XDG_RUNTIME_DIR: 'runtime',
})) {
  const directory = join(workerHome, '.xdg', name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  process.env[key] = directory;
}
scrubAmbientGitEnv(process.env);

/**
 * Git reads configuration and repository location from the environment as well
 * as from HOME, so relocating HOME alone does not isolate fixture repositories.
 * A sandbox that injects `url.https://github.com/.insteadOf=git@github.com:`
 * through GIT_CONFIG_COUNT rewrites every fixture's SSH remote, and a suite run
 * from a git hook inherits GIT_DIR/GIT_INDEX_FILE pointing at the developer's
 * real repository. Tests that need these set them explicitly on their own child
 * environment. GIT_CONFIG_SYSTEM and GIT_CONFIG_NOSYSTEM stay as given: platform
 * system config (Git for Windows' autocrlf and TLS backend) is part of the host.
 */
export function scrubAmbientGitEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL)$/i.test(key)
      || /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX)$/i.test(key)) {
      delete env[key];
    }
  }
}

const realHome = process.env[realHomeKey];

function guardedHomedir(): string {
  const raw = process.env['HOME'];
  if (!raw) {
    throw new Error(
      'HOME isolation escaped: process.env.HOME is unset/empty mid-test. This is the exact ' +
      'condition that used to let os.homedir() silently fall back to the REAL developer home ' +
      'and write real ~/.ashlr state (see test/setup/home.ts). Find the test that cleared HOME ' +
      '(delete process.env.HOME / process.env.HOME = undefined) without restoring it to an ' +
      'isolated tmp dir before the next path resolution, and fix it to restore in a finally / ' +
      'afterEach.',
    );
  }
  if (realHome && resolve(raw) === realHome) {
    throw new Error(
      `HOME isolation escaped: process.env.HOME resolved to the REAL developer home ` +
      `(${realHome}) mid-test. A test restored or reassigned HOME to the real directory ` +
      `instead of an isolated tmp dir. Refusing to let daemon/state code resolve paths there ` +
      '(see test/setup/home.ts).',
    );
  }
  return raw;
}

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: guardedHomedir,
    default: { ...actual.default, homedir: guardedHomedir },
  };
});
