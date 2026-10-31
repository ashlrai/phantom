/**
 * otel-cost.ts — USD figures for native-client OTLP spans accepted by
 * `parseNativeOtelTrace` (see otlp.ts). Pure and deterministic: the sender's
 * reported cost is authoritative when present; otherwise usage is priced
 * from the same static table `estCostUsd` applies everywhere else.
 */

import type { ReceivedOtelSpan } from './otlp.js';
import { estCostUsd } from '../run/budget.js';

/**
 * Received-span source → the `estCostUsd` price-table key that represents it.
 * `claude-code` resolves to the Anthropic/claude row; `xai` matches no row and
 * prices at the conservative fallback — a wrong number invites scrutiny where
 * a zero ends it (see budget.ts).
 */
const COST_PROVIDER: Record<ReceivedOtelSpan['source'], string> = {
  'claude-code': 'claude',
  xai: 'xai',
};

/**
 * Split a span's cache-creation usage into (5m, 1h) write tokens.
 *
 * The split fields are authoritative. `cache_creation_tokens` is the merged
 * total the API bills as 5m + 1h combined: it fills whichever side the
 * stream omitted (the remainder after the declared side) and, when no split
 * was reported at all, prices as 5-minute writes — the provider default TTL.
 * It is NEVER added on top of the split fields, which already sum to it.
 */
function cacheWriteSplit(usage: ReceivedOtelSpan['usage']): { write5m: number; write1h: number } {
  const merged = usage.cache_creation_tokens;
  let write5m = usage.cache_creation_5m;
  let write1h = usage.cache_creation_1h;
  if (write5m === undefined && write1h === undefined) return { write5m: merged ?? 0, write1h: 0 };
  write1h ??= Math.max(0, (merged ?? 0) - (write5m ?? 0));
  write5m ??= Math.max(0, (merged ?? 0) - write1h);
  return { write5m, write1h };
}

/**
 * Best USD cost for a received span: `costUsd` as the sender reported it when
 * present, otherwise a static-table estimate. Returns undefined when the span
 * carries neither a reported cost nor any billable usage — an unknown cost
 * stays unknown and is never fabricated as $0.
 */
export function receivedCostUsd(span: ReceivedOtelSpan): number | undefined {
  if (span.costUsd !== undefined) return span.costUsd;
  const { write5m, write1h } = cacheWriteSplit(span.usage);
  const input = span.usage.input_tokens ?? 0;
  const output = span.usage.output_tokens ?? 0;
  const read = span.usage.cache_read_tokens ?? 0;
  if (input + output + read + write5m + write1h === 0) return undefined;
  return estCostUsd(COST_PROVIDER[span.source], input, output, read, write5m, write1h);
}
