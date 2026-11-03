/** Metadata-only, best-effort delivery of batch verdicts to the durable bus. */
import { randomUUID } from 'node:crypto';
import { appendBusInbox } from './bus-inbox.js';
import { validateBusEnvelope } from './bus-envelope.js';
import type { appsRecoveryVerdict } from './apps-recovery-verdict.js';

type Verdict = ReturnType<typeof appsRecoveryVerdict>;
type Outcome = 'healthy' | 'terminal' | 'timeout' | 'cancelled' | 'unavailable' | 'stopped';
export function createAppsRecoveryBatchPublisher(root: string, ids: string[], append = appendBusInbox) {
  const batchRunId = randomUUID();
  let lastKey: string | undefined, sequence = 0;
  const counts = { published: 0, failed: 0 };
  function publish(kind: 'progress' | 'summary', verdicts: Verdict[] | null, outcome?: Outcome): void {
    // Copy only bounded, validated projection fields, never retained evidence text.
    const states = verdicts?.map(v => ({ invocationId: v.invocationId, verdict: v.verdict,
      latestCursor: v.latestCursor, terminalOutcome: v.terminalOutcome, truncated: v.truncated })) ?? null;
    const key = JSON.stringify(states);
    if (kind === 'progress' && key === lastKey) return;
    if (kind === 'progress') lastKey = key;
    const envelope = {
      id: `apps-recovery-batch-${batchRunId}-${kind === 'progress' ? `progress-${++sequence}` : 'summary'}`,
      from: 'apps-recovery-batch', to: 'leaders', priority: 'P2', ttl: 24 * 60 * 60 * 1000,
      body: { kind: `apps-recovery-batch.${kind}.v1`, batchRunId, invocationIds: ids,
        evidence: 'retained', liveProbe: false, verdicts: states, ...(outcome ? { outcome } : {}) },
    };
    try {
      const checked = validateBusEnvelope(envelope);
      if (checked.ok && ['posted', 'duplicate'].includes(append(checked.value, { root }).status)) counts.published++;
      else counts.failed++;
    } catch { counts.failed++; }
  }
  return { publish, counts };
}
