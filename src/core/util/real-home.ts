/**
 * The account home that anchors operator authority: KILL, the outward mutation
 * fence, execution leases, comms pause, send policy, owner and team identity,
 * standing approvals and outbox recipients.
 *
 * It comes from the passwd entry (`os.userInfo().homedir`), never from HOME.
 * Phantom starts children with a relocated HOME (autonomous sandbox env, the
 * engineer bash scratch home, self-swap rehearsal), and a child that resolved
 * authority from HOME would see no KILL, no pause and a forged recipient list.
 *
 * There is deliberately no environment override (HOME, USERPROFILE, ASHLR_HOME,
 * ASHLR_RUNS_DIR or any new variable). Tests use {@link __setRealHomeForTests}.
 *
 * win32: `os.userInfo().homedir` is not a passwd lookup there, so this falls
 * back to `os.homedir()`, which honors USERPROFILE. That carries the same
 * relocation risk and is a documented follow-up (docs/COMMS-AGENT.md).
 */
import * as os from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** Test override. `homedir` resolves through `os.homedir()` (the pre-fix behavior, for hermetic suites). */
export type RealHomeTestOverride = { kind: 'path'; path: string } | { kind: 'homedir' };

// A global symbol so the override set by test/setup reaches every module
// instance (vitest module isolation, and the child preload in
// test/setup/real-home-child.mjs, which cannot import TypeScript). Only
// honored while VITEST is set; production code never writes it.
const OVERRIDE_KEY = Symbol.for('ashlr.realHome.testOverride');

type OverrideHost = { [OVERRIDE_KEY]?: RealHomeTestOverride };

function activeOverride(): RealHomeTestOverride | undefined {
  if (!process.env.VITEST) return undefined;
  return (globalThis as OverrideHost)[OVERRIDE_KEY];
}

// In-process isolated authority home for `phm demo` (enterIsolatedAuthorityHome).
let isolatedHome: string | null = null;

function accountHome(): string {
  if (isolatedHome !== null) return isolatedHome;
  const override = activeOverride();
  if (override?.kind === 'path') return override.path;
  if (override?.kind === 'homedir' || process.platform === 'win32') return os.homedir();
  return os.userInfo().homedir;
}

let divergenceLogged = false;

/** Absolute account home. Throws when the account has no usable home; callers fail closed. */
export function realHome(): string {
  const home = accountHome();
  if (typeof home !== 'string' || home.length === 0 || !isAbsolute(home)) {
    throw new Error('account home is not an absolute path');
  }
  const envHome = process.env.HOME;
  if (!divergenceLogged && envHome && resolve(envHome) !== resolve(home)) {
    divergenceLogged = true;
    process.stderr.write('HOME differs from account home; authority read from account home\n');
  }
  return home;
}

/**
 * Scope authority to a private throwaway home for the rest of this process,
 * until the returned function is called. Only `phm demo` uses it, so its
 * throwaway enrollment and audit never touch the operator's ~/.ashlr. It is a
 * function call, not an environment variable: no child can select it. Callers
 * must refuse to start while the account-home KILL is on, and every outside
 * transport is blocked while a scope is active (comms/transport-gate.ts).
 */
export function enterIsolatedAuthorityHome(home: string): () => void {
  if (!isAbsolute(home)) throw new Error('isolated authority home must be absolute');
  if (isolatedHome !== null) throw new Error('an isolated authority home is already active');
  isolatedHome = home;
  return () => { if (isolatedHome === home) isolatedHome = null; };
}

/** True while {@link enterIsolatedAuthorityHome} is in effect. */
export function isolatedAuthorityHomeActive(): boolean {
  return isolatedHome !== null;
}

/** {@link realHome} normalized, or null when it cannot be resolved. */
export function canonicalRealHome(): string | null {
  try {
    return resolve(realHome());
  } catch {
    return null;
  }
}

/**
 * @internal Test seam. Pass an absolute path to pin the account home, `'homedir'`
 * to follow `os.homedir()`, or null to clear. Returns the previous override so
 * a test can restore it. Throws unless VITEST is set.
 */
export function __setRealHomeForTests(home: string | 'homedir' | null): RealHomeTestOverride | null {
  if (!process.env.VITEST) throw new Error('__setRealHomeForTests is only available under Vitest');
  const host = globalThis as OverrideHost;
  const previous = host[OVERRIDE_KEY] ?? null;
  if (home === null) delete host[OVERRIDE_KEY];
  else if (home === 'homedir') host[OVERRIDE_KEY] = { kind: 'homedir' };
  else {
    if (!isAbsolute(home)) throw new Error('__setRealHomeForTests needs an absolute path');
    host[OVERRIDE_KEY] = { kind: 'path', path: home };
  }
  return previous;
}

/** @internal Restore a value returned by {@link __setRealHomeForTests}. */
export function __restoreRealHomeForTests(previous: RealHomeTestOverride | null): void {
  __setRealHomeForTests(previous === null ? null : previous.kind === 'homedir' ? 'homedir' : previous.path);
}
