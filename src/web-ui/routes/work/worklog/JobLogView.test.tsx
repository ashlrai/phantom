import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from '../../../data/client.js';
import { evictAll } from '../../../data/cache.js';
import type { JobLogReport, JobLogRow } from '../../../../core/fleet/job-log.js';
import { JobLogView } from './JobLogView.js';
vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<object>(), apiGet: vi.fn() }));

const job = (id: string | null, result: JobLogRow['result'], text: string, more: Partial<JobLogRow> = {}): JobLogRow =>
  ({ job: id, at: '2026-11-09T10:20:00Z', lane: 'work', model: 'model-a', repo: 'phantom', goal: null, result, text, pr: null, url: null, mergeSeconds: null, ...more });
const counts = { jobs: 0, merged: 0, noChange: 0, noChangeRate: null, medianMergeSeconds: null };
const report = (jobs: JobLogRow[], headline: string, more: Partial<JobLogReport> = {}): JobLogReport =>
  ({ schema: 'joblog.v1', version: 1, hours: 6, headline, summary: { ...counts, jobs: jobs.length, lanes: [] }, jobs, sources: { jobs: { state: 'ok' } }, malformedLines: 0, ...more });
const jobs = [
  job('RQ-LOGVIEW', 'merged', 'Merged PR 7', { goal: 'Add the log view', pr: 7, url: 'https://github.com/ashlrai/phantom/pull/7', mergeSeconds: 120 }),
  job('RQ-BROKEN', 'failed', 'Failed: tests did not pass', { lane: 'fast', model: null }),
  job('RQ-COVERED', 'no-change', 'No change: work was already covered', { lane: 'fast', repo: 'locus' }),
  job('RQ-SAME', 'no-change', 'No change: reason unknown', { lane: 'fast' }),
  job('RQ-GOING', 'running', 'Still running, no result yet', { at: '2026-11-09T10:10:00Z' }),
  job(null, 'merged', 'Merged PR 3', { at: '2026-11-09T10:05:00Z', lane: null, model: null, pr: 3, url: 'https://github.com/ashlrai/locus/pull/3', repo: 'locus' }),
];
const normal = report(jobs, '6 jobs, 2 merged, 40% made no change, median time to merge 2m 0s.');
function serve(byPath: Record<string, JobLogReport>) {
  vi.mocked(apiGet).mockImplementation(async (path: string) => { if (byPath[path]) return byPath[path]; throw new Error(`Unexpected path ${path}`); });
}
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });

describe('Log view', () => {
  it('shows the summary, one row per job newest first, and folds no-change jobs into one group', async () => {
    serve({ '/api/log': normal });
    render(<JobLogView />);
    expect(await screen.findByText('Last 6 hours: 6 jobs, 2 merged, 40% made no change, median time to merge 2m 0s.')).toBeTruthy();
    const rows = within(screen.getByRole('list', { name: 'Jobs' })).getAllByRole('listitem');
    expect(rows.map(row => row.querySelector('[data-kind]')!.textContent)).toEqual(['Merged PR 7 in 2 min', 'Failed: tests did not pass', 'Still running, no result yet', 'Merged PR 3, time to merge unknown']);
    expect(within(rows[3]!).getByText('unknown job · unknown lane · unknown model · locus')).toBeTruthy();
    expect(within(rows[0]!).getByText('Add the log view')).toBeTruthy();
    expect(within(rows[0]!).getByRole('link', { name: 'Open PR 7' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/7');
    expect(within(rows[1]!).getByText('Goal unknown')).toBeTruthy();
    expect(within(rows[1]!).getByText('RQ-BROKEN · fast · unknown model · phantom')).toBeTruthy();
    const group = screen.getByText('2 jobs made no change').closest('details')!;
    expect(group.open).toBe(false);
    expect(within(group).getAllByRole('listitem', { hidden: true })).toHaveLength(2);
  });
  it('filters with lane and repo chips through the same API route', async () => {
    const fast = report(jobs.filter(row => row.lane === 'fast'), '3 jobs, 0 merged, 67% made no change, median time to merge unknown.');
    serve({ '/api/log': normal, '/api/log?lane=fast': fast, '/api/log?lane=fast&repo=locus': report([jobs[2]!], '1 job, 0 merged, 100% made no change, median time to merge unknown.') });
    render(<JobLogView />);
    const lanes = within(await screen.findByRole('group', { name: 'Lane' })).getAllByRole('button');
    expect(lanes.map(chip => chip.textContent)).toEqual(['All lanes', 'fast 3', 'unknown 1', 'work 2']);
    fireEvent.click(screen.getByRole('button', { name: 'fast 3' }));
    expect(await screen.findByText(/^Last 6 hours: 3 jobs, 0 merged/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'fast 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'work 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'locus 2' }));
    expect(await screen.findByText('1 job made no change')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Jobs' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All repos' })); fireEvent.click(screen.getByRole('button', { name: 'All lanes' }));
    expect(await screen.findByText('2 jobs made no change')).toBeTruthy();
  });
  it('shows an empty state with one next step, and says what is unknown', async () => {
    const empty = report([], '0 jobs.', { sources: { jobs: { state: 'unknown', reason: 'No jobs ledger has been written yet.' } } });
    serve({ '/api/log': empty, '/api/log?since=24h': report([jobs[4]!], '1 job, 0 merged, 0% made no change, median time to merge unknown.', { hours: 24 }) });
    render(<JobLogView />);
    expect(await screen.findByText(/No jobs recorded in the last 6 hours\./)).toBeTruthy();
    expect(screen.getByText('Job results: unknown. No jobs ledger has been written yet.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Lane' })).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the last 24 hours' }));
    expect(await screen.findByText(/^Last 24 hours: 1 job, 0 merged/)).toBeTruthy();
  });
  it('reports a failed load with a retry', async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error('offline'));
    render(<JobLogView />);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not update the log.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
  it('fits a 390 px phone: a wrapping list with no table or fixed width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    serve({ '/api/log': normal });
    const view = render(<JobLogView />);
    await screen.findByText('2 jobs made no change');
    expect(view.container.querySelector('table')).toBeNull();
    expect(view.container.querySelector('[style]')).toBeNull();
    // jsdom does no layout, so hold the shared stylesheet to the rules that keep long lines inside a narrow screen.
    const css = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/work/worklog/WorklogView.module.css'), 'utf8');
    for (const rule of ['.text { flex: 1 1 100%; overflow-wrap: anywhere; }', '.who { flex: 1 1 100%; overflow-wrap: anywhere; }', 'flex-wrap: wrap', 'min-height: 44px']) expect(css).toContain(rule);
    expect(css).not.toMatch(/(?:^|[\s;{])(?:min-)?width:\s*\d{3,}px/);
  });
});
