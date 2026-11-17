import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { narrowSlackTrace } from './slack-trace-model.js';
import { SlackTraceBody } from './SlackTraceCard.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-15T12:00:00Z');
const row = (outcome: string, i: number, extra: object = {}) => ({
  at: '2026-11-15T11:00:00.000Z', channelId: 'C00000000', threadTs: `1700000000.00010${i}`,
  messageTs: `1700000000.00010${i}`, ingress: 'posted', outcome, ...extra });
const raw = (over: object = {}) => ({
  asOf: '2026-11-15T12:00:00.000Z',
  rows: [row('answered', 1, { replyTs: '1700000001.000200' }), row('uncertain', 2), row('bus-failed', 3, { ingress: 'failed' }), row('unanswered', 4)],
  counts: { total: 4, answered: 1, uncertain: 1, busFailed: 1, unanswered: 1 },
  sources: { journal: 'ok', sends: 'ok' }, truncated: false, ...over });
const view = (over?: object) => narrowSlackTrace(raw(over))!;

it('renders the four outcome labels with thread and reply ts', () => {
  render(<SlackTraceBody view={view()} nowMs={NOW} />);
  for (const l of ['ANSWERED', 'UNCERTAIN', 'BUS-FAILED', 'UNANSWERED']) expect(screen.getByText(l)).toBeInTheDocument();
  expect(screen.getByText('1700000001.000200')).toBeInTheDocument();
  expect(screen.getByText('1700000000.000101')).toBeInTheDocument();
  expect(screen.getByText(/4 requests · 1 answered/)).toBeInTheDocument();
});

it('flags a degraded source as incomplete and never shows an all-clear', () => {
  render(<SlackTraceBody view={view({ sources: { journal: 'ok', sends: 'degraded' }, rows: [row('answered', 1, { replyTs: '1700000001.000200' })], counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 } })} nowMs={NOW} />);
  expect(screen.getByText(/evidence incomplete \(journal=ok sends=degraded\)/)).toBeInTheDocument();
  expect(screen.queryByText(/all answered|all clear|0 unanswered/i)).toBeNull();
});

it('shows zero rows as no evidence, not all answered', () => {
  render(<SlackTraceBody view={view({ rows: [], counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 } })} nowMs={NOW} />);
  expect(screen.getByText(/No Slack request evidence/)).toBeInTheDocument();
  expect(screen.queryByText(/all answered/i)).toBeNull();
});

it('rejects malformed bodies and unknown outcomes', () => {
  expect(narrowSlackTrace({})).toBeNull();
  expect(narrowSlackTrace(raw({ rows: [row('routed', 1)] }))!.rows).toHaveLength(0);
});
