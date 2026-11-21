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
// One mocked read serves every query, so the Approvals card sees a home.v1 body and stays hidden (ApprovalsCard.test.tsx covers it).
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => vi.fn(), useMutationHold: () => ({ hasHold: false, token: null, touch: vi.fn() }) }));
vi.mock('../dock/dock-store.js', async original => ({ ...await original<typeof import('../dock/dock-store.js')>(), openDockPane: state.openDockPane }));
const unknown = (reason: string) => ({ state: 'unknown' as const, reason });
const HEALTHY: HomeSummary = {
  schema: 'home.v1', asOf: '2026-11-17T12:00:00.000Z', health: 'healthy', headline: 'Healthy: 2 PRs merged in the last hour and main is green.',
  mergedLastHour: { state: 'ok', value: 2 }, merged24h: { state: 'ok', value: 31 }, medianMergeSeconds: { state: 'ok', value: 360 },
  main: { state: 'ok', value: [{ repo: 'phantom', state: 'green' }, { repo: 'locus', state: 'red' }] },
  running: { state: 'ok', value: [{ lane: 'claude', running: 3, target: 8 }, { lane: 'grok', running: 1, target: null }] },
  atRisk: { state: 'ok', value: { resource: 'claude', percentUnused: 50, resetAt: '2026-11-17T22:00:00.000Z', reason: '50.0% will expire unused in 10.0h at current burn.', usedPercent: 40, burnPctPerHour: 1 } },
  worklog: { state: 'ok', value: [{ at: '2026-11-17T11:50:00.000Z', kind: 'merged', text: 'Merged a fake change', url: null }, { at: '2026-11-17T11:40:00.000Z', kind: 'leader', text: 'Leader: a fake reply', url: null }] },
  unreadLeaderReplies: { state: 'ok', value: 2 }, needsYou: { state: 'ok', value: [] },
};
const MISSING: HomeSummary = {
  schema: 'home.v1', asOf: HEALTHY.asOf, health: 'unknown', headline: 'Unknown: The job metrics file could not be read.',
  mergedLastHour: unknown('The job metrics file could not be read.'), merged24h: unknown('The job metrics file could not be read.'), medianMergeSeconds: unknown('The job metrics file could not be read.'),
  main: unknown('The main guardian status could not be read.'), running: unknown('No fleet status has been written yet.'), unreadLeaderReplies: unknown('No leader plan log has been written yet.'),
  atRisk: unknown('No resource has a fresh usage reading, a burn rate and a future reset.'), worklog: unknown('No jobs ledger has been written yet.'), needsYou: unknown('The needs-you ledger could not be read.'),
};
// Group order: agents and machines, then usage and delivery (HomePane.board.test.tsx covers the groups).
const CARDS = ['Leader', 'Running jobs', 'Main', 'Pools', 'Most at risk of going unused', 'Merged PRs', 'Work log'];
let viewport: ViewportMock | null = null;
const show = (data: unknown, width = 1440) => {
  viewport = mockViewport(width); state.data = data;
  return render(<HomePane {...({ visible: true } as Parameters<typeof HomePane>[0])} />);
};
const card = (name: string) => within(screen.getByRole('region', { name }));
beforeEach(() => { state.status = 'success'; state.openDockPane.mockClear(); localStorage.clear(); resetHomeChoice(); resetVerseUi(); window.location.hash = ''; });
afterEach(() => { cleanup(); viewport?.restore(); });
describe.each([['desktop width', 1440], ['390 px', 390]])('Home at %s', (_name, width) => {
  it('shows the headline and the cards in group order, each with one action', () => {
    const view = show(HEALTHY, width);
    expect(screen.getByText(HEALTHY.headline).getAttribute('data-health')).toBe('healthy');
    const cards = [...view.container.querySelectorAll('section section')];
    expect(cards.map(node => node.getAttribute('aria-label'))).toEqual(CARDS);
    // Pools is a bar of eight pool tiles above its one action.
    for (const node of cards) expect(node.querySelectorAll('button')).toHaveLength(node.getAttribute('aria-label') === 'Pools' ? 9 : 1);
    for (const [name, text] of [['Merged PRs', /Last hour: 2/], ['Merged PRs', /Last 24 hours: 31/], ['Merged PRs', /Median time to merge: 6 minutes/], ['Main', 'locus: red'],
      ['Running jobs', 'claude: 3 of 8'], ['Running jobs', 'grok: 1'], ['Most at risk of going unused', 'claude. 50.0% will expire unused in 10.0h at current burn.'],
      ['Leader', '2 unread replies.']] as const) expect(card(name).getByText(text)).toBeTruthy();
    expect(card('Work log').getAllByRole('listitem')).toHaveLength(2);
  });
  it('empty state: every card says unknown with the reason, and still opens its view', () => {
    show(MISSING, width);
    expect(screen.getByText('Unknown: The job metrics file could not be read.', { selector: 'p' })).toBeTruthy();
    for (const name of CARDS.filter(name => name !== 'Pools')) expect(card(name).getAllByText(/^Unknown: .+\.$/).length).toBeGreaterThan(0);
    expect(card('Main').getByText('Unknown: The main guardian status could not be read.')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(15);
  });
  it('says so before the summary arrives and when it cannot be read', () => {
    show(undefined, width);
    expect(screen.getByText('Reading fleet health…')).toBeTruthy(); cleanup();
    show({ error: 'nope' }, width);
    expect(screen.getByText('Fleet health: unknown (the summary could not be read).')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(9);
  });
});
it('each action opens the existing detailed view', () => {
  show(HEALTHY);
  for (const [name, action, paneId] of [['Pools', 'Open Pools', 'fleet-pools'], ['Merged PRs', 'Open Throughput', 'fleet-throughput'], ['Running jobs', 'Open Lanes', 'fleet-lanes'], ['Most at risk of going unused', 'Open Usage', 'fleet-usage']] as const) {
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
it('draws each reading beside its words: a state mark per repo and a bar per lane that has a target', () => {
  show(HEALTHY);
  expect(card('Main').getByText('phantom: green').getAttribute('data-state')).toBe('green');
  expect(card('Main').getByText('locus: red').getAttribute('data-state')).toBe('red');
  // 3 of 8 is drawn; grok has no recorded target, so it has no bar rather than an invented one.
  const bars = card('Running jobs').getAllByRole('meter');
  expect(bars.map(bar => [bar.getAttribute('aria-label'), bar.getAttribute('aria-valuenow')])).toEqual([['claude running of target', '38']]);
  // The mocked read is not a runway report, so every pool bar is unknown: no value, never 0.
  for (const bar of card('Pools').getAllByRole('meter')) expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuetext')]).toEqual([null, 'unknown']);
});
it('says when the summary was read, and that it is an old reading when the refresh failed', () => {
  const view = show(HEALTHY);
  const fresh = view.container.querySelector('time[datetime="2026-11-17T12:00:00.000Z"]')?.parentElement;
  expect(fresh?.textContent).toMatch(/^As of .+\.$/);
  expect(fresh?.getAttribute('role')).toBeNull();
  cleanup(); state.status = 'error';
  show(HEALTHY);
  const stale = screen.getAllByRole('status').find(node => node.hasAttribute('data-stale'));
  expect(stale?.textContent).toMatch(/^Could not refresh\. Showing the reading from .+\.$/);
  expect(screen.getByText(HEALTHY.headline)).toBeTruthy();
  cleanup(); state.status = 'success';
  show({ ...HEALTHY, asOf: 'not a time' });
  expect(screen.getByText('As of an unknown time.')).toBeTruthy();
});
it('every color and size the Home styles name is a real design token', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), 'src/web-ui', path), 'utf8');
  const defined = new Set((read('design/tokens.css') + read('design/global.css')).match(/--[\w-]+(?=\s*:)/g));
  for (const file of ['home.module.css', 'this-mac.module.css', 'approvals.module.css']) {
    const used = [...new Set(read(`routes/verse/home/${file}`).match(/(?<=var\()--[\w-]+/g))];
    expect(used.filter(name => !defined.has(name)), file).toEqual([]);
  }
});
it('is one column until the pane itself is wide: the only grid sits in one container rule, and the window is never asked', () => {
  const css = readFileSync(join(process.cwd(), 'src/web-ui/routes/verse/home/home.module.css'), 'utf8');
  expect(css).toMatch(/\.root\s*\{[^}]*flex-direction:\s*column/);
  expect(css).toMatch(/\.root\s*\{[^}]*container-type:\s*inline-size/);
  expect(css.match(/@container/g)).toHaveLength(1);
  const at = css.indexOf('@container');
  // Below the board's width nothing sits side by side, and a narrow pane keeps the 44rem reading column.
  expect(css.slice(0, at)).not.toMatch(/display:\s*grid|flex-direction:\s*row|min-width:\s*[1-9]/);
  expect(css.slice(0, at)).toMatch(/\.root > \*\s*\{[^}]*max-width:\s*44rem/);
  expect(css.slice(at)).toMatch(/^@container \(min-width: 64rem\)/);
  expect(css.slice(at)).toMatch(/\.board\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);\s*align-items:\s*start/);
  expect(css).not.toMatch(/@media/);
});
