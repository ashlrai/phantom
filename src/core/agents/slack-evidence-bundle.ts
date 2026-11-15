import { readSlackRequestTrace, type SlackRequestTraceOptions } from './slack-request-trace.js';

/** A bounded local snapshot, not evidence of live task ownership or execution. */
export function readSlackEvidenceBundle(thread: string, options: SlackRequestTraceOptions = {}) {
  const trace = readSlackRequestTrace({ ...options, thread });
  return {
    schema: 'phantom.fleet.slack-evidence.v1' as const,
    scope: 'Local journal and send evidence only; does not prove current runtime reachability, durable task ownership, or execution.',
    thread,
    ...trace,
  };
}
