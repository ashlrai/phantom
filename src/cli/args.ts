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

/** The options one verb accepts: bare boolean flags and flags that take the next token as their value. */
export interface AllowedOptions {
  flags?: readonly string[];
  values?: readonly string[];
}

/** The first option a verb does not accept, with the message to print for it. */
export interface UnknownOption {
  token: string;
  kind: 'unknown' | 'missing-value';
  message: string;
}

/**
 * True when `token` reads as an option: it starts with `-`, is not a bare `-`
 * (conventionally stdin or a literal dash), and has no whitespace, so a quoted
 * prose argument such as `"- fix the header"` stays a positional.
 */
export function looksLikeOption(token: string): boolean {
  return token.length > 1 && token.startsWith('-') && !/\s/.test(token);
}

/**
 * Find the first option in `args` that the verb does not accept, before the
 * verb does any work. Tokens after a `--` separator are positionals and are
 * never checked. A value flag consumes the next token whatever it looks like
 * (callers read values with `args[i + 1]`), but a value flag at the end of
 * `args` is reported as missing its value. Returns `null` when every option is
 * accepted. Pure: no IO, no mutation of `args`.
 */
export function rejectUnknownOptions(args: readonly string[], allowed: AllowedOptions): UnknownOption | null {
  const flags = new Set(allowed.flags ?? []);
  const values = new Set(allowed.values ?? []);
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') return null;
    if (!looksLikeOption(token)) continue;
    if (values.has(token)) {
      if (i + 1 >= args.length) return { token, kind: 'missing-value', message: `option ${token} requires a value` };
      i++;
      continue;
    }
    if (flags.has(token)) continue;
    return { token, kind: 'unknown', message: `unknown option: ${token}` };
  }
  return null;
}
