import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetInboxPane } from './FleetInboxPane.js';
import { readInboxEntries } from './fleet-inbox-model.js';
import { fleetRunsQuery } from './fleet-inbox-queries.js';

vi.mock('../../../data/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../data/client.js')>();
  return { ...actual, apiGet: vi.fn() };
});

const props: PaneProps = {
  paneId: 'fleet-inbox', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};
const entries = [
  { text: 'Acknowledged order', source: 'telegram', channel: 'desktop', id: 'one', ack: 'acked' },
  { text: 'Skipped order', source: 'desktop', ack: 'skipped' },
  { text: 'Pending order', source: 'desktop', ack: 'pending' },
  { text: 'Legacy order', source: 'desktop' },
  { text: 'Caught up order', source: 'desktop', at: '2026-10-31 00:13' },
];
beforeEach(() => {
  evictAll(); sessionStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T04:20:00Z'));
  vi.mocked(apiGet).mockImplementation(async path => path.includes('/inbox?')
    ? { v: 1, sourceState: 'healthy', entries: entries.map(entry => ({ at: '2026-10-31 00:16', priority: 'P0', ...entry })) }
    : { v: 1, generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 300 }] });
});
afterEach(() => { cleanup(); clearMutationToken(); vi.restoreAllMocks(); });

it('prefers planner acknowledgements and counts only timing-based waiting entries', async () => {
  render(<FleetInboxPane {...props} />);
  await screen.findByText('Acknowledged order');
  const chip = (order: string, label: string) => within(screen.getByText(order).closest('article')!).getByText(label);
  expect(chip('Acknowledged order', 'Acknowledged on Phantom desktop')).toHaveAttribute('data-ack', 'acked');
  expect(chip('Skipped order', 'Planner saw it · no reply route')).toHaveAttribute('data-ack', 'skipped');
  for (const order of ['Pending order', 'Legacy order']) {
    expect(chip(order, 'Waiting · next pass in ~10 min')).toHaveAttribute('data-ack', 'waiting');
  }
  expect(chip('Caught up order', 'Seen by a leader pass')).toHaveAttribute('data-ack', 'seen');
  expect(screen.getByText('2 waiting for a leader pass')).toBeInTheDocument();
  await act(() => refetchQuery(fleetRunsQuery.key, async () => ({
    v: 1, generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 60 }],
  }), true));
  expect(screen.queryByText(/waiting for a leader pass/)).not.toBeInTheDocument();
  expect(chip('Acknowledged order', 'Acknowledged on Phantom desktop')).toHaveAttribute('data-ack', 'acked');
  expect(chip('Pending order', 'Seen by a leader pass')).toHaveAttribute('data-ack', 'seen');
});

it('ignores malformed optional fields and unknown acknowledgement values', () => {
  const read = (fields: object) => readInboxEntries({ v: 1, entries: [{ text: 'Order', ...fields }] }, undefined).entries[0];
  expect(read({ id: 3, channel: {}, ack: 'unexpected' })).toEqual({ at: '—', source: '—', priority: '—', text: 'Order' });
  expect(read({ ack: ['acked'] })).not.toHaveProperty('plannerAck');
  expect(read({ id: 'one', channel: 'telegram', ack: 'pending' })).toMatchObject({ id: 'one', channel: 'telegram', plannerAck: 'pending' });
});

it('uses the ledger label and keeps the inferred label when no ledger row exists', async () => {
  vi.mocked(apiGet).mockImplementation(async path => path.endsWith('/inbox/acks')
    ? { v: 1, available: true, acks: [{ entryId: 'one', status: 'acked' }] }
    : path.includes('/inbox?') ? { v: 1, sourceState: 'healthy', entries: [
      { at: '2026-10-31 00:13', source: 'desktop (one)', priority: 'P0', text: 'Seen order' },
      { at: '2026-10-31 00:16', source: 'telegram', priority: 'P0', text: 'Waiting order' },
    ] }
    : { v: 1, generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 300 }] });
  render(<FleetInboxPane {...props} />);
  const acked = (await screen.findByText('Seen order')).closest('article')!;
  expect(await within(acked).findByText('Acked by planner')).toBeInTheDocument();
  expect(within(screen.getByText('Waiting order').closest('article')!).getByText(/^Waiting ·/)).toBeInTheDocument();
});
