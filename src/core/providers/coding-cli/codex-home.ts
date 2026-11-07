/**
 * Codex credential homes. The primary account lives in CODEX_HOME or ~/.codex.
 * That login cannot renew, so a missing, unreadable, or logged-out primary is
 * marked dead and the router moves to CODEX_HOME_ALT or ~/.codex-2.
 *
 * auth.json is an existence check only. This module does not read, write, or
 * delete it, and it does not touch backups. It never asks the CLI to log out.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type CodexHomeProblem = 'missing' | 'unreadable' | 'auth-missing';

export interface CodexHomeFs {
  stat(path: string): { isDirectory(): boolean };
  access(path: string): void;
  /** Existence only. Callers may pass the auth.json path and nothing else. */
  exists(path: string): boolean;
}

export function isAuthJsonPath(path: string): boolean {
  return path.endsWith('/auth.json') || path.endsWith('\\auth.json');
}

export function realCodexHomeFs(): CodexHomeFs {
  return {
    stat(path) {
      const stat = statSync(path);
      return { isDirectory: () => stat.isDirectory() };
    },
    access(path) {
      accessSync(path, constants.R_OK | constants.X_OK);
    },
    exists(path) {
      if (!isAuthJsonPath(path)) throw new Error('codex home probe checks auth.json only');
      return existsSync(path);
    },
  };
}

export function inspectCodexHome(home: string, fsImpl: CodexHomeFs): CodexHomeProblem | null {
  let dir: { isDirectory(): boolean };
  try {
    dir = fsImpl.stat(home);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return 'unreadable';
  }
  if (!dir.isDirectory()) return 'missing';
  try {
    fsImpl.access(home);
  } catch {
    return 'unreadable';
  }
  const authPath = join(home, 'auth.json');
  if (!fsImpl.exists(authPath)) return 'auth-missing';
  return null;
}

/** CLI text that means the account itself cannot be used again. */
export function codexAuthOrLogin(text: string): 'auth' | 'login' | null {
  if (/authentication error|could not refresh token|unauthorized|auth(?:entication|orization)? failed/i.test(text)) return 'auth';
  if (/not logged in|login expired|please run \S* ?login|sign in/i.test(text)) return 'login';
  return null;
}
