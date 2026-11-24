import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet } from '../../../data/client.js';
import { evictAll } from '../../../data/cache.js';
import type { WorklogKind, WorklogReport, WorklogRow } from '../../../../core/fleet/worklog.js';
import { WorklogView } from './WorklogView.js';
vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<object>(), apiGet: vi.fn() }));
const row = (kind: WorklogKind, job: string | null, text: string, at = '2026-11-09T10:20:00Z', repo: string | null = 'phantom', lane: string | null = 'work'): WorklogRow =>
  ({ at, kind, job, lane, repo, text, url: null, count: 1 });
const ok = { state: 'ok' } as const;
const report = (rows: WorklogRow[] = [], more: Partial<WorklogReport> = {}): WorklogReport =>
  ({ schema: 'worklog.v3', hours: 6, rows, sources: { jobs: ok, events: ok, leader: ok }, entries: [], malformedLines: 0, ...more });
const feed = [
  { ...row('merged', 'RQ-POOLS', 'Merged #6675 Pools panel in 2m 40s'), url: 'https://github.com/ashlrai/phantom/pull/6675' },
  { ...row('finished', 'RQ-POOLS', 'Opened PR #6675 Pools panel', '2026-11-09T10:19:00Z'), count: 2 },
  row('leader', null, 'Leader: Next up is the phone work log.', '2026-11-09T10:18:00Z', null, null),
  row('incident', null, 'Incident: no launch and no merge in 30 min', '2026-11-09T08:12:00Z', null, null),
  row('empty', 'RQ-COVERED', 'Ended with no change: work was already completed or covered', '2026-11-09T08:11:00Z', 'locus', null),
  row('launched', 'RQ-COVERED', 'Launched', '2026-11-09T08:10:00Z', 'locus', 'fast'),
];
/** Serve the feed and, for a tapped row, the existing job detail API (404 when the job has no record). */
function serve(worklog: WorklogReport, detail: unknown = null) {
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/fleet/job?id=')) { if (detail === null) throw new ApiError('not found', 404, path); return detail; }
    if (path.startsWith('/api/worklog')) return worklog;
    if (path === '/api/fleet/empty-jobs') return { schema: 'jobs.empty.v1', hours: 24, total: 0, topCauses: [], diagnosis: { jobs: [], families: [], lanes: [] } };
    throw new Error(`Unexpected path ${path}`);
  });
}
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { vi.useRealTimers(); });
describe('Work log', () => {
  it('groups plain-words rows by hour and filters with one chip per kind', async () => {
    serve(report(feed));
    render(<WorklogView />);
    expect(await screen.findByText('Merged #6675 Pools panel in 2m 40s')).toBeTruthy();
    expect(await screen.findByText('No empty jobs in this period.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Why jobs end empty' })).toBeTruthy();
    const groups = screen.getAllByRole('region').filter(region => region.querySelector('ul'));
    expect(groups.map(group => within(group).getAllByRole('listitem').length)).toEqual([3, 3]);
    expect(screen.getByText('Opened PR #6675 Pools panel (2 events)')).toBeTruthy();
    expect(screen.getByText('RQ-COVERED · unknown lane · locus')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open PR #6675' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/6675');
    const chips = within(screen.getByRole('group', { name: 'Show' })).getAllByRole('button');
    expect(chips.map(chip => chip.textContent)).toEqual(['All 6', 'Merged 1', 'Launched 1', 'Finished 1', 'No change 1', 'Leader 1', 'Incidents 1']);
    fireEvent.click(screen.getByRole('button', { name: 'No change 1' }));
    expect(screen.getByRole('button', { name: 'No change 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('Launched')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All 6' }));
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'locus' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Merged 0' }));
    expect(screen.getByText(/Nothing matches these filters\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
  });
  it('opens the job detail when a job row is tapped and leaves job-less rows plain', async () => {
    serve(report(feed), { schema: 'fleet.job.v1', job: 'RQ-POOLS', state: 'published', lane: 'work', model: 'model-a', branch: 'bridge/RQ-POOLS', log: { tail: ['tests passed', 'opened pull request'] } });
    render(<WorklogView />);
    const tap = await screen.findByRole('button', { name: /Merged #6675 Pools panel/ });
    expect(tap).toHaveAttribute('aria-expanded', 'false');
    await act(async () => { fireEvent.click(tap); });
    const detail = await screen.findByRole('region', { name: 'Job detail for RQ-POOLS' });
    expect(detail).toHaveTextContent('State: published · Lane: work · Model: model-a');
    expect(detail).toHaveTextContent('Branch: bridge/RQ-POOLS · Launched: unknown');
    expect(detail).toHaveTextContent('opened pull request');
    expect(vi.mocked(apiGet).mock.calls.map(call => call[0])).toContain('/api/fleet/job?id=RQ-POOLS');
    await act(async () => { fireEvent.click(tap); });
    expect(screen.queryByRole('region', { name: 'Job detail for RQ-POOLS' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Leader: Next up/ })).toBeNull();
  });
  it('says when a job has no recorded detail', async () => {
    serve(report(feed));
    render(<WorklogView />);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^.*Launched.*RQ-COVERED/ })); });
    expect(await screen.findByText('No detail is recorded for this job.')).toBeTruthy();
  });
  it('shows a plain empty state and offers a wider window', async () => {
    serve(report());
    render(<WorklogView />);
    expect(await screen.findByText(/Nothing recorded in the last 6 hours\. New work shows up here as it happens\./)).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
    serve(report([row('launched', 'RQ-OLD', 'Launched')], { hours: 24 }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show the last 24 hours' })); });
    expect(await screen.findByText('RQ-OLD · work · phantom')).toBeTruthy();
    expect(vi.mocked(apiGet).mock.calls.map(call => call[0])).toEqual(['/api/fleet/empty-jobs', '/api/worklog', '/api/worklog?hours=24']);
  });
  it('shows an unreadable source as unknown with its reason', async () => {
    serve(report([feed[0]!], { malformedLines: 1, sources: { jobs: ok, events: ok, leader: { state: 'unknown', reason: 'The leader plan log could not be read.' } } }));
    render(<WorklogView />);
    expect(await screen.findByText('Leader replies: unknown. The leader plan log could not be read.')).toBeTruthy();
    expect(screen.getByText('1 unreadable records skipped.')).toBeTruthy();
    expect(screen.queryByText(/Job results: unknown/)).toBeNull();
  });
  it('fits a 390 px phone: a wrapping list with no table or fixed width in the feed', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    serve(report(feed));
    const view = render(<WorklogView />);
    await screen.findByText('Merged #6675 Pools panel in 2m 40s');
    for (const group of screen.getAllByRole('region')) expect(group.querySelector('table')).toBeNull();
    expect(view.container.querySelector('[style]')).toBeNull();
    // jsdom does no layout, so hold the stylesheet to the rules that keep long lines inside a narrow screen.
    const css = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/work/worklog/WorklogView.module.css'), 'utf8');
    for (const rule of ['.text { flex: 1 1 100%; overflow-wrap: anywhere; }', '.who { flex: 1 1 100%; overflow-wrap: anywhere; }', 'flex-wrap: wrap', 'min-height: 44px']) expect(css).toContain(rule);
    expect(css).not.toMatch(/(?:^|[\s;{])(?:min-)?width:\s*\d{3,}px/);
  });
  it('updates live, keeps the chosen chip and stops polling after unmount', async () => {
    vi.useFakeTimers(); serve(report([row('launched', 'RQ-ONE', 'Launched')]));
    const view = render(<WorklogView />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: 'Launched 1' }));
    serve(report([row('merged', 'RQ-TWO', 'Merged'), row('launched', 'RQ-TWO', 'Launched', '2026-11-09T10:19:00Z'), row('launched', 'RQ-ONE', 'Launched', '2026-11-09T10:18:00Z')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByRole('button', { name: 'Launched 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    view.unmount(); const calls = vi.mocked(apiGet).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000); expect(apiGet).toHaveBeenCalledTimes(calls);
  });
  it('shows refresh failure while keeping the last events and allows retry', async () => {
    vi.useFakeTimers(); serve(report([row('launched', 'RQ-ONE', 'Launched')]));
    render(<WorklogView />); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    vi.mocked(apiGet).mockRejectedValue(new Error('offline'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByRole('alert')).toHaveTextContent('Showing the last available events.');
    expect(screen.getByText('RQ-ONE · work · phantom')).toBeTruthy();
    serve(report([row('merged', 'RQ-TWO', 'Merged')]));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByText('RQ-TWO · work · phantom')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  });
});
