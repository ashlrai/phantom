/**
 * Shared --port validation and listen-error messages for the local web
 * commands (`phm serve`, `phm verse`). Pure helpers: callers keep their own
 * parsing loops and exit codes (2 for usage errors, 1 for runtime failures).
 */

/**
 * Validate a `--port` value as an integer in 1..65535.
 * Returns `{ n }` or `{ error }` with a user-facing message.
 */
export function parsePortArg(raw: string | undefined): { n: number } | { error: string } {
  const value = raw ?? '';
  if (!/^\d+$/.test(value)) {
    return { error: `Invalid --port "${raw ?? '(missing)'}": expected a number between 1 and 65535` };
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) {
    return { error: `Invalid --port "${value}": expected a number between 1 and 65535` };
  }
  return { n };
}

/**
 * Map a listen() failure to a one-line, actionable message. Returns null when
 * the error is not a known bind failure so callers fall back to their generic
 * message.
 */
export function describeListenError(err: unknown, port: number): string | null {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code === 'EADDRINUSE') {
    return `Port ${port} is already in use. Pass --port <other> or stop the process using it.`;
  }
  if (code === 'EACCES') {
    return `Permission denied binding port ${port}. Pass --port <other> (1024 or higher) or run with the needed privileges.`;
  }
  return null;
}
