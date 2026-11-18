import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeSummary } from '../../../../core/fleet/home.js';
import { HOME_VIEW_STORAGE_KEY, resetHomeChoice } from '../shell/home-view-store.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import { HomePane } from './HomePane.js';

const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown, openDockPane: vi.fn() }));
// One mocked read serves every query, so the Asks card sees a home.v1 body and stays hidden (AsksCard.test.tsx covers it).
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => vi.fn(), useMutationHold: () => ({ hasHold: false, token: null, touch: vi.fn() }) }));
vi.mock('../dock/dock-store.js', async original => ({ ...await original<typeof import('../dock/dock-store.js')>(), openDockPane: state.openDockPane }));
const unknown = (reason: string) => ({ state: 'unknown' as const, reason });
const HEALTHY: HomeSummary = {
  schema: 'home.v1', asOf: '2026-11-17T12:00:00.000Z', health: 'healthy', headline: 'Healthy: 2 PRs merged in the last hour and main is green.',
  mergedLastHour: { state: 'ok', value: 2 }, merged24h: { state: 'ok', value: 31 }, medianMergeSeconds: { state: 'ok', value: 360 },
  main: { state: 'ok', value: [{ repo: 'phantom', state: 'green' }, { repo: 'locus', state: 'red' }] },
  running: { state: 'ok', value: [{ lane: 'claude', running: 3, target: 8 }, { lane: 'grok', running: 1, target: null }] },
  atRisk: { state: 'ok', value: { resource: 'claude', percentUnused: 50, resetAt: '2026-11-17T22:00:00.000Z', reason: '50.0% will expire unused in 10.0h at current burn.' } },
  worklog: { state: 'ok', value: [{ at: '2026-11-17T11:50:00.000Z', kind: 'merged', text: 'Merged a fake change', url: null }, { at: '2026-11-17T11:40:00.000Z', kind: 'leader', text: 'Leader: a fake reply', url: null }] },
  unreadLeaderReplies: { state: 'ok', value: 2 }, needsYou: { state: 'ok', value: [] },
};
const MISSING: HomeSummary = {
  schema: 'home.v1', asOf: HEALTHY.asOf, health: 'unknown', headline: 'Unknown: The job metrics file could not be read.',
  mergedLastHour: unknown('The job metrics file could not be read.'), merged24h: unknown('The job metrics file could not be read.'), medianMergeSeconds: unknown('The job metrics file could not be read.'),
  main: unknown('The main guardian status could not be read.'), running: unknown('No fleet status has been written yet.'), unreadLeaderReplies: unknown('No leader plan log has been written yet.'),
  atRisk: unknown('No resource has a fresh usage reading, a burn rate and a future reset.'), worklog: unknown('No jobs ledger has been written yet.'), needsYou: unknown('The needs-you ledger could not be read.'),
};
const CARDS = ['Merged PRs', 'Main', 'Releases', 'Running jobs', 'Most at risk of going unused', 'Work log', 'Leader'];
let viewport: ViewportMock | null = null;
const show = (data: unknown, width = 1440) => {
  viewport = mockViewport(width); state.data = data;
  return render(<HomePane {...({ visible: true } as Parameters<typeof HomePane>[0])} />);
};
const card = (name: string) => within(screen.getByRole('region', { name }));
beforeEach(() => { state.openDockPane.mockClear(); localStorage.clear(); resetHomeChoice(); resetVerseUi(); window.location.hash = ''; });
afterEach(() => { cleanup(); viewport?.restore(); });
describe.each([['desktop width', 1440], ['390 px', 390]])('Home at %s', (_name, width) => {
  it('shows the headline and one column of cards, each with one action', () => {
    const view = show(HEALTHY, width);
    expect(screen.getByText(HEALTHY.headline).getAttribute('data-health')).toBe('healthy');
    const cards = [...view.container.querySelectorAll('section section')];
    expect(cards.map(node => node.getAttribute('aria-label'))).toEqual(CARDS);
    for (const node of cards) expect(node.querySelectorAll('button')).toHaveLength(1);
    for (const [name, text] of [['Merged PRs', /Last hour: 2/], ['Merged PRs', /Last 24 hours: 31/], ['Merged PRs', /Median time to merge: 6 minutes/], ['Main', 'locus: red'],
      ['Running jobs', 'claude: 3 of 8'], ['Running jobs', 'grok: 1'], ['Most at risk of going unused', 'claude. 50.0% will expire unused in 10.0h at current burn.'],
      ['Leader', '2 unread replies.']] as const) expect(card(name).getByText(text)).toBeTruthy();
    expect(card('Work log').getAllByRole('listitem')).toHaveLength(2);
  });
  it('empty state: every card says unknown with the reason, and still opens its view', () => {
    show(MISSING, width);
    expect(screen.getByText('Unknown: The job metrics file could not be read.', { selector: 'p' })).toBeTruthy();
    for (const name of CARDS) expect(card(name).getAllByText(/^Unknown: .+\.$/).length).toBeGreaterThan(0);
    expect(card('Main').getByText('Unknown: The main guardian status could not be read.')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(7);
  });
  it('says so before the summary arrives and when it cannot be read', () => {
    show(undefined, width);
    expect(screen.getByText('Reading fleet health…')).toBeTruthy(); cleanup();
    show({ error: 'nope' }, width);
    expect(screen.getByText('Fleet health: unknown (the summary could not be read).')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(1);
  });
});
it('each action opens the existing detailed view', () => {
  show(HEALTHY);
  for (const [name, action, paneId] of [['Merged PRs', 'Open Throughput', 'fleet-throughput'], ['Running jobs', 'Open Lanes', 'fleet-lanes'], ['Most at risk of going unused', 'Open Usage', 'fleet-usage']] as const) {
    fireEvent.click(card(name).getByRole('button', { name: action }));
    expect(state.openDockPane).toHaveBeenLastCalledWith(paneId);
    expect(getVerseUiState().section).toBe('chat');
  }
  for (const [name, action] of [['Main', 'Open Fleet'], ['Work log', 'Open Work log'], ['Leader', 'Open Leader']] as const) fireEvent.click(card(name).getByRole('button', { name: action }));
  expect([getVerseUiState().section, window.location.hash, localStorage.getItem(HOME_VIEW_STORAGE_KEY)]).toEqual(['fleet', '#/work/log', 'leader']);
});
it('quiet fleet: zero and nothing are words, not unknown', () => {
  show({ ...HEALTHY, atRisk: { state: 'ok', value: null }, worklog: { state: 'ok', value: [] }, unreadLeaderReplies: { state: 'ok', value: 0 } });
  expect(card('Most at risk of going unused').getByText('Nothing is set to expire unused.')).toBeTruthy();
  expect(card('Work log').getByText('No work recorded in the last 24 hours.')).toBeTruthy();
  expect(card('Leader').getByText('No unread replies.')).toBeTruthy();
});
it('is one column at every width: no grid, no row and no width breakpoint', () => {
  const css = readFileSync(join(process.cwd(), 'src/web-ui/routes/verse/home/home.module.css'), 'utf8');
  expect(css).toMatch(/\.root\s*\{[^}]*flex-direction:\s*column/);
  expect(css).not.toMatch(/display:\s*grid|flex-direction:\s*row|@media|min-width:\s*[1-9]/);
});
