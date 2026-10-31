/** One security floor for pool CLI admission and doctor. */
import { runVerifySubprocessAsync, type VerifySubprocessOptions } from '../run/verify-commands.js';
import { compareCliVersions } from '../verse/model-windows.js';

export const POOL_CLI_MIN_VERSIONS = Object.freeze({
  // Claude Code 2.1.311 bundles Agent SDK 0.3.311 — the Agent SDK floor.
  claude: Object.freeze({ label: 'Claude Code', minimum: '2.1.311' }),
  codex: Object.freeze({ label: 'Codex', minimum: '0.164.0' }),
});
export type PoolCliProvider = keyof typeof POOL_CLI_MIN_VERSIONS;
export interface PoolCliVersionCheck {
  version: string | null;
  status: 'supported' | 'outdated' | 'unknown';
  failure?: 'termination-uncertain' | 'timed-out' | 'cancelled';
}

/** Accept only a complete vendor version line. Never return arbitrary CLI text. */
export function parsePoolCliVersion(provider: PoolCliProvider, output: string): string | null {
  const identifier = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*';
  const number = `((?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})(?:-${identifier})?(?:\\+${identifier})?)`;
  const pattern = provider === 'claude' ? `^${number} \\(Claude Code\\)$` : `^codex-cli ${number}$`;
  const version = new RegExp(pattern).exec(output.trim())?.[1];
  return version && version.length <= 96 ? version : null;
}

export function assessPoolCliVersion(provider: PoolCliProvider, output: string): PoolCliVersionCheck {
  const version = parsePoolCliVersion(provider, output);
  if (version === null) return { version, status: 'unknown' };
  const core = version.split(/[-+]/)[0]!;
  const comparison = compareCliVersions(core, POOL_CLI_MIN_VERSIONS[provider].minimum);
  // Any prerelease of the floor is older, including semver-valid hyphenated identifiers.
  const outdated = comparison < 0 || comparison === 0 && version.slice(core.length).startsWith('-');
  return { version, status: outdated ? 'outdated' : 'supported' };
}

/** Bounded, cancellable probe of the exact enrolled wrapper. No prompt or raw diagnostics escape. */
export async function probePoolCliVersion(provider: PoolCliProvider, command: readonly string[],
  options: Pick<VerifySubprocessOptions, 'cwd' | 'env' | 'signal' | 'timeoutMs'>): Promise<PoolCliVersionCheck> {
  if (command.length === 0 || options.signal?.aborted) return { version: null, status: 'unknown' };
  try {
    const result = await runVerifySubprocessAsync([...command, '--version'], {
      ...options, timeoutMs: Math.min(options.timeoutMs, 5_000), maxOutputChars: 4_096,
    });
    // A failed ownership proof takes precedence over cancellation or timeout.
    if (result.error?.startsWith('termination authority lost:') ||
      result.error === 'termination deadline elapsed with process-group exit unconfirmed') {
      return { version: null, status: 'unknown', failure: 'termination-uncertain' };
    }
    if (result.cancelled) return { version: null, status: 'unknown', failure: 'cancelled' };
    if (result.timedOut) return { version: null, status: 'unknown', failure: 'timed-out' };
    if (result.exitCode !== 0 || result.error || result.signal || result.outputTruncated) {
      return { version: null, status: 'unknown' };
    }
    return assessPoolCliVersion(provider, result.stdout);
  } catch { return { version: null, status: 'unknown' }; }
}
