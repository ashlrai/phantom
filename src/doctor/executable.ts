import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

/** POSIX PATH discovery without a locator subprocess. This proves presence, never readiness. */
export function findDoctorExecutable(binary: string): string | null {
  // Windows callers retain the trusted SystemRoot where.exe lookup and its
  // $PATH: prefix: do not accidentally add Windows' implicit cwd search here.
  if (process.platform === 'win32' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(binary)) return null;
  const path = process.env.PATH;
  if (path === undefined) return null;
  for (const directory of path.split(delimiter)) {
    try {
      // POSIX empty and relative PATH entries are relative to the current cwd.
      const candidate = resolve(directory || '.', binary);
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      // Preserve the located shim path; resolving symlinks changes metadata fallbacks.
      return candidate;
    } catch { /* Missing, inaccessible, dangling or non-executable: try the next entry. */ }
  }
  return null;
}
