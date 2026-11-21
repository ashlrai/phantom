/** The Models board's work line: each model's jobs and merged PRs across the window, from the per-model throughput report. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRegistryRow } from '../../../../core/fleet/model-verify.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { ModelsPane } from './ModelsPane.js';
import { WORK_NOW, workCounts, workGroup, workReport } from './model-work.test-support.js';

const PATH = '/api/verse/fleet/control/models';
const WORK = '/api/verse/fleet/runs/throughput';
const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const entry = (id: string, provider: string): ModelRegistryRow =>
  ({ id, provider, lanes: [], verified: true, status: 'verified', source_url: 'https://docs.example.test/models', verified_on: '2026-11-05', unverified: false, stale: false, reason: null });
const registry = { schema: 'models.registry.v1', entries: [entry('opus', 'anthropic'), entry('fresh', 'openai'), entry('spare', 'openai')] };
const day = workReport([
  workGroup('opus', { launched: 7, merged: 3, finished: 6, empty: 1 }, { 3: { launched: 2 }, 22: { launched: 4, merged: 1 }, 23: { launched: 1, merged: 2 } }),
  workGroup('fresh', { launched: 1 }, { 23: { launched: 1 } }),
  workGroup('other-9', { launched: 2, merged: 1, finished: 2, empty: 2 }, { 10: { launched: 2, merged: 1 } }),
  workGroup('unknown', { launched: 5, merged: 2, finished: 5 }, { 12: { launched: 5, merged: 2 } }),
]);
const week = workReport([workGroup('opus', { launched: 30, merged: 12, finished: 28, empty: 4 }, { 0: { launched: 9 }, 160: { launched: 21, merged: 12 } }, 168)], { hours: 168 });
/** The check and the lane table are absent here: the work line does not depend on either. */
const routes = (work: unknown) => ({ [PATH]: registry, [`${PATH}/check`]: null, '/api/verse/fleet/runs/lane-models': null, [WORK]: work });

const model = (id: string) => screen.getByRole('listitem', { name: `${id} model` });
const line = (id: string) => model(id).querySelector<HTMLElement>('[data-work]')!;
const bars = (id: string) => [...line(id).querySelectorAll<HTMLElement>('[role="img"] i')].map(bar => bar.style.height);

beforeEach(() => { evictAll(); vi.useFakeTimers({ toFake: ['Date'], now: WORK_NOW }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Models board work line', () => {
  it('draws each model\'s launches across the day against one peak, with the counts in words', async () => {
    const stub = stubSurfaceFetch({ routes: routes(day) });
    render(<ModelsPane />);
    expect(await screen.findByText('Last 24 hours: 15 jobs launched, 6 PRs merged, 3 of 13 finished jobs empty, under 3 model names.')).toBeInTheDocument();
    expect(stub.fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.includes(WORK))).toEqual([`${WORK}?hours=24&by=model`]);
    expect(line('opus')).toHaveAttribute('data-work', 'worked');
    expect(within(model('opus')).getByRole('img', { name: 'opus jobs launched over the last 24 hours, a bar per hour: most in one bar 4' })).toBeInTheDocument();
    expect(bars('opus')).toHaveLength(24);
    expect([bars('opus')[3], bars('opus')[22], bars('opus')[23], bars('opus')[0]]).toEqual(['50%', '100%', '25%', '0%']);
    expect(line('opus').querySelectorAll('[data-merged]')).toHaveLength(2);
    expect(within(line('opus')).getByText('7 jobs launched, 3 PRs merged, 1 of 6 finished jobs empty')).toBeInTheDocument();
    // One job on a board whose busiest hour held four: a quarter of the height, the same scale as the row above.
    expect(bars('fresh')[23]).toBe('25%');
    expect(within(line('fresh')).getByText('1 job launched, 0 PRs merged, none finished')).toBeInTheDocument();
    // Read, and nothing recorded under this name: an empty line and the words, never a hatched gap.
    expect(line('spare')).toHaveAttribute('data-work', 'idle');
    expect(bars('spare')).toEqual([]);
    expect(within(line('spare')).getByText('no work recorded in the last 24 hours')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Anthropic models' })).getByText('7 jobs launched in the last 24 hours')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'OpenAI models' })).getByText('1 job launched in the last 24 hours')).toBeInTheDocument();
    expect(screen.getByText(/a bar per one hour \(tallest: 4\)/)).toBeInTheDocument();
    expect(screen.getByText('phm throughput --by model')).toBeInTheDocument();
  });

  it('says what no row counts and lists the names the registry lacks', async () => {
    stubSurfaceFetch({ routes: routes(day) });
    render(<ModelsPane />);
    expect(await screen.findByText('No model is named for 5 of 15 launches and 2 of 6 merged PRs, so no row counts them.')).toBeInTheDocument();
    const strangers = screen.getByRole('region', { name: 'Launched under a name the registry lacks' });
    // A name no provider is known for gets the monogram, then the name and its counts.
    expect(within(strangers).getAllByRole('listitem').map(li => [li.querySelector('strong')?.textContent, li.lastElementChild?.textContent]))
      .toEqual([['other-9', '2 jobs launched, 1 PR merged, 2 of 2 finished jobs empty']]);
    expect(screen.queryByRole('listitem', { name: 'unknown model' })).toBeNull();
  });

  it('asks for the week when the window is switched, and draws a bar per 7 hours', async () => {
    const stub = stubSurfaceFetch({ routes: routes((url: string) => reply(url.includes('hours=168') ? week : day)) });
    render(<ModelsPane />);
    await screen.findByText(/^Last 24 hours: 15 jobs launched/);
    const windows = screen.getByRole('radiogroup', { name: 'Work window' });
    expect(within(windows).getAllByRole('radio').map(radio => [radio.textContent, radio.getAttribute('aria-checked')])).toEqual([['24 hours', 'true'], ['7 days', 'false']]);
    fireEvent.click(within(windows).getByRole('radio', { name: '7 days' }));
    expect(await screen.findByText('Last 7 days: 30 jobs launched, 12 PRs merged, 4 of 28 finished jobs empty, under 1 model name.')).toBeInTheDocument();
    expect(stub.fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.includes(WORK))).toEqual([`${WORK}?hours=24&by=model`, `${WORK}?hours=168&by=model`]);
    expect(within(model('opus')).getByRole('img', { name: 'opus jobs launched over the last 7 days, a bar per 7 hours: most in one bar 21' })).toBeInTheDocument();
    expect(bars('opus')).toHaveLength(24);
    expect([bars('opus')[0], bars('opus')[22]]).toEqual(['43%', '100%']);
    expect(within(line('opus')).getByText('Last 7 days')).toBeInTheDocument();
    expect(line('fresh')).toHaveAttribute('data-work', 'idle');
    expect(screen.getByText(/a bar per 7 hours \(tallest: 21\)/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Launched under a name the registry lacks' })).toBeNull();
  });

  it.each([
    ['an older server refuses the grouping', (): Response => reply({ error: 'bad query' }, 400), 'Work in the last 24 hours is unknown: the per-model throughput report could not be read.'],
    ['the report is grouped another way', (): Response => reply({ ...day, by: 'lane' }), 'Work in the last 24 hours is unknown: the per-model throughput report could not be read.'],
    ['the job metrics file is unreadable', (): Response => reply(workReport([], { metrics: 'unreadable', totals: workCounts({ launched: null, merged: null, finished: null, empty: null }) })), 'Work in the last 24 hours is unknown: the job metrics file could not be read.'],
  ])('keeps the board and reads work as unknown when %s', async (_name, answer, sentence) => {
    stubSurfaceFetch({ routes: routes(answer) });
    render(<ModelsPane />);
    expect(await screen.findByText(sentence)).toHaveAttribute('data-unknown');
    for (const id of ['opus', 'fresh', 'spare']) {
      expect(line(id)).toHaveAttribute('data-work', 'unread');
      expect(within(line(id)).getByText('work unknown')).toBeInTheDocument();
      expect(within(model(id)).getByRole('img', { name: `${id}: work unknown` })).toBeInTheDocument();
      expect(bars(id)).toEqual([]);
    }
    // No provider total, no key and no "nothing recorded": a missing reading is not a zero.
    expect(document.querySelector('[data-group-work]')).toBeNull();
    expect(screen.queryByText(/tallest/)).toBeNull();
    expect(screen.queryByText(/no work recorded/)).toBeNull();
    expect(within(screen.getByRole('region', { name: 'OpenAI models' })).getAllByRole('listitem')).toHaveLength(2);
  });
});
