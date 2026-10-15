/**
 * Shared CLI argument-parsing helpers.
 *
 * Extracted from the per-command parsers where the same validated-flag idioms
 * were repeated. These are pure validators — callers keep their own loop and
 * index handling, so control flow is unchanged.
 */

/**
 * Validate a flag value as a positive integer.
 *
 * Returns `{ n }` on success or `{ error }` with the canonical message
 * (`--<name> requires a positive integer, got: <raw|(missing)>`) on failure.
 * Mirrors the inline `parseInt(...,10)` + `isNaN || <= 0` checks the command
 * parsers used, including the `(missing)` placeholder for an absent value.
 */
export function parsePositiveInt(
  name: string,
  raw: string | undefined,
): { n: number } | { error: string } {
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (isNaN(n) || n <= 0) {
    return { error: `--${name} requires a positive integer, got: ${raw ?? '(missing)'}` };
  }
  return { n };
}

/** `--port N`: an integer TCP port, 1..65535 (a larger value used to surface as a RangeError at listen time). */
export function parsePort(raw: string | undefined): { n: number } | { error: string } {
  const n = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return { error: `--port requires a port number from 1 to 65535, got: ${raw ?? '(missing)'}` };
  }
  return { n };
}

/** One readable line for a local server that failed to start (port taken, no permission). */
export function serverStartErrorMessage(err: unknown, port: number | undefined): string {
  const code = (err as { code?: unknown } | null)?.code;
  const where = port ? `port ${port}` : 'the requested port';
  if (code === 'EADDRINUSE') return `${where} is already in use; pick another with --port N or stop the process using it.`;
  if (code === 'EACCES') return `no permission to listen on ${where}; use a port above 1023.`;
  return 'Failed to start server: ' + String(err);
}
