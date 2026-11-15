import { readSlackRequestTrace, type SlackRequestTraceOptions } from './slack-request-trace.js';

/** A bounded local snapshot, not evidence of live task ownership or execution. */
export function readSlackEvidenceBundle(thread: string, options: SlackRequestTraceOptions & { maxAgeSeconds?: number } = {}) {
  const trace = readSlackRequestTrace({ ...options, thread });
  return {
    schema: 'phantom.fleet.slack-evidence.v1' as const,
    scope: 'Local journal and send evidence only; does not prove current runtime reachability, durable task ownership, or execution.',
    thread,
    ...trace,
    ...(options.maxAgeSeconds !== undefined ? {
      freshness: {
        maxAgeSeconds: options.maxAgeSeconds,
        verdict: trace.rows.length === 0 ? 'unknown' as const : trace.rows.every((row) => {
          const observed = Date.parse(row.at);
          const age = Date.parse(trace.asOf) - observed;
          return Number.isFinite(observed) && age >= 0 && age / 1000 <= options.maxAgeSeconds!;
        }) ? 'fresh' as const : 'stale' as const,
        basis: 'Persisted ingress observation times; asOf is collection time, not a live probe.',
      },
    } : {}),
  };
}
