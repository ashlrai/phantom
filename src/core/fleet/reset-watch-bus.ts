/** Best-effort, evidence-free watcher state on the shared bus. */
import { createHash, randomUUID } from 'node:crypto';
import { appendBusInbox } from './bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';
import type { ResetWatchRecord } from './reset-release-watch.js';

export function createResetWatchPublisher(root: string, append = appendBusInbox): (record: ResetWatchRecord | 'start') => boolean {
  const invocationId = randomUUID();
  let sequence = 0, prior: string | undefined;
  return record => {
    try {
      let body: BusEnvelope['body'];
      let state: string | undefined;
      if (record === 'start') {
        body = { kind: 'reset-watch.start.v1', invocationId };
      } else if (record.type === 'pass') {
        // Hash each complete error so changed errors are observable without publishing
        // provider messages, paths, or lane labels supplied by an external source.
        const errors = record.errors.map(error => createHash('sha256')
          .update(JSON.stringify([error.lane, error.message])).digest('hex')).sort();
        state = JSON.stringify(errors);
        if (record.released === 0 && state === prior) return true;
        body = { kind: 'reset-watch.pass.v1', invocationId, healthy: errors.length === 0,
          checked: record.checked, released: record.released, errors };
      } else {
        body = { kind: 'reset-watch.end.v1', invocationId, outcome: record.outcome,
          passes: record.passes, released: record.released, errors: record.errors };
      }
      const envelope: BusEnvelope = { id: `reset-watch-${invocationId}-${sequence++}`,
        from: 'reset-watch', to: 'leaders', priority: 'P2', ttl: 24 * 60 * 60 * 1000, body };
      if (!validateBusEnvelope(envelope).ok) return false;
      const result = append(envelope, { root });
      const success = result.status === 'posted' || result.status === 'duplicate';
      if (success && state !== undefined) prior = state;
      return success;
    } catch { return false; }
  };
}
