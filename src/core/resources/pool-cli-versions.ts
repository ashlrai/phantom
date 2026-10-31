/** One security floor for pool CLI admission and doctor, plus gated CLI feature env. */
import { runVerifySubprocessAsync, type VerifySubprocessOptions } from '../run/verify-commands.js';
import { compareCliVersions } from '../verse/model-windows.js';

export const POOL_CLI_MIN_VERSIONS = Object.freeze({
  claude: Object.freeze({ label: 'Claude Code', minimum: '2.1.309' }),
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

/**
 * The oldest Claude Code build that defines the bounded usage-limit watchdog
 * controls: its changelog documents `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS`
 * (stop waiting when a limit reset is too far away) and
 * `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` (notice a lifted limit
 * before reset), and fixes an unattended watchdog verdict that could hold a
 * turn open indefinitely. Older builds expose only the master switch, so the
 * tuning vars would be inert on them — and the unbounded wait they bound is
 * the exact failure mode the floor exists to prevent. A build whose version
 * cannot be established gets none of the env.
 */
export const CLAUDE_RETRY_WATCHDOG_MIN_VERSION = '2.1.311';
/** Loosest cadence the recheck interval may take; a wait may be shorter. */
export const CLAUDE_WATCHDOG_RECHECK_MAX_MS = 3_600_000;

/**
 * The watchdog env for one spawned claude CLI, or none.
 * `usageLimitWaitMs` is the caller's own bound on waiting at a usage limit —
 * a seat's nearest reset horizon in Verse, a pool task's remaining deadline in
 * the pool worker — so a far-off refusal ends the request instead of parking
 * the slot. The recheck cadence is a tenth of that wait, capped; polls stay
 * proportional to the horizon rather than fixed regardless of budget.
 */
export function claudeRetryWatchdogEnv(cliVersion: string | null, usageLimitWaitMs: number): Record<string, string> {
  if (cliVersion === null || compareCliVersions(cliVersion, CLAUDE_RETRY_WATCHDOG_MIN_VERSION) < 0 ||
    !Number.isSafeInteger(usageLimitWaitMs) || usageLimitWaitMs < 1) return {};
  return {
    CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: String(usageLimitWaitMs),
    CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS:
      String(Math.min(Math.max(1, Math.floor(usageLimitWaitMs / 10)), CLAUDE_WATCHDOG_RECHECK_MAX_MS)),
  };
}
