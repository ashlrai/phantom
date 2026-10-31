/**
 * Rate-limit and reset lines from coding CLI output. A hit without a parseable
 * reset is fail-closed: the backend stays cooled down with no invented expiry.
 * Pure. Callers pass `nowMs`.
 */

const RESET_AT = /(?:reset(?:s| at)?|try again(?: after)?|until)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i;
const LIMITED = /rate limit|usage limit|too many requests|429|quota exceeded/i;

export interface CliCooldown {
  backend: string;
  /** ISO reset, or null when the CLI admitted a limit and no reset. */
  untilMs: number | null;
  reason: string;
}

export function parseCliCooldown(backend: string, text: string, nowMs: number): CliCooldown | null {
  if (!LIMITED.test(text)) return null;
  const stamp = RESET_AT.exec(text)?.[1];
  if (!stamp) {
    return { backend, untilMs: null, reason: 'rate limit reported without a reset time' };
  }
  const untilMs = Date.parse(stamp);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
    return { backend, untilMs: null, reason: 'rate limit reset was missing or already past' };
  }
  return { backend, untilMs, reason: `rate limit until ${new Date(untilMs).toISOString()}` };
}

export function cooldownActive(cooldown: CliCooldown | null, nowMs: number): boolean {
  if (!cooldown) return false;
  if (cooldown.untilMs === null) return true;
  return cooldown.untilMs > nowMs;
}
