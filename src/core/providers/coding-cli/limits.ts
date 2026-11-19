/**
 * Rate-limit and reset lines from captured coding-CLI output. Recovered from closed PR #5952
 * (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886): parser and cooldown predicate only. A limit
 * without a parseable future reset stays active with unknown expiry; nothing here invents a
 * reset or proves allowance. Pure; callers pass `nowMs`.
 */

const RESET_AT = /(?:reset(?:s| at)?|try again(?: after)?|until)\s*(?:[:=]\s*)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i;
// Single-pass group, not `\s*[:=]?\s*`: the adjacent `\s*` pair backtracks
// quadratically on long runs of whitespace after a "reset" word.
const LIMITED = /rate limit|usage limit|too many requests|429|quota exceeded/i;

export interface CliCooldown {
  backend: string;
  /** Epoch ms of a reset strictly after the observation; null when unknown. */
  untilMs: number | null;
  /** Built from parser output only, never captured text. */
  reason: string;
}

/**
 * Returns null when the captured text shows no limit line (no cooldown
 * evidence). A limit line with no reset, or with a reset at or before nowMs,
 * returns untilMs null: the backend is limited and its expiry is unknown.
 */
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

/** A known reset expires exactly at its timestamp; an unknown reset stays active. */
export function cooldownActive(cooldown: CliCooldown | null, nowMs: number): boolean {
  if (!cooldown) return false;
  if (cooldown.untilMs === null) return true;
  return cooldown.untilMs > nowMs;
}
