/**
 * Bounded retries for the read-only GitHub calls a publish resume makes (the
 * default-branch lookup, the compare, the PR list). Only failures that look
 * like the network or GitHub having a bad moment are retried, and only for
 * reads: the PR-creating POST and the auto-merge call run once, so a retry can
 * never open a second PR or skip a check. Auth, permission and not-found errors
 * are not transient and surface at once. Nothing here touches the pushed
 * branch, so completed work stays on the fork for a later retry.
 */
import type { Gh } from '../autopilot/github.js';

export const FETCH_ATTEMPTS = 3;
export const FETCH_BACKOFF_MS = [500, 2_000] as const;

const TRANSIENT = [
  /\bHTTP (?:408|425|429|5\d\d)\b/i,
  /timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i,
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|connection (?:reset|refused|closed)|unexpected EOF|TLS handshake|could not resolve host|temporary failure|network is unreachable/i,
  /rate limit|abuse detection|secondary rate|try again later|service unavailable|bad gateway/i,
];

export function isTransientGhError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT.some((re) => re.test(message));
}

/** Thrown when every attempt at a read failed transiently. The work is untouched; retry later. */
export class FetchDeferredError extends Error {
  constructor(readonly attempts: number, readonly reason: string) {
    super(`GitHub stayed unavailable after ${attempts} tries: ${reason}`);
    this.name = 'FetchDeferredError';
  }
}

const isRead = (args: string[]): boolean =>
  args[0] === 'api' && !args.some((a) => a === 'POST' || a === 'PUT' || a === 'PATCH' || a === 'DELETE');

export interface RetryOptions { attempts?: number; backoffMs?: readonly number[]; sleep?: (ms: number) => Promise<void> }

/** Wrap `gh` so read-only `gh api` calls retry transient failures (at most `attempts` tries in all). */
export function retryReads(gh: Gh, opts: RetryOptions = {}): Gh {
  const attempts = Math.max(1, Math.min(opts.attempts ?? FETCH_ATTEMPTS, 5));
  const backoff = opts.backoffMs ?? FETCH_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (args) => {
    if (!isRead(args)) return gh(args);
    let last = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await gh(args);
      } catch (error) {
        if (!isTransientGhError(error)) throw error;
        last = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0);
      }
    }
    throw new FetchDeferredError(attempts, last.slice(0, 200));
  };
}
