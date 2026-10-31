import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetOutcomesPane } from './FleetOutcomesPane.js';

const props = { visible: true } as PaneProps;
const CASE_ID = 'h:0000000000000001:0000000000000002:0000000000000003:0000000000000004';
const ENCODED_CASE_ID = 'h%3A0000000000000001%3A0000000000000002%3A0000000000000003%3A0000000000000004';
const ZERO = { 'producer-succeeded': 0, failed: 0, cancelled: 0, refused: 0, 'empty-diff': 0, disabled: 0, unknown: 0 };

const fixture = (state = 'current') => ({
  v: 1, state, refreshedAt: new Date().toISOString(),
  feedback: {
    schemaVersion: 1, sourceState: 'healthy', complete: true,
    window: { since: new Date(Date.now() - 24 * 3_600_000).toISOString(), through: new Date().toISOString() },
    observedThrough: new Date().toISOString(),
    counts: { ...ZERO, 'producer-succeeded': 3, failed: 1, 'empty-diff': 1 },
    observedCounts: { ...ZERO, 'producer-succeeded': 3, failed: 1, 'empty-diff': 1 },
    cases: [
      { caseId: CASE_ID, endedAt: new Date(Date.now() - 600_000).toISOString(), outcome: 'producer-succeeded', failureKind: null, proposalRecorded: true },
      { caseId: 'h:0000000000000005:0000000000000006:0000000000000007:0000000000000008', endedAt: new Date(Date.now() - 3_600_000).toISOString(), outcome: 'failed', failureKind: 'engine', proposalRecorded: false },
    ],
    coverage: { legacyRows: 0, invalidAttempts: 0, conflictingAttempts: 0, duplicateRows: 0, invalidTimestamps: 0, proposalSource: 'healthy' },
    digest: 'h:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb:cccccccccccccccc:dddddddddddddddd',
  },
});

const caseFixture = () => ({
  v: 1, state: 'current', refreshedAt: new Date().toISOString(),
  detail: {
    schemaVersion: 1, caseId: CASE_ID, outcome: 'producer-succeeded', endedAt: new Date().toISOString(),
    coverage: { dispatch: 'healthy', proposals: 'healthy', ledger: 'healthy', invalidRecords: 0, conflictingRecords: 0 },
    timeline: [
      { stage: 'produced', at: new Date(Date.now() - 900_000).toISOString(), result: 'recorded', basis: 'dispatch-final' },
      { stage: 'pr-opened', at: new Date(Date.now() - 600_000).toISOString(), result: 'recorded', basis: 'authority-ledger', href: 'https://github.com/ashlrai/phantom/pull/42' },
      { stage: 'post-merge', at: new Date(Date.now() - 300_000).toISOString(), result: 'green', basis: 'authenticated-host', ci: 'green', suite: 'pass' },
    ],
    shipping: 'not-recorded', digest: 'h:eeeeeeeeeeeeeeee:ffffffffffffffff:0000000000000000:1111111111111111',
  },
});

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders the header, outcome mix and case rows', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetOutcomesPane {...props} />);
  expect(await screen.findByText(/2 cases since .* ago · 3 produced · 1 failed/)).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /Outcome mix/ })).toBeInTheDocument();
  const cases = within(screen.getByRole('list', { name: 'Cases' }));
  const rows = cases.getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('Produced');
  expect(rows[0]).toHaveTextContent('PR recorded');
  expect(rows[1]).toHaveTextContent('Failed');
  expect(rows[1]).toHaveTextContent('engine');
  expect(rows[1]).toHaveTextContent('no PR');
  expect(cases.getByTitle(CASE_ID)).toBeInTheDocument();
});

it('opens the case timeline on click and renders steps with a safe link', async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    Response.json(String(url).includes('/cases/') ? caseFixture() : fixture()));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetOutcomesPane {...props} />);
  const cases = within(await screen.findByRole('list', { name: 'Cases' }));
  fireEvent.click(cases.getByRole('button', { name: /Produced/ }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(`/api/verse/fleet/live/feedback/cases/${ENCODED_CASE_ID}`, expect.anything()));
  const timeline = within(await screen.findByRole('region', { name: 'Case timeline' }));
  expect(await timeline.findByText('PR opened')).toBeInTheDocument();
  expect(timeline.getByText('Post-merge CI')).toBeInTheDocument();
  const link = timeline.getByRole('link', { name: 'Open' });
  expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  fireEvent.click(timeline.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('region', { name: 'Case timeline' })).not.toBeInTheDocument();
});

it('reports a missing endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetOutcomesPane {...props} />);
  expect(await screen.findByText('Outcomes not in this build')).toBeInTheDocument();
});

it('reports an unavailable feedback source', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ v: 1, state: 'unavailable', refreshedAt: null, feedback: null })));
  render(<FleetOutcomesPane {...props} />);
  expect(await screen.findByText('Outcomes are unavailable on this Mac.')).toBeInTheDocument();
});

it('notes a stale reading', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture('stale'))));
  render(<FleetOutcomesPane {...props} />);
  expect(await screen.findByText('Showing the last reading.')).toBeInTheDocument();
});

it('polls every thirty seconds only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(fixture()));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetOutcomesPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetOutcomesPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<FleetOutcomesPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
