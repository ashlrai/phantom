/** Best-effort publication of passive, normalized app changes. */
import { randomUUID } from 'node:crypto';
import type { ChangeEvent, SummaryEvent } from '../../cli/fleet-apps-changes.js';
import { appendBusInbox } from './bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope, type BusJsonValue } from './bus-envelope.js';

export function createAppsChangesPublisher(root: string, append = appendBusInbox): (event: ChangeEvent | SummaryEvent) => boolean {
  const invocationId = randomUUID();
  let sequence = 0;
  return event => {
    sequence++;
    try {
      const fields: Record<string, BusJsonValue> = event.type === 'summary'
        ? { type: event.type, outcome: event.outcome, samples: event.samples, transitions: event.transitions }
        : { type: event.type, app: event.app, state: event.state, time: event.time };
      const envelope: BusEnvelope = {
        id: `apps-changes-${invocationId}-${sequence}`, from: 'apps-changes', to: 'leaders',
        priority: 'P2', ttl: 24 * 60 * 60 * 1000,
        body: { kind: 'apps-changes.event.v1', invocationId, sequence, ...fields },
      };
      if (!validateBusEnvelope(envelope).ok) return false;
      const result = append(envelope, { root });
      return result.status === 'posted' || result.status === 'duplicate';
    } catch { return false; }
  };
}
