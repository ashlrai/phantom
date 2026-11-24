import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve, win32 } from 'node:path';

/** PATH discovery without a locator subprocess. This proves presence, never readiness. */
export function findDoctorExecutable(binary: string): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(binary)) return null;
  const path = process.env.PATH;
  if (path === undefined) return null;
  const windows = process.platform === 'win32';
  const suffixes = windows && !/\.(exe|cmd|bat|com)$/i.test(binary) ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  for (const entry of path.split(windows ? ';' : delimiter)) {
    const directory = windows ? entry.replace(/^"(.*)"$/, '$1') : entry;
    // Windows implicit cwd/drive-relative lookup can resolve an unrelated
    // project shim. Only explicit absolute PATH directories count here.
    if (windows && (!directory || !(win32.isAbsolute(directory) || isAbsolute(directory)))) continue;
    for (const suffix of suffixes) {
      try {
        // POSIX empty and relative PATH entries are relative to the current cwd.
        const candidate = resolve(directory || '.', binary + suffix);
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
        // Preserve the located shim path; resolving symlinks changes metadata fallbacks.
        return candidate;
      } catch { /* Missing, inaccessible, dangling or non-executable: try the next entry. */ }
    }
  }
  return null;
}
