/**
 * Host AppLauncher for `phm apps open|focus` (RQ-SWE5-CAPABILITY-AUDIT).
 *
 * computer_* has no start/raise tool, so open/focus need a host launcher.
 * On macOS this is `/usr/bin/open -b <bundleId>` — LaunchServices only, no
 * Accessibility, no TCC helper, no keystrokes. Callers still enforce the
 * apps allowlist, computer-use denylist, feed logging and (for quit/status)
 * the desktop connection. Bundle ids are validated before argv assembly.
 */
import { execFile } from 'node:child_process';
import type { AppLauncher } from './desktop-adapters.js';

const BUNDLE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const OPEN_BIN = '/usr/bin/open';
const TIMEOUT_MS = 15_000;

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: Error | null) => void,
) => void;

function runOpen(bundleId: string, exec: ExecFileFn, extraArgs: readonly string[] = []): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!BUNDLE.test(bundleId)) return Promise.resolve({ ok: false, error: 'bundle id is not a LaunchServices bundle identifier.' });
  return new Promise((resolve) => {
    exec(OPEN_BIN, [...extraArgs, '-b', bundleId], { timeout: TIMEOUT_MS }, (error) => {
      if (error) resolve({ ok: false, error: (error.message || 'open failed').slice(0, 300) });
      else resolve({ ok: true });
    });
  });
}

/**
 * macOS LaunchServices launcher. `open -b` starts a not-running app and
 * activates a running one; activate uses the same argv (idempotent raise).
 */
export function createMacOsAppLauncher(exec: ExecFileFn = execFile as ExecFileFn): AppLauncher {
  return {
    open: (bundleId) => runOpen(bundleId, exec),
    activate: (bundleId) => runOpen(bundleId, exec),
  };
}

/** Default host launcher when the CLI runs on macOS; elsewhere none. */
export function defaultHostAppLauncher(
  platform = process.platform,
  exec: ExecFileFn = execFile as ExecFileFn,
): AppLauncher | undefined {
  return platform === 'darwin' ? createMacOsAppLauncher(exec) : undefined;
}
