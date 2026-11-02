import { createHash } from 'node:crypto';
import { validateBusEnvelope } from './bus-envelope.js';
import { appendBusInbox, type BusInboxOptions } from './bus-inbox.js';
import type { PlannerCycleReport } from './planner-cycle.js';
import { scrubSecrets } from '../util/scrub.js';

const TTL_MS = 86_400_000;
export interface CycleRoute { runId: string; from: string; to: string }

/** Validate caller labels using the wire contract before starting any pass. */
export function validCycleRoute(route: CycleRoute): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(route.runId) &&
    scrubSecrets(route.runId) === route.runId && validateBusEnvelope({
      id: route.runId, from: route.from, to: route.to, priority: 'P3', ttl: TTL_MS, body: null,
    }).ok;
}

/** Only bounded structured facts leave the process; never forward diagnostic text. */
export function publishCycleResult(route: CycleRoute, report: PlannerCycleReport, options: BusInboxOptions) {
  const provider = report.execution.provider;
  const safeProvider = provider && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider) &&
    scrubSecrets(provider) === provider ? provider : null;
  const envelope = {
    id: `planner-cycle-${createHash('sha256').update(route.runId).digest('hex')}`,
    from: route.from, to: route.to, priority: 'P3', ttl: TTL_MS,
    body: {
      schema: 'planner-cycle-result.v1', runId: route.runId, verdict: report.verdict,
      execution: { outcome: report.execution.outcome, provider: safeProvider, exitCode: report.execution.exitCode },
      evidence: { state: report.evidence.state, counts: report.evidence.counts, attribution: 'observational' },
    },
  };
  // appendBusInbox checks the complete envelope and the store's capacity.
  const result = appendBusInbox(envelope, options);
  return { status: result.status };
}
