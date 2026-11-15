/**
 * Claude re-sign-in for the claude lane (human-steps gap R-01).
 *
 * `claude setup-token` takes no stdin or argv: it opens the browser sign-in and
 * PRINTS a long-lived token, which the CLI later reads as CLAUDE_CODE_OAUTH_TOKEN.
 * So the value cannot be handed to it. Phantom instead takes the printed token
 * through one masked prompt and passes it straight to custody (the existing
 * `ashlr-custody store-claude-token` stdin path). Expiry is read only from the
 * CLI's own `auth status --json` exit code; no credential file, keychain value
 * or `~/.claude*` content is read, and the token is never logged or returned.
 */
import { probeClaudeAccountStatus, type ClaudeAccountStatusOptions, type ClaudeAccountStatusResult } from './claude-account-status.js';

export type ClaudeAuthState = 'valid' | 'expired' | 'missing' | 'unknown';
export interface ClaudeAuthCheck {
  state: ClaudeAuthState;
  /** Operator-facing sentence; never contains identity or token material. */
  message: string;
}

export const CLAUDE_SIGNIN_COMMAND = 'phm authority claude-signin';

/**
 * `credentialSeen` is attribute-only evidence that a Claude credential entry
 * existed (the keychain item's modification time, read without `-w`): a signed-out
 * CLI that still has one lapsed, one that never had one is simply not signed in.
 * `null` means the caller has no such evidence.
 */
export function classifyClaudeAuth(status: ClaudeAccountStatusResult, credentialSeen: boolean | null): ClaudeAuthCheck {
  if (status.status !== 'observed' || status.loggedIn === null) {
    return { state: 'unknown', message: `Claude auth could not be checked (${status.reason}).` };
  }
  if (status.loggedIn) return { state: 'valid', message: 'Claude auth is valid.' };
  if (credentialSeen === null) {
    return { state: 'missing', message: `Claude is not signed in (expired or never set up). Run \`${CLAUDE_SIGNIN_COMMAND}\`.` };
  }
  return credentialSeen
    ? { state: 'expired', message: `Claude auth expired: needs re-sign-in. Run \`${CLAUDE_SIGNIN_COMMAND}\`.` }
    : { state: 'missing', message: `No Claude auth found: sign in first. Run \`${CLAUDE_SIGNIN_COMMAND}\`.` };
}

export async function checkClaudeAuth(
  options: ClaudeAccountStatusOptions & { credentialSeen?: boolean | null },
  probe: typeof probeClaudeAccountStatus = probeClaudeAccountStatus,
): Promise<ClaudeAuthCheck> {
  const { credentialSeen = null, ...probeOptions } = options;
  // An unusable launcher (not installed, not absolute) is "could not check", not a crash.
  const status = await probe(probeOptions).catch((): ClaudeAccountStatusResult => ({
    schemaVersion: 1, scope: 'claude-native-auth-status', status: 'failed', reason: 'status-process-failed',
    loggedIn: null, authMethod: 'unknown', subscriptionType: null, accountHint: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  }));
  return classifyClaudeAuth(status, credentialSeen);
}

export interface ClaudeResigninDeps {
  /** Masked entry; the caller owns the terminal or app prompt. */
  readSecret(prompt: string): Promise<string>;
  /** custody.storeClaudeToken: validates the shape and pipes the value over stdin. */
  storeClaudeToken(token: string): Promise<void>;
}

/** One masked prompt, one custody store. Errors never echo the entered value. */
export async function renewClaudeToken(deps: ClaudeResigninDeps): Promise<void> {
  const token = (await deps.readSecret('Paste the `claude setup-token` output (hidden): ')).trim();
  if (!token) throw new Error('nothing was entered');
  await deps.storeClaudeToken(token);
}
