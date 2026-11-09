/**
 * Account home for safety paths (KILL, pause, owner approvals, send policy).
 *
 * `os.homedir()` and `$HOME` follow a relocated environment. A child process
 * can point those at a decoy and make a real `~/.ashlr/KILL` look absent.
 * `os.userInfo().homedir` is the passwd entry, which that child cannot move.
 *
 * Vitest fixtures still relocate `HOME` so enrollment and KILL stay inside a
 * throwaway directory. `useProcessHomeForTest` selects that resolver for the
 * worker. It is ignored unless `VITEST=true`, and a fresh process starts on
 * the account home, so inheriting the variable does not retarget KILL.
 */
import { homedir, userInfo } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const TEST_SOURCE = Symbol.for('ashlr.real-home.test-source');

type RealHomeSource = 'account' | 'process';

type RealHomeGlobal = typeof globalThis & { [TEST_SOURCE]?: RealHomeSource };

function absoluteHome(home: unknown): string | null {
  if (typeof home !== 'string' || home.length === 0 || !isAbsolute(home)) return null;
  return resolve(home);
}

function accountHome(): string | null {
  try {
    return absoluteHome(userInfo().homedir);
  } catch {
    return null;
  }
}

function processHome(): string | null {
  try {
    return absoluteHome(homedir());
  } catch {
    return null;
  }
}

function testSource(): RealHomeSource {
  if (process.env.VITEST !== 'true') return 'account';
  return (globalThis as RealHomeGlobal)[TEST_SOURCE] === 'process' ? 'process' : 'account';
}

function assertTestOnly(): void {
  if (process.env.VITEST !== 'true') {
    throw new Error('Real home test controls are unavailable.');
  }
}

/** Passwd home. `$HOME` cannot redirect this unless a Vitest fixture opted into process home. */
export function realHome(): string | null {
  const source = testSource();
  switch (source) {
    case 'account':
      return accountHome();
    case 'process':
      return processHome();
    default: {
      const unexpected: never = source;
      return unexpected;
    }
  }
}

/** Vitest only. Safety paths follow `os.homedir()` so a relocated HOME stays isolated. */
export function useProcessHomeForTest(): void {
  assertTestOnly();
  (globalThis as RealHomeGlobal)[TEST_SOURCE] = 'process';
}

/** Vitest only. Safety paths use the passwd home and ignore a relocated HOME. */
export function useAccountHomeForTest(): void {
  assertTestOnly();
  (globalThis as RealHomeGlobal)[TEST_SOURCE] = 'account';
}
