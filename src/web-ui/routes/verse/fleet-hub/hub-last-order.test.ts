import { describe, expect, it } from 'vitest';
import { annotateAck } from '../fleet-inbox/inbox-ack-model.js';
import { readInboxEntries } from '../fleet-inbox/fleet-inbox-model.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { lastOrderLine } from './hub-last-order.js';

const now = Date.parse('2026-10-31T12:10:00Z');
const snapshot = (at: string, ageSeconds: number | null = 300, text = 'Check the fleet') => ({
  v: 1, generatedAt: '2026-10-31T12:10:00Z', leaders: ageSeconds === null ? [] : [{ label: 'leader', ageSeconds }],
  inbox: [{ at, source: 'Telegram bot', text }],
} as FleetRuns);

describe('lastOrderLine', () => {
  it('shows seen when a leader passed after the order, using the inbox acknowledgement', () => {
    const runs = snapshot('2026-10-31 08:00');
    const result = lastOrderLine(runs, now);
    expect(result).toMatchObject({ at: '2026-10-31 08:00', sourceLabel: 'Telegram', excerpt: 'Check the fleet', ack: 'seen', label: 'Seen by the leaders', tone: 'success' });
    expect(result?.ack).toBe(annotateAck(readInboxEntries(undefined, runs).entries, runs, now)[0]?.ack);
  });

  it('shows waiting with the next-pass ETA for a newer order', () => {
    const runs = snapshot('2026-10-31 08:08');
    expect(lastOrderLine(runs, now)).toMatchObject({ ack: 'waiting', label: 'Waiting · next pass in ~10 min', tone: 'warning' });
    expect(lastOrderLine(runs, now)?.ack).toBe(annotateAck(readInboxEntries(undefined, runs).entries, runs, now)[0]?.ack);
  });

  it('marks a waiting order overdue', () => {
    expect(lastOrderLine(snapshot('2026-10-31 08:08', 1_200), now)).toMatchObject({ ack: 'waiting', label: 'Waiting · pass overdue by 5 min', tone: 'danger' });
  });

  it('reports unknown when there are no leader passes', () => {
    expect(lastOrderLine(snapshot('2026-10-31 08:08', null), now)).toMatchObject({ ack: 'unknown', label: 'No leader pass recorded', tone: 'neutral' });
  });

  it('returns null without inbox entries', () => {
    expect(lastOrderLine(null, now)).toBeNull();
    expect(lastOrderLine({ ...snapshot('2026-10-31 08:08'), inbox: [] }, now)).toBeNull();
  });

  it('selects the latest timestamp in either order and clips one-line excerpts', () => {
    const latest = { at: '2026-10-31 08:08', source: 'desktop', text: `Line one\r\n${'x'.repeat(100)}` };
    const older = { at: '2026-10-31 08:00', source: 'email', text: 'Older order' };
    for (const inbox of [[older, latest], [latest, older]]) {
      expect(lastOrderLine({ ...snapshot(latest.at), inbox }, now)).toMatchObject({
        at: latest.at, sourceLabel: 'Phantom desktop', excerpt: `Line one ${'x'.repeat(81)}`,
      });
    }
  });

  it('keeps the first snapshot entry when timestamps are equal', () => {
    const runs = snapshot('2026-10-31 08:08');
    runs.inbox.push({ ...runs.inbox[0]!, text: 'Earlier in the same minute' });
    expect(lastOrderLine(runs, now)?.excerpt).toBe('Check the fleet');
  });
});
