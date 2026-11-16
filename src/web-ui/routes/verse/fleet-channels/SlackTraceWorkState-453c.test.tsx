import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { narrowSlackTrace } from './slack-trace-model.js';
import { SlackTraceBody } from './SlackTraceCard.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-15T12:00:00Z');
const row = (outcome: string, ts: string) => ({
  at: '2026-11-15T11:00:00.000Z', channelId: 'C0AGENTS', threadTs: ts, messageTs: ts, ingress: 'posted', outcome });
const view = narrowSlackTrace({
  asOf: '2026-11-15T12:00:00.000Z',
  rows: [row('answered', '1731400000.000100'), row('answered', '1731400000.000200')],
  counts: { total: 2, answered: 2, uncertain: 0, busFailed: 0, unanswered: 0 },
  sources: { journal: 'ok', sends: 'ok' }, truncated: false })!;
const board = { inbox: 'ok', truncated: false, items: [
  { id: 'wi-1', channel: 'slack', channelRef: 'T0TEAM/C0AGENTS/1731400000.000100', state: 'RUNNING', owner: 'atlas' }] };

it('shows work state per row, including answered-but-no-work-item', () => {
  render(<SlackTraceBody view={view} nowMs={NOW} board={board} />);
  expect(screen.getByRole('columnheader', { name: 'Work' })).toBeInTheDocument();
  expect(screen.getByText('RUNNING').closest('td')).toHaveTextContent('RUNNING · atlas');
  expect(screen.getByText('no work item')).toBeInTheDocument();
});

it('shows unknown when the board is unreadable', () => {
  render(<SlackTraceBody view={view} nowMs={NOW} board={null} />);
  expect(screen.getAllByText('unknown')).toHaveLength(2);
});

it('omits the Work column without a board', () => {
  render(<SlackTraceBody view={view} nowMs={NOW} />);
  expect(screen.queryByRole('columnheader', { name: 'Work' })).toBeNull();
});
