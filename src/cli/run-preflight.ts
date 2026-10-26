/**
 * Host preflight for `ashlr run --engine claude --sandbox-engine`.
 *
 * Two host conditions make the sandboxed Claude producer fail only after a
 * sandbox, lease and spawn have been set up, with an error that does not say
 * what to change. Both are knowable before any of that, so refuse up front:
 *
 *  - root: Claude Code refuses `--dangerously-skip-permissions` under uid 0, and
 *    the contained env (buildContainedEnv) does not carry an override through.
 *  - host-managed sign-in: inside a Claude Code cloud container the session's
 *    Claude credential is supplied by the host (CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
 *    plus a base URL/token file). The contained env deliberately drops those,
 *    so the nested `claude` has no credential unless CLAUDE_CODE_OAUTH_TOKEN or
 *    ANTHROPIC_AUTH_TOKEN (the engine's own allowed tokens) is set.
 *
 * Pure: takes the env and uid so it is testable without a real host.
 */

export interface RunHostRefusal {
  reason: 'claude-as-root' | 'claude-host-managed-auth';
  error: string;
  fix: string[];
}

const CLAUDE_ENGINES = new Set(['claude', 'claude-cli']);

export function claudeSandboxHostRefusal(
  engine: string | undefined,
  sandboxEngine: boolean,
  env: NodeJS.ProcessEnv,
  uid: number | undefined,
): RunHostRefusal | null {
  if (!sandboxEngine || !engine || !CLAUDE_ENGINES.has(engine)) return null;
  if (uid === 0) {
    return {
      reason: 'claude-as-root',
      error: 'Claude Code refuses unattended mode (--dangerously-skip-permissions) when run as root.',
      fix: [
        'Run Phantom as a non-root user',
        'Or launch the task in a Claude cloud session: ashlr cloud launch "<task>"',
      ],
    };
  }
  const hasEngineToken = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN);
  if (env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST && !hasEngineToken) {
    return {
      reason: 'claude-host-managed-auth',
      error: 'This host supplies Claude sign-in to the current session only; the sandboxed claude would start without a credential.',
      fix: [
        'Export CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) before running',
        'Or run on a machine where `claude` is signed in',
      ],
    };
  }
  return null;
}
