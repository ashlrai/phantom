import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { daemonStatePath } from '../../src/core/daemon/state.js';
import { resolveWorkerHomeParent } from './home.js';

it('establishes an isolated HOME and ASHLR_HOME before test modules load', () => {
  const home = process.env.HOME;

  expect(home).toBeTruthy();
  expect(existsSync(home!)).toBe(true);
  expect(basename(home!)).toMatch(/^ashlr-vitest-home-/);
  expect(process.env.USERPROFILE).toBe(home);
  expect(process.env.ASHLR_HOME).toBe(join(home!, '.ashlr'));
  expect(homedir()).toBe(home);
  expect(execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], {
    encoding: 'utf8',
  })).toBe(home);
});

it('honors the validated local-gate worker-home parent when configured', () => {
  const parent = process.env.ASHLR_VITEST_HOME_PARENT;
  if (!parent) return;
  const identity = lstatSync(parent);
  expect(realpathSync(parent)).toBe(parent);
  expect(identity.isDirectory()).toBe(true);
  expect(identity.isSymbolicLink()).toBe(false);
  expect(identity.uid).toBe(process.getuid());
  expect(identity.mode & 0o7777).toBe(0o700);
  expect(dirname(process.env.HOME!)).toBe(parent);
});

/**
 * True when every ancestor of `path` passes the worker-home custody walk:
 * a real directory owned by root or the current user with no group/other
 * write bit. Hosted Linux CI gets this from a private TMPDIR; a run whose temp
 * root is the sticky world-writable /tmp does not.
 */
function custodySafeChain(path: string): boolean {
  for (let cursor = realpathSync(path); ; cursor = dirname(cursor)) {
    const ancestor = lstatSync(cursor);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()
      || ![0, process.getuid!()].includes(ancestor.uid) || (ancestor.mode & 0o022) !== 0) return false;
    if (cursor === sep) return true;
  }
}

it('rejects a non-absolute or non-private explicit worker-home parent', () => {
  expect(() => resolveWorkerHomeParent('relative-home')).toThrow(/absolute owned private/u);
  const workerHome = realpathSync(process.env.HOME!);
  if (typeof process.getuid !== 'function') {
    const parent = mkdtempSync(join(workerHome, 'ashlr-vitest-parent-validation-'));
    // Windows has no POSIX owner/mode to validate, so an explicit parent is
    // refused outright (fail closed) rather than accepted unchecked.
    try {
      expect(() => resolveWorkerHomeParent(parent)).toThrow(/absolute owned private/u);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
    return;
  }
  // The acceptance half needs a parent whose whole ancestry is custody-safe.
  // The isolated worker HOME lives under os.tmpdir(); when that is the
  // world-writable /tmp (a local Linux run without a private TMPDIR), use the
  // checkout's own ignored node_modules/.cache instead, and prove the
  // /tmp-rooted parent is refused for its ancestors rather than accepted.
  const repoCache = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.cache');
  const homeIsSafe = custodySafeChain(workerHome);
  if (!homeIsSafe) {
    const unsafeParent = mkdtempSync(join(workerHome, 'ashlr-vitest-parent-validation-'));
    try {
      expect(lstatSync(unsafeParent).mode & 0o7777).toBe(0o700);
      expect(() => resolveWorkerHomeParent(unsafeParent)).toThrow(/custody ancestors/u);
    } finally {
      rmSync(unsafeParent, { recursive: true, force: true });
    }
    mkdirSync(repoCache, { recursive: true });
  }
  const base = homeIsSafe ? workerHome : realpathSync(repoCache);
  expect(custodySafeChain(base), `no custody-safe base for the explicit-parent fixture (tried ${workerHome} and ${base})`).toBe(true);
  const parent = mkdtempSync(join(base, 'ashlr-vitest-parent-validation-'));
  try {
    expect(resolveWorkerHomeParent(parent)).toBe(realpathSync(parent));
    chmodSync(parent, 0o755);
    expect(() => resolveWorkerHomeParent(parent)).toThrow(/mode 0700/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
  if (process.platform === 'darwin') {
    const unsafeParent = mkdtempSync('/private/tmp/ashlr-vitest-parent-validation-');
    try {
      expect(() => resolveWorkerHomeParent(unsafeParent)).toThrow(/custody ancestors/u);
    } finally {
      rmSync(unsafeParent, { recursive: true, force: true });
    }
  }
});

it('allows a test to relocate HOME and restore the isolated worker boundary', () => {
  const workerHome = process.env.HOME;
  const workerAshlrHome = process.env.ASHLR_HOME;
  const nestedHome = mkdtempSync(join(tmpdir(), 'ashlr-vitest-nested-home-'));

  try {
    process.env.HOME = nestedHome;
    process.env.ASHLR_HOME = join(nestedHome, '.ashlr');
    expect(homedir()).toBe(nestedHome);
  } finally {
    process.env.HOME = workerHome;
    process.env.ASHLR_HOME = workerAshlrHome;
    rmSync(nestedHome, { recursive: true, force: true });
  }

  expect(homedir()).toBe(workerHome);
  expect(process.env.ASHLR_HOME).toBe(workerAshlrHome);
});

// ---------------------------------------------------------------------------
// Regression guard — root-caused 2026-08-05/06 incident:
// a fail-OPEN `process.env['HOME'] || actual.homedir()` fallback let any test
// that cleared/misrestored HOME silently resolve to the REAL developer home,
// and daemon/state writers (which resolve homedir() fresh on every call) wrote
// real ~/.ashlr state with no error. These tests fail the suite loudly the
// instant that condition recurs, instead of letting it write through silently.
// ---------------------------------------------------------------------------

it('throws instead of silently falling back to the real home when HOME is cleared', () => {
  const home = process.env.HOME;
  const userProfile = process.env.USERPROFILE;
  try {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(() => homedir()).toThrow(/HOME isolation escaped/);
  } finally {
    process.env.HOME = home;
    if (userProfile !== undefined) process.env.USERPROFILE = userProfile;
  }
});

it('throws instead of silently resolving under the real developer home', () => {
  const realHome = process.env['ASHLR_VITEST_REAL_HOME'];
  // No ambient HOME was ever observed for this worker (unusual environment) —
  // nothing to guard against, so there's nothing this specific test can prove.
  if (!realHome) return;
  const home = process.env.HOME;
  try {
    process.env.HOME = realHome;
    expect(() => homedir()).toThrow(/HOME isolation escaped/);
  } finally {
    process.env.HOME = home;
  }
});

it('protects real production path resolution (daemonStatePath), not just the raw os.homedir() call', () => {
  const home = process.env.HOME;
  try {
    delete process.env.HOME;
    expect(() => daemonStatePath()).toThrow(/HOME isolation escaped/);
  } finally {
    process.env.HOME = home;
  }

  // Sanity check the escape hatch is closed, not just the alarm: with HOME
  // correctly restored, daemonStatePath() must resolve under the isolated
  // worker home and NEVER under the real developer home captured at worker
  // startup.
  const resolved = daemonStatePath();
  expect(resolved.startsWith(home!)).toBe(true);
  const realHome = process.env['ASHLR_VITEST_REAL_HOME'];
  if (realHome) expect(resolved.startsWith(realHome)).toBe(false);
});
