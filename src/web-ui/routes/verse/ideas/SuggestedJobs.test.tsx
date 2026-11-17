import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BetSuggestion, NextBetsReport } from '../../../../core/fleet/next-bets.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { IdeasPane } from './IdeasPane.js';
import { SuggestedJobs } from './SuggestedJobs.js';

const PATH = '/api/verse/fleet/control/ideas/bets';
const bet = (rank: number, over: Partial<BetSuggestion> = {}): BetSuggestion => ({
  id: `idle-lane:lane-${rank}`, rank, goal: `Give lane-${rank} work: 2 of 2 slots free and nothing queued`, lane: `lane-${rank}`, tier: 'work', repo: null,
  signal: 'idle-lane', numbers: { freeSlots: 2 }, family: 'leader', score: 100 - rank, terms: [],
  queueLine: `- READY RQ-NEXT-IDLE-LANE-LANE-${rank} (P1, pool=lane-${rank}, tier=work, src=bets): Give lane-${rank} work`, ...over,
});
const report = (suggestions: BetSuggestion[], unknown: NextBetsReport['signals'][number]['name'][] = []): NextBetsReport => ({
  schema: 'fleet.next-bets.v1', generatedAt: '2026-11-17T12:00:00.000Z', readOnly: true, weights: {} as NextBetsReport['weights'], total: suggestions.length, suggestions,
  signals: (['lanes', 'pace', 'yield', 'mains', 'releases', 'autonomy'] as const).map(name => ({ name, status: unknown.includes(name) ? 'unknown' : 'ok' })),
});
const RED = bet(1, { id: 'red-main:ashlrai-phantom', signal: 'red-main', goal: 'Fix unit tests on main in ashlrai/phantom', lane: 'claude', tier: 'frontier', repo: 'ashlrai/phantom', score: 1000,
  queueLine: '- READY RQ-NEXT-RED-MAIN-ASHLRAI-PHANTOM (P0, pool=claude, tier=frontier, repo=phantom, src=bets): Fix unit tests on main in ashlrai/phantom' });

let viewport: ViewportMock | null = null;
const writeText = vi.fn<(text: string) => Promise<void>>();
beforeEach(() => { evictAll(); writeText.mockReset().mockResolvedValue(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } }); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); });
const show = (body: unknown, width: number) => { viewport = mockViewport(width); stubSurfaceFetch({ routes: { [PATH]: body } }); return render(<SuggestedJobs visible />); };

describe.each([['390 px', 390], ['desktop width', 1440]])('Suggested jobs at %s', (_name, width) => {
  it('shows the top five in rank order, each with one copy button', async () => {
    show(report([RED, bet(2), bet(3), bet(4), bet(5), bet(6)]), width);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByText('Fix unit tests on main in ashlrai/phantom')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Red main · claude · frontier · ashlrai/phantom · score 1000')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Idle lane · lane-2 · work · any repo · score 98')).toBeInTheDocument();
    for (const item of rows) expect(within(item).getAllByRole('button').map(button => button.textContent)).toEqual(['Copy queue line']);
    expect(screen.queryByText(/Not checked/)).toBeNull();
  });

  it('shows the empty state, and names signals that were not checked', async () => {
    show(report([]), width);
    expect(await screen.findByText('No suggested jobs right now.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup(); evictAll();
    show(report([], ['pace', 'releases']), width);
    expect(await screen.findByText('No suggestions from the signals that could be read.')).toBeInTheDocument();
    expect(screen.getByText('Not checked: usage pace, releases.')).toBeInTheDocument();
  });
});

describe('Suggested jobs', () => {
  it('copies the queue line and never posts', async () => {
    viewport = mockViewport(390);
    const stub = stubSurfaceFetch({ routes: { [PATH]: report([RED, bet(2)]) } });
    render(<SuggestedJobs visible />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy queue line: Fix unit tests on main in ashlrai/phantom' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    expect(writeText).toHaveBeenCalledWith(RED.queueLine);
    expect(stub.posted).toEqual([]);
  });

  it('shows the line to select when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    show(report([RED]), 390);
    fireEvent.click(await screen.findByRole('button', { name: /Copy queue line/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`Could not copy. Select this line: ${RED.queueLine}`);
  });

  it('treats another shape as unreadable, not as empty', async () => {
    show({ schema: 'something-else' }, 390);
    expect(await screen.findByText('Could not read suggested jobs.')).toBeInTheDocument();
  });

  it('sits on the Ideas view under Next bets', async () => {
    stubSurfaceFetch({ routes: { [PATH]: report([RED]) } });
    render(<IdeasPane />);
    expect(await screen.findByText('Fix unit tests on main in ashlrai/phantom')).toBeInTheDocument();
    const titles = screen.getAllByRole('heading').map(heading => heading.textContent);
    expect(titles.indexOf('Suggested jobs')).toBeGreaterThan(titles.indexOf('Next bets'));
  });
});
