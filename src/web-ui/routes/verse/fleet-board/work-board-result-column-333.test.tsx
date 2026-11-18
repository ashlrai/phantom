/**
 * work-board-result-column-333.test.tsx — RQ-PHX-BOARDRESULTCOLUMN333. The Result
 * column shows what verified or blocked a work item, as plain text; absent or
 * malformed results render an empty cell. Fake ids only.
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
    if (String(input).startsWith('/api/verse/fleet/work-board')) {
      return new Response(JSON.stringify({ items, inbox: 'ok', truncated: false, asOf: ago(0) }), { status: 200 });
    }
    return new Response(JSON.stringify({ schema: 'fleet.leader-board.v1', status: 'missing', ageSeconds: null, board: null }), { status: 200 });
  }));
}

function rowOf(idPrefix: string): HTMLElement {
  return screen.getByText(idPrefix).closest('tr') as HTMLElement;
}

/** Text of the Result cell (second column, right after State). */
function resultCell(idPrefix: string): HTMLElement {
  return rowOf(idPrefix).querySelectorAll('td')[1] as HTMLElement;
}

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('has a Result header after State', async () => {
  stub([item('wi-fake-hdr-0001', 'RECEIVED')]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('wi-fake-hdr-')).toBeInTheDocument());
  const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
  expect(headers.indexOf('Result')).toBe(headers.indexOf('State') + 1);
});

it('shows PR and a shortened head with the full head in title', async () => {
  const head = 'fakehead333abcdef';
  stub([item('wi-fake-ver-0002', 'VERIFIED', { owner: 'a', result: { kind: 'verified', pr: 7, head, tests: null, artifact: null } })]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('wi-fake-ver-')).toBeInTheDocument());
  const cell = within(rowOf('wi-fake-ver-')).getByText('PR #7 @fakehead');
  expect(cell).toHaveAttribute('title', head);
});

it('shows tests and artifact text', async () => {
  stub([
    item('wi-fake-tst-0003', 'VERIFIED', { result: { kind: 'verified', pr: null, head: null, tests: '12 passed', artifact: null } }),
    item('wi-fake-art-0004', 'VERIFIED', { result: { kind: 'verified', pr: null, head: null, tests: null, artifact: 'fake.log' } }),
  ]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('wi-fake-tst-')).toBeInTheDocument());
  expect(within(rowOf('wi-fake-tst-')).getByText('tests: 12 passed')).toBeInTheDocument();
  expect(within(rowOf('wi-fake-art-')).getByText('artifact: fake.log')).toBeInTheDocument();
});

it('shows what a BLOCKED row waits on', async () => {
  stub([item('wi-fake-blk-0005', 'BLOCKED', { result: { kind: 'blocked', dependency: 'fake dep' } })]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('wi-fake-blk-')).toBeInTheDocument());
  expect(within(rowOf('wi-fake-blk-')).getByText('blocked on: fake dep')).toBeInTheDocument();
});

it('older payloads without result render an empty Result cell', async () => {
  stub([item('wi-fake-old-0006', 'VERIFIED', { owner: 'a' })]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('wi-fake-old-')).toBeInTheDocument());
  expect(resultCell('wi-fake-old-').textContent).toBe('');
});

it('malformed results render empty and do not crash', async () => {
  stub([
    item('wi-fake-bad-0007', 'VERIFIED', { result: { kind: 'mystery', dependency: 'x' } }),
    item('wi-fake-bad-0008', 'BLOCKED', { result: { kind: 'blocked', dependency: 42 } }),
    item('wi-fake-bad-0009', 'VERIFIED', { result: { kind: 'verified', pr: 'seven', head: 5, tests: {}, artifact: [] } }),
    item('wi-fake-bad-0010', 'VERIFIED', { result: 'nope' }),
  ]);
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getAllByText('wi-fake-bad-')).toHaveLength(4));
  for (const id of ['wi-fake-bad-0007', 'wi-fake-bad-0008', 'wi-fake-bad-0009', 'wi-fake-bad-0010']) {
    const row = screen.getByText(id.slice(0, 12), { selector: `td[title="${id}"]` }).closest('tr') as HTMLElement;
    expect(row.querySelectorAll('td')[1]!.textContent).toBe('');
  }
});

it('renders markup in a dependency as literal text', async () => {
  stub([item('wi-fake-xss-0011', 'BLOCKED', { result: { kind: 'blocked', dependency: '<b>x</b>' } })]);
  const { container } = render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('blocked on: <b>x</b>')).toBeInTheDocument());
  expect(container.querySelector('b')).toBeNull();
});
