import { expect, it } from 'vitest';
import { filterEntries, readInboxEntries } from '../src/web-ui/routes/verse/fleet-inbox/fleet-inbox-model.js';
import { partitionInboxNoise } from '../src/web-ui/routes/verse/fleet-inbox/inbox-noise-model.js';

it('partitions filtered inbox entries without losing planner receipts or changing the snapshot', () => {
  const snapshot = {
    v: 1, sourceState: 'healthy', entries: [
      { id: 'fake-order', at: '2026-01-02 09:00', source: 'Slack', channel: 'slack', priority: 'P0', ack: 'acked', text: 'Review fake patch and report status' },
      { id: 'fake-ask', at: '2026-01-02 08:00', source: 'Slack', channel: 'slack', priority: 'P0', ack: 'pending', text: 'Phantom status?' },
      { id: 'fake-misfire', at: '2026-01-02 07:00', source: 'Slack', channel: 'slack', priority: 'P0', ack: 'skipped', text: '--help' },
      { id: 'fake-other', at: '2026-01-02 06:00', source: 'terminal', priority: 'P0', text: 'status' },
    ],
  };
  const before = structuredClone(snapshot);
  const inbox = readInboxEntries(snapshot, undefined);
  const filtered = filterEntries(inbox.entries, { source: 'Slack', text: '' });
  const { orders, noise } = partitionInboxNoise(filtered);

  expect(orders).toEqual([expect.objectContaining({ id: 'fake-order', plannerAck: 'acked', channel: 'slack' })]);
  expect(noise).toEqual([
    expect.objectContaining({ id: 'fake-ask', plannerAck: 'pending' }),
    expect.objectContaining({ id: 'fake-misfire', plannerAck: 'skipped' }),
  ]);
  expect(orders[0]).toBe(filtered[0]);
  expect(noise[0]).toBe(filtered[1]);
  expect(partitionInboxNoise(filterEntries(inbox.entries, { source: 'Slack', text: 'status' })).noise)
    .toEqual([noise[0]]);
  expect(inbox.entries).toHaveLength(4);
  expect(snapshot).toEqual(before);
});
