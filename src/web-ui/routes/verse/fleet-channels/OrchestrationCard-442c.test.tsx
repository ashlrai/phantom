import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { toOrchestrationView } from './orchestration-model.js';
import { OrchestrationBody } from './OrchestrationCard.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-15T12:00:00Z');
const reserved = { job: 'RQ-RESERVED', specialist: 'planner', assignedAt: '2026-11-15T11:00:00.000Z' };
const raw = (over: object = {}) => ({ schemaVersion: 1, authority: 'none', source: 'ok', total: 2,
  truncated: false, counts: { reserved: 1, admitted: 0, complete: 1 }, unresolved: [reserved],
  receipts: [{ ...reserved, status: 'reserved' }, { job: 'RQ-COMPLETE', specialist: 'reviewer', status: 'complete', assignedAt: reserved.assignedAt }], ...over });
it('requires read-only authority and validates counts, source and assignments', () => {
  expect(toOrchestrationView(raw({ authority: undefined }))).toBeNull();
  expect(toOrchestrationView(raw({ authority: 'write' }))).toBeNull();
  for (const override of [{ counts: { reserved: -1 } }, { source: 'broken' }, { receipts: [{}] }, { unresolved: [{}] }]) {
    expect(toOrchestrationView(raw(override))).toBeNull();
  }
});
it('renders full counts, unresolved owners and receipt rows', () => {
  render(<OrchestrationBody view={toOrchestrationView(raw())!} nowMs={NOW} />);
  expect(screen.getByText('1 reserved · 0 admitted · 1 complete')).toBeInTheDocument();
  const unresolved = screen.getByRole('list', { name: 'Unresolved reservations' });
  expect(unresolved).toHaveTextContent('RQ-RESERVED · planner · 1h ago');
  expect(within(unresolved).getByText('1h ago')).toHaveAttribute('dateTime', reserved.assignedAt);
  const table = screen.getByRole('table', { name: 'Orchestration assignments' });
  for (const label of ['Job', 'Specialist', 'Status', 'Assigned', 'RQ-COMPLETE', 'reviewer', 'reserved', 'complete']) {
    expect(within(table).getByText(label)).toBeInTheDocument();
  }
});
it('shows the missing journal header', () => {
  const view = toOrchestrationView(raw({ source: 'missing', total: 0, counts: { reserved: 0, admitted: 0, complete: 0 }, unresolved: [], receipts: [] }))!;
  render(<OrchestrationBody view={view} nowMs={NOW} />);
  expect(screen.getByText('No orchestration journal yet')).toBeInTheDocument();
  expect(screen.queryByRole('table')).toBeNull();
});
