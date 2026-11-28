/**
 * Fixed inbox PowerShell for Windows telemetry readers: the executable is
 * resolved under the Windows system root (never PATH), the script travels as
 * `-EncodedCommand` (UTF-16LE base64, no shell quoting), and output is
 * bounded. Every reader treats a missing root, a failed spawn or malformed
 * output as unknown — never normal.
 */
import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

export type WindowsPowerShellReader = (file: string, args: string[]) => string;

/** PowerShell cold start and CIM/registry queries need more than a syscall
 * budget; still bounded so a wedged host reads unknown, not stuck. */
export const WINDOWS_POWERSHELL_TIMEOUT_MS = 5_000;

export const readWindowsPowerShell: WindowsPowerShellReader = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', timeout: WINDOWS_POWERSHELL_TIMEOUT_MS, maxBuffer: 64 * 1024,
  killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
});

/** The inbox Windows PowerShell under the system root; anything else is unknown. */
export function windowsPowerShellPath(systemRoot: string | undefined): string | null {
  if (!systemRoot || systemRoot.length > 1_024 || [...systemRoot].some(char => char.charCodeAt(0) < 32)) return null;
  try {
    const root = win32.normalize(systemRoot);
    return /^[A-Za-z]:\\/.test(root)
      ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
  } catch { return null; }
}

/** argv for one non-interactive encoded run of `script`. */
export function windowsPowerShellArgs(script: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
