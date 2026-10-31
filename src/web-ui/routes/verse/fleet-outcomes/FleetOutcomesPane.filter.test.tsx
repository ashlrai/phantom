import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll, invalidate } from '../../../data/cache.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetOutcomesPane } from './FleetOutcomesPane.js';

vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

const ZERO = { 'producer-succeeded': 0, failed: 0, cancelled: 0, refused: 0, 'empty-diff': 0, disabled: 0, unknown: 0 };
const produced = (caseId: string, endedAt: string) => ({ caseId, endedAt, outcome: 'producer-succeeded', failureKind: null, proposalRecorded: true });
const failed = (caseId: string, endedAt: string) => ({ caseId, endedAt, outcome: 'failed', failureKind: 'engine', proposalRecorded: false });
const producedCases = [
  produced('RQ-PHX-PRODUCED-A', '2026-10-31T11:00:00Z'),
  produced('RQ-PHX-PRODUCED-C', '2026-10-31T09:00:00Z'),
];

const feedback = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, sourceState: 'healthy', complete: true,
  window: { since: '2026-10-30T00:00:00Z', through: '2026-10-31T12:00:00Z' },
  observedThrough: '2026-10-31T12:00:00Z',
  counts: { ...ZERO, 'producer-succeeded': 2, failed: 1 },
  observedCounts: { ...ZERO, 'producer-succeeded': 2, failed: 1 },
  cases: [
    produced('RQ-PHX-PRODUCED-A', '2026-10-31T11:00:00Z'),
    failed('RQ-PHX-FAILED-B', '2026-10-31T10:00:00Z'),
    produced('RQ-PHX-PRODUCED-C', '2026-10-31T09:00:00Z'),
  ],
  digest: 'h:ab',
  coverage: { legacyRows: 0, invalidAttempts: 0, conflictingAttempts: 0, duplicateRows: 0, invalidTimestamps: 0, proposalSource: 'healthy' },
  ...overrides,
});
const read = (overrides: Record<string, unknown> = {}) =>
  ({ v: 1, state: 'current', refreshedAt: '2026-10-31T12:00:00Z', feedback: feedback(), ...overrides });

beforeEach(() => {
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(read())));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('filters the case list by the selected outcome chip', async () => {
  const openPane = vi.fn();
  const props = { visible: true, host: { openPane } } as unknown as PaneProps;
  render(<FleetOutcomesPane {...props} />);
  const group = within(await screen.findByRole('radiogroup', { name: 'Filter cases' }));
  expect(group.getAllByRole('radio').map(radio => radio.textContent)).toEqual(['All 3', 'Produced 2', 'Failed 1']);
  expect(within(screen.getByRole('list', { name: 'Cases' })).getAllByRole('listitem')).toHaveLength(3);
  fireEvent.click(group.getByRole('radio', { name: 'Failed 1' }));
  const rows = within(screen.getByRole('list', { name: 'Cases' })).getAllByRole('listitem');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent('Failed');
  fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Open worker log' }));
  expect(requestWorkerLogJob).toHaveBeenCalledExactlyOnceWith('RQ-PHX-FAILED-B');
  expect(openPane).toHaveBeenCalledExactlyOnceWith('worker-log');
  fireEvent.click(group.getByRole('radio', { name: 'Produced 2' }));
  expect(within(screen.getByRole('list', { name: 'Cases' })).getAllByRole('listitem')).toHaveLength(2);
  fireEvent.click(group.getByRole('radio', { name: 'All 3' }));
  expect(within(screen.getByRole('list', { name: 'Cases' })).getAllByRole('listitem')).toHaveLength(3);
});

it('falls back to All when a later poll drops the selected outcome', async () => {
  const withoutFailed = read({
    feedback: feedback({
      counts: { ...ZERO, 'producer-succeeded': 2 },
      observedCounts: { ...ZERO, 'producer-succeeded': 2 },
      cases: producedCases,
    }),
  });
  const fetcher = vi.fn()
    .mockImplementationOnce(async () => Response.json(read()))
    .mockImplementation(async () => Response.json(withoutFailed));
  vi.stubGlobal('fetch', fetcher);
  const props = { visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps;
  render(<FleetOutcomesPane {...props} />);
  const group = within(await screen.findByRole('radiogroup', { name: 'Filter cases' }));
  fireEvent.click(group.getByRole('radio', { name: 'Failed 1' }));
  expect(within(screen.getByRole('list', { name: 'Cases' })).getAllByRole('listitem')).toHaveLength(1);
  await act(async () => { invalidate('verse-fleet-outcomes'); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(group.getAllByRole('radio').map(radio => radio.textContent)).toEqual(['All 2', 'Produced 2']);
  expect(group.getByRole('radio', { name: 'All 2' })).toHaveAttribute('aria-checked', 'true');
  expect(within(screen.getByRole('list', { name: 'Cases' })).getAllByRole('listitem')).toHaveLength(2);
});

it('ends the header with the refresh stamp only when refreshedAt is set', async () => {
  const props = { visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps;
  const view = render(<FleetOutcomesPane {...props} />);
  expect(await screen.findByText(/cases since .* ago · 2 produced · 1 failed · refreshed .* ago$/)).toBeInTheDocument();
  view.unmount();
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(read({ refreshedAt: null }))));
  render(<FleetOutcomesPane {...props} />);
  const header = await screen.findByText(/cases since .* ago · 2 produced · 1 failed$/);
  expect(header).not.toHaveTextContent('refreshed');
});
