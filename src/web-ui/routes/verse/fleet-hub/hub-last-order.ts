import { annotateAck } from '../fleet-inbox/inbox-ack-model.js';
import { readInboxEntries } from '../fleet-inbox/fleet-inbox-model.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';

export function lastOrderLine(runs: FleetRuns | null, nowMs: number) {
  const { entries } = readInboxEntries(undefined, runs);
  // The snapshot reader returns newest first, including for timestamps in the same minute.
  const newest = entries.reduce<(typeof entries)[number] | undefined>((latest, entry) =>
    !latest || (entry.at !== '—' && (latest.at === '—' || entry.at > latest.at)) ? entry : latest, undefined);
  if (!newest) return null;
  const entry = annotateAck([newest], runs, nowMs)[0]!;
  const label = entry.ack === 'seen' ? 'Seen by the leaders'
    : entry.ack === 'waiting' ? entry.ackLabel : 'No leader pass recorded';
  const tone = entry.ack === 'seen' ? 'success' : entry.ack === 'unknown' ? 'neutral'
    : entry.eta.kind === 'overdue' ? 'danger' : 'warning';
  return { at: entry.at, sourceLabel: entry.sourceLabel, excerpt: entry.text.replace(/\s+/g, ' ').trim().slice(0, 90),
    ack: entry.ack, label, tone } as const;
}
