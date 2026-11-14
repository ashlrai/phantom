/**
 * work-board-owner-column-323.test.tsx — RQ-PHX-WORKBOARDOWNERCOL323. Owner and
 * claim receipt columns on the work board, the honesty rule (state without a
 * named owner reads "owner missing"), and plain-text rendering. Fake ids only.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBoardPane } from './FleetBoardPane.js';

const PROPS = { visible: true } as PaneProps;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function item(id: string, state: string, extra: Record<string, unknown> = {}) {
  return { id, channel: 'telegram', channelRef: 'ref-1', receivedAt: ago(5 * 60_000), state, asOf: ago(0), source: 'bus', missing: [], ...extra };
}

function stub(items: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/fleet/work-board')) {
      return new Response(JSON.stringify({ items, inbox: 'ok', truncated: false, asOf: ago(0) }), { status: 200 });
    }
    return new Response(JSON.stringify({ schema: 'fleet.leader-board.v1', status: 'missing', ageSeconds: null, board: null }), { status: 200 });
  }));
}

function rowOf(idPrefix: string): HTMLElement {
  return screen.getByText(idPrefix).closest('tr') as HTMLElement;
}

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('renders owner and a shortened receipt with the full value in title', async () => {
  const receipt = 'claim:0123456789abcdef0123456789abcdef';
  stub([item('wi-fake-own-0001', 'ASSIGNED', { owner: 'claude-lane-7', claimReceipt: receipt })]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('wi-fake-own-')).toBeInTheDocument());
  const row = within(rowOf('wi-fake-own-'));
  expect(row.getByText('claude-lane-7')).toBeInTheDocument();
  const cell = row.getByText(receipt.slice(0, 24));
  expect(cell).toHaveAttribute('title', receipt);
  expect(receipt.slice(0, 24)).not.toBe(receipt);
});

it('older payloads without the fields show unassigned / none', async () => {
  stub([item('wi-fake-old-0002', 'RECEIVED')]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('wi-fake-old-')).toBeInTheDocument());
  const row = within(rowOf('wi-fake-old-'));
  expect(row.getByText('unassigned')).toBeInTheDocument();
  expect(row.getByText('none')).toBeInTheDocument();
});

it('a RUNNING row with a null owner reads "owner missing"', async () => {
  stub([item('wi-fake-run-0003', 'RUNNING', { owner: null, claimReceipt: null })]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('wi-fake-run-')).toBeInTheDocument());
  const row = within(rowOf('wi-fake-run-'));
  expect(row.getByText('owner missing')).toBeInTheDocument();
  expect(row.queryByText('unassigned')).toBeNull();
});

it('a non-string owner is treated as null', async () => {
  stub([item('wi-fake-num-0004', 'ASSIGNED', { owner: 42 }), item('wi-fake-rcv-0005', 'RECEIVED', { owner: 42 })]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('wi-fake-num-')).toBeInTheDocument());
  expect(within(rowOf('wi-fake-num-')).getByText('owner missing')).toBeInTheDocument();
  expect(within(rowOf('wi-fake-rcv-')).getByText('unassigned')).toBeInTheDocument();
  expect(screen.getByText('0 of 2 items have a named owner')).toBeInTheDocument();
});

it('prints the named-owner count line', async () => {
  stub([
    item('wi-fake-a-0006', 'ASSIGNED', { owner: 'alice' }),
    item('wi-fake-b-0007', 'RECEIVED'),
    item('wi-fake-c-0008', 'RUNNING', { owner: '' }),
  ]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('1 of 3 items have a named owner')).toBeInTheDocument());
});

it('renders a receipt containing markup as literal text', async () => {
  stub([item('wi-fake-xss-0009', 'ASSIGNED', { owner: 'bob', claimReceipt: '<b>x</b>' })]);
  const { container } = render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('<b>x</b>')).toBeInTheDocument());
  expect(container.querySelector('b')).toBeNull();
});
