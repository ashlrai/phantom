import { isSlackChannelId } from './slack-network.js';
import { readSlackRequestTrace, type SlackRequestTraceOptions, type SlackTraceRow } from './slack-request-trace.js';

function countRows(rows: readonly SlackTraceRow[]) {
  const counts = { total: rows.length, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 };
  for (const row of rows) {
    if (row.outcome === 'answered') counts.answered++;
    else if (row.outcome === 'uncertain') counts.uncertain++;
    else if (row.outcome === 'bus-failed') counts.busFailed++;
    else counts.unanswered++;
  }
  return counts;
}

/** A bounded local snapshot, not evidence of live task ownership or execution. */
export function readSlackEvidenceBundle(thread: string, options: SlackRequestTraceOptions & { maxAgeSeconds?: number; channelId?: string } = {}) {
  if (options.channelId !== undefined && !isSlackChannelId(options.channelId)) throw new Error('slack-channel-invalid');
  const { maxAgeSeconds, channelId, ...traceOptions } = options;
  const trace = readSlackRequestTrace({ ...traceOptions, thread });
  const rows = channelId === undefined ? trace.rows : trace.rows.filter((row) => row.channelId === channelId);
  const scoped = { ...trace, rows, counts: countRows(rows) };
  return {
    schema: 'phantom.fleet.slack-evidence.v1' as const,
    scope: 'Local journal and send evidence only; does not prove current runtime reachability, durable task ownership, or execution.',
    thread,
    ...scoped,
    ...(maxAgeSeconds !== undefined ? {
      freshness: {
        maxAgeSeconds,
        verdict: rows.length === 0 ? 'unknown' as const : rows.every((row) => {
          const observed = Date.parse(row.at);
          const age = Date.parse(trace.asOf) - observed;
          return Number.isFinite(observed) && age >= 0 && age / 1000 <= maxAgeSeconds;
        }) ? 'fresh' as const : 'stale' as const,
        basis: 'Persisted ingress observation times; asOf is collection time, not a live probe.',
      },
    } : {}),
  };
}
