import { readLatestClaudeRateLimitEvent, type ClaudeRateLimitEvent } from './claude-rate-limit-event.js';
import { readCodexUsage, type CodexUsageReading } from './readers/codex-usage.js';
import type { UsagePool } from './usage-signal-writer.js';

/**
 * Built-in readers for the 2-hourly router usage append. Each pool has exactly one
 * documented, non-interactive source; nothing else is ever executed or opened.
 *  - codex-cmp: the Codex App Server `account/rateLimits/read` exchange
 *    (`codex app-server --stdio`, fixed argv, explicit CMP pool HOME) in readers/codex-usage.ts.
 *  - claude-max: Phantom's own sanitized `rate_limit_event` store under ~/.ashlr/fabric,
 *    fed by Claude CLI stream-json output. Never ~/.claude, keychain or env.
 * Devin, Grok and Cursor have no documented status output that fits the strict journal
 * schema, so they stay unread (null) rather than scraped. Output is numeric fields only.
 */
export const STATUS_READER_POOLS = ['codex-cmp', 'claude-max'] as const satisfies readonly UsagePool[];
export type StatusReaderPool = typeof STATUS_READER_POOLS[number];

export interface StatusReaderOptions {
  /** Explicit CMP pool HOME for the Codex reader. Missing means codex-cmp is unknown. */
  codexHome?: string;
  now?: () => Date;
  /** Test seams; default to the real readers. */
  readCodex?: (home: string | undefined) => Promise<Pick<CodexUsageReading, 'pctUsed' | 'resetAt'>>;
  readClaudeEvent?: (nowMs: number) => ClaudeRateLimitEvent | null;
}

/**
 * Claude's `utilization` is a 0..1 fraction. Anything else (percent-looking values,
 * expired windows, non-numbers) is unknown, never a guessed percentage.
 */
export function parseClaudeUsage(event: unknown, nowMs: number): { pctUsed: number | null; resetAt: string | null } {
  const none = { pctUsed: null, resetAt: null };
  if (event === null || typeof event !== 'object' || !Number.isFinite(nowMs)) return none;
  const { utilization, resetsAt } = event as Record<string, unknown>;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0 || utilization > 1 ||
    typeof resetsAt !== 'number' || !Number.isSafeInteger(resetsAt) || resetsAt * 1000 <= nowMs ||
    resetsAt > 253_402_300_799) return none;
  return { pctUsed: Math.round(utilization * 1000) / 10, resetAt: new Date(resetsAt * 1000).toISOString() };
}

export function statusReaders(options: StatusReaderOptions = {}): Record<StatusReaderPool, () => Promise<unknown>> {
  const now = options.now ?? (() => new Date());
  const readCodex = options.readCodex ?? ((home: string | undefined) => readCodexUsage(home ? { home } : {}));
  const readClaude = options.readClaudeEvent ?? ((nowMs: number) => readLatestClaudeRateLimitEvent({ nowMs }));
  return {
    'codex-cmp': async () => {
      const { pctUsed, resetAt } = await readCodex(options.codexHome);
      return { pool: 'codex-cmp', pctUsed, resetAt, source: 'codex-reader', fetchedAt: now().toISOString() };
    },
    'claude-max': async () => {
      const at = now();
      return { pool: 'claude-max', ...parseClaudeUsage(readClaude(at.getTime()), at.getTime()),
        source: 'claude-max-reader', fetchedAt: at.toISOString() };
    },
  };
}
