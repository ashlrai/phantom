/**
 * Shared CLI presentation helpers — ANSI palette, TTY-gated colorizers, and
 * fixed-width padding. Extracted from the per-command CLI modules where the
 * exact same blocks were duplicated verbatim.
 *
 * Behavior is identical to the inlined versions:
 *   - colorize() returns the input unchanged when the relevant stream is not a
 *     TTY (callers pass the stdout- or stderr-bound flag).
 *   - stripAnsi() strips SGR escape codes for visible-width measurement.
 *   - pad() pads to a visible width, left- (default) or right-aligned.
 */

/** Canonical ANSI palette (superset of every per-command color set). */
export const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
} as const;

/** True when stdout is a TTY. */
export function isTty(): boolean {
  return process.stdout.isTTY === true;
}

/** True when stderr is a TTY. */
export function isStderrTty(): boolean {
  return process.stderr.isTTY === true;
}

/** Strip ANSI SGR escape codes (for measuring visible display width). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Pad a possibly-ANSI-colored string to a visible width.
 * Default alignment is 'left' (append spaces); 'right' prepends them.
 */
export function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const vis = stripAnsi(s).length;
  const spaces = Math.max(0, width - vis);
  return align === 'left' ? s + ' '.repeat(spaces) : ' '.repeat(spaces) + s;
}

/** A bound set of colorizers gated on a single (stdout- or stderr-) TTY flag. */
export interface Colors {
  colorize: (code: string, s: string) => string;
  bold:    (s: string) => string;
  dim:     (s: string) => string;
  red:     (s: string) => string;
  green:   (s: string) => string;
  yellow:  (s: string) => string;
  blue:    (s: string) => string;
  cyan:    (s: string) => string;
  magenta: (s: string) => string;
  gray:    (s: string) => string;
}

/**
 * True when the user asked for no color (https://no-color.org): NO_COLOR is
 * set to any non-empty value. It wins over every other signal, including a
 * caller that colors unconditionally.
 */
export function noColorRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['NO_COLOR'];
  return value !== undefined && value !== '';
}

/**
 * The raw palette for lines that splice `${C.red}…${C.reset}` directly. Each
 * code reads NO_COLOR when the line is built, so those lines honour it the
 * same way makeColors() does; without NO_COLOR they are unchanged.
 */
export const ansi: { readonly [K in keyof typeof C]: string } = Object.defineProperties(
  {},
  Object.fromEntries(
    (Object.keys(C) as Array<keyof typeof C>).map((key) => [
      key,
      { enumerable: true, get: (): string => (noColorRequested() ? '' : C[key]) },
    ]),
  ),
) as { readonly [K in keyof typeof C]: string };

/**
 * Build a colorizer set bound to a TTY flag. When `tty` is false, or NO_COLOR
 * is set, every helper returns its input unchanged.
 */
export function makeColors(tty: boolean, env: NodeJS.ProcessEnv = process.env): Colors {
  const on = tty && !noColorRequested(env);
  const colorize = (code: string, s: string): string => (on ? `${code}${s}${C.reset}` : s);
  return {
    colorize,
    bold:    (s) => colorize(C.bold,    s),
    dim:     (s) => colorize(C.dim,     s),
    red:     (s) => colorize(C.red,     s),
    green:   (s) => colorize(C.green,   s),
    yellow:  (s) => colorize(C.yellow,  s),
    blue:    (s) => colorize(C.blue,    s),
    cyan:    (s) => colorize(C.cyan,    s),
    magenta: (s) => colorize(C.magenta, s),
    gray:    (s) => colorize(C.gray,    s),
  };
}
