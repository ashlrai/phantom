import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HomeSummary } from '../../../../core/fleet/home.js';
import { evictAll } from '../../../data/cache.js';
import { WorklogCard, worklogTime } from './WorklogCard.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const ROWS = [
  { at: at(0.5), kind: 'merged', job: 'RQ-DRAW-12', lane: 'claude', repo: 'phantom', text: 'Merged #12 Draw the day', url: 'https://github.com/ashlrai/phantom/pull/12', count: 1 },
  { at: at(1), kind: 'incident', job: null, lane: null, repo: null, text: 'Lane held: codex at its limit', url: 'https://example.invalid/x', count: 1 },
  { at: at(2), kind: 'launched', job: 'RQ-PIN-4', lane: 'codex-personal', repo: 'locus', text: 'Launched Pin check', url: null, count: 3 },
  { at: at(6), kind: 'launched', job: 'no', lane: null, repo: null, text: 'Launched Short id', url: null, count: 1 },
  { at: at(7), kind: 'empty', job: 'RQ-NOOP-1', lane: 'claude', repo: 'phantom', text: 'Ended with no change: already on master', url: null, count: 1 },
];
const OK = { state: 'ok' };
const REPORT = { schema: 'worklog.v3', hours: 24, rows: ROWS, entries: [], malformedLines: 0, sources: { jobs: OK, events: OK, leader: OK } };
const SUMMARY: HomeSummary['worklog'] = { state: 'ok', value: [{ at: at(0.5), kind: 'merged', text: 'Merged #12 Draw the day', url: 'https://github.com/ashlrai/phantom/pull/12' }, { at: at(1), kind: 'leader', text: 'Leader: a fake reply', url: null }] };

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); evictAll(); });
const serve = (body: unknown, status = 200) => { const fetch = vi.fn(async (_url: string) => Response.json(body, { status })); vi.stubGlobal('fetch', fetch); return fetch; };
const show = (summary: HomeSummary['worklog'] = SUMMARY, onOpenJob = vi.fn(), onOpen = vi.fn()) => {
  render(<WorklogCard summary={summary} onOpen={onOpen} onOpenJob={onOpenJob} />);
  return { card: within(screen.getByRole('region', { name: 'Work log' })), onOpenJob, onOpen };
};
const feed = (card: ReturnType<typeof show>['card']) => card.getByRole('list', { name: /^Work log, newest first/ });

it('counts the day by kind and lists the newest events with kind, link and job', async () => {
  const fetch = serve(REPORT); const { card, onOpenJob } = show();
  await card.findByText('7 events in the last 24 hours: 1 merged, 4 launched, 1 no change, 1 incident.');
  expect(String(fetch.mock.calls[0]![0])).toContain('/api/worklog?hours=24');
  const rows = within(feed(card)).getAllByRole('listitem');
  expect(rows).toHaveLength(5);
  expect(rows[0]!.textContent).toContain(worklogTime(NOW - 1_800_000));
  expect(within(rows[0]!).getByText('Merged')).toBeTruthy();
  expect(within(rows[0]!).getByRole('link', { name: 'Merged #12 Draw the day' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/12');
  // An address that is not a GitHub pull request is never a link.
  expect(within(rows[1]!).queryByRole('link')).toBeNull();
  expect(within(rows[2]!).getByText('3 times')).toBeTruthy();
  fireEvent.click(within(rows[2]!).getByRole('button', { name: 'Open the worker log for RQ-PIN-4' }));
  expect(onOpenJob).toHaveBeenCalledWith('RQ-PIN-4');
  // A job id the server would refuse is not a button.
  expect(within(rows[3]!).queryByRole('button')).toBeNull();
  expect(card.getByText('phm worklog --hours 24')).toBeTruthy();
});

it('draws a row per kind across the report hours, with the count and last time in words', async () => {
  serve(REPORT); const { card } = show();
  const day = await card.findByRole('list', { name: 'The day by kind' });
  const kinds = within(day).getAllByRole('listitem');
  expect(kinds.map(node => node.getAttribute('data-kind'))).toEqual(['merged', 'launched', 'empty', 'incident']);
  expect(within(kinds[1]!).getByRole('button', { name: 'Launched 4' })).toBeTruthy();
  expect(kinds[1]!.textContent).toContain(`last ${worklogTime(NOW - 2 * 3_600_000)}`);
  const cells = [...within(day).getByTestId('worklog-cells-launched').children];
  expect(cells).toHaveLength(48);
  // Two hours ago is slice 44 of 48, six hours ago slice 36; three launches against one set the darker square.
  expect(cells.flatMap((cell, i) => cell.hasAttribute('data-n') ? [i] : [])).toEqual([36, 44]);
  expect((cells[44] as HTMLElement).style.opacity).toBe('1');
  expect(Number((cells[36] as HTMLElement).style.opacity)).toBeLessThan(1);
  expect(card.getByText('each square: 30 min · darker: more in its row')).toBeTruthy();
});

it('narrows the list to one kind and back', async () => {
  serve(REPORT); const { card } = show();
  const launched = await card.findByRole('button', { name: 'Launched 4' });
  fireEvent.click(launched);
  expect(launched.getAttribute('aria-pressed')).toBe('true');
  expect(within(card.getByRole('list', { name: 'Work log, newest first, launched only' })).getAllByRole('listitem')).toHaveLength(2);
  fireEvent.click(launched);
  expect(launched.getAttribute('aria-pressed')).toBe('false');
  expect(within(feed(card)).getAllByRole('listitem')).toHaveLength(5);
});

it('lists eight events and says how many more the Work log holds', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ at: at(i + 1), kind: 'finished', job: null, lane: null, repo: null, text: `Finished job ${i}`, url: null, count: 1 }));
  serve({ ...REPORT, rows: many }); const { card } = show();
  await card.findByText('11 events in the last 24 hours: 11 finished.');
  expect(within(feed(card)).getAllByRole('listitem')).toHaveLength(8);
  expect(card.getByText(/^3 earlier lines are in the Work log\./)).toBeTruthy();
});

it('names a source that could not be read instead of counting it as quiet', async () => {
  serve({ ...REPORT, rows: [], sources: { jobs: { state: 'unknown', reason: 'No jobs ledger has been written yet.' }, events: OK, leader: OK } }); const { card } = show();
  await card.findByText('No work recorded in the last 24 hours.');
  expect(card.getByText('Not read, so not counted: No jobs ledger has been written yet.')).toBeTruthy();
  expect(card.queryByRole('list')).toBeNull();
});

it('draws no day when the report does not give its hours', async () => {
  serve({ ...REPORT, hours: null }); const { card } = show();
  await card.findByText('7 events in this read: 1 merged, 4 launched, 1 no change, 1 incident.');
  expect(card.queryByTestId('worklog-cells-launched')).toBeNull();
  expect(card.queryByText(/each square/)).toBeNull();
  expect(card.getByRole('button', { name: 'Launched 4' })).toBeTruthy();
});

it('lists the fleet summary rows on a server without the report, with one action', async () => {
  const fetch = serve({ schema: 'something.else' }); const { card, onOpen } = show();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  const rows = within(feed(card)).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(within(rows[0]!).getByRole('link', { name: 'Merged #12 Draw the day' })).toBeTruthy();
  expect(within(rows[1]!).getByText('Leader')).toBeTruthy();
  expect(card.queryByRole('list', { name: 'The day by kind' })).toBeNull();
  const buttons = card.getAllByRole('button');
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]!);
  expect(onOpen).toHaveBeenCalledOnce();
});

it('says the full day could not be read when the read fails, and keeps an unknown summary unknown', async () => {
  serve({ error: 'Jobs ledger is unreadable.' }, 503);
  const { card } = show({ state: 'unknown', reason: 'No jobs ledger has been written yet.' });
  await card.findByText(/^The full day could not be read\./);
  expect(card.getByText('Unknown: No jobs ledger has been written yet.')).toBeTruthy();
  expect(card.queryByRole('list')).toBeNull();
});
