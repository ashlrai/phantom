import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { OpsRuns } from './OpsRuns.js';
import type { FleetRuns } from './ops-runs-model.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'degraded', codex: 'missing', merges: 'not-landed' },
  lastTick: '2026-10-31T11:59:00Z', paused: true, memFreePct: 30, diskFreeGb: 80,
  switches: ['HOLD', 'queue/DISABLE'], claudeLane: 'down: quota',
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 3, held: true, heldReason: 'Budget hold', tokensLastHour: 500, merged24h: 6, mergeRate24h: 75 }],
  workers: [{ job: 'worker-one', repo: 'phantom', lane: 'codex', tier: 'frontier', ageSeconds: 65 }],
  leaders: [{ label: 'leader', ageSeconds: 20 }], orchestratorAgents: 2,
  publishesLastHour: [{ job: 'publish-one', lane: 'codex', url: 'https://github.com/ashlrai/phantom/pull/12', at: '2026-10-31T12:00:00Z' }],
  mergesLastHour: { count: 1, items: [{ repo: 'phantom', number: 12, title: 'Fleet view' }] },
  events: [{ at: '2026-10-31T11:00:00Z', kind: 'tick', text: 'Old event' }, { at: '2026-10-31T12:00:00Z', kind: 'merge', text: 'New event' }],
  codexPersonal: { usedPct: 42, resetsAt: '2026-10-31T13:00:00Z', asOf: '2026-10-31T12:00:00Z' },
  inbox: [{ at: '2026-10-31T12:00:00Z', source: 'Mason', text: 'Inbox message' }],
  drop: { pending: [{ lane: 'codex', file: 'request.md' }], done: 1 },
};

beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const serve = (data: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data, { status })));
it('renders the live fleet and safe external PR links', async () => {
  serve(fixture); render(<OpsRuns />);
  expect(await screen.findByRole('group', { name: 'Real workers: 1' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Merges last hour: 1' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Personal Codex used: 42 %' })).toHaveTextContent('resets');
  expect(screen.getByRole('group', { name: 'Leader passes: 1' })).toBeInTheDocument();
  for (const text of ['HOLD', 'queue/DISABLE', 'Claude lane: down: quota', 'Dispatcher paused', 'worker-one', 'phantom #12 Fleet view', 'Inbox message']) expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.getByLabelText('codex held: Budget hold')).toHaveAttribute('title', 'Budget hold');
  expect(within(screen.getByRole('table', { name: 'Workers' })).getByText('01:05')).toBeInTheDocument();
  const link = screen.getByRole('link', { name: 'Pull request for publish-one' });
  expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noreferrer');
  expect(screen.getByText(/New event/).compareDocumentPosition(screen.getByText(/Old event/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('renders unknown counts and usage as dashes, and rejects unsafe links', async () => {
  serve({ ...fixture, workers: [], codexPersonal: null, mergesLastHour: { count: null, items: [] }, publishesLastHour: [{ ...fixture.publishesLastHour[0], url: 'javascript:alert(1)' }, { ...fixture.publishesLastHour[0], job: 'unknown-publish', lane: null, url: null }] });
  render(<OpsRuns />);
  expect(await screen.findByRole('group', { name: 'Merges last hour: —' })).toHaveTextContent('—');
  expect(screen.getByRole('group', { name: 'Personal Codex used: —' })).toHaveTextContent('—');
  expect(screen.getByText('No workers running.')).toBeInTheDocument(); expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('PR unavailable')).toBeInTheDocument();
});
it('stops after a 404 and retries when the section reopens', async () => {
  vi.useFakeTimers();
  serve({}, 404);
  const view = render(<SectionVisibilityProvider visible><OpsRuns /></SectionVisibilityProvider>);
  await act(async () => {});
  expect(screen.getByText('Live runs are not in this build yet.')).toBeInTheDocument();
  expect(view.container.textContent).toBe('Live runs are not in this build yet.');
  await act(async () => { vi.advanceTimersByTime(20_000); }); expect(fetch).toHaveBeenCalledTimes(1);
  view.rerender(<SectionVisibilityProvider visible={false}><OpsRuns /></SectionVisibilityProvider>);
  view.rerender(<SectionVisibilityProvider visible><OpsRuns /></SectionVisibilityProvider>);
  await act(async () => {}); expect(fetch).toHaveBeenCalledTimes(2);
});
it('polls every five seconds only while visible', async () => {
  vi.useFakeTimers();
  serve(fixture);
  const view = render(<SectionVisibilityProvider visible><OpsRuns /></SectionVisibilityProvider>);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(5_000); }); expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<SectionVisibilityProvider visible={false}><OpsRuns /></SectionVisibilityProvider>);
  await act(async () => { vi.advanceTimersByTime(15_000); }); expect(fetch).toHaveBeenCalledTimes(2);
});
it('caps the event and inbox tails', async () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ at: `2026-10-31T12:00:${String(i).padStart(2, '0')}Z`, kind: 'tick', source: 'Mason', text: `entry-${i}` }));
  serve({ ...fixture, events: entries, inbox: entries }); render(<OpsRuns />);
  await screen.findByRole('group', { name: 'Real workers: 1' });
  expect(screen.getAllByText(/entry-49/)).toHaveLength(2);
  expect(screen.queryByText(/entry-9$/)).toBeNull();
  expect(screen.getAllByRole('list')[2].children).toHaveLength(40);
  expect(screen.getAllByRole('list')[3].children).toHaveLength(5);
});
it('shows a recoverable error for malformed responses', async () => {
  serve({ v: 1 }); render(<OpsRuns />);
  expect(await screen.findByText('Live runs are unavailable.')).toBeInTheDocument();
});
