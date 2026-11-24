/** Home's board: the cards sit in two named groups, which are the columns of a wide pane and follow each other in a narrow one. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HomeSummary } from '../../../../core/fleet/home.js';
import { HomePane } from './HomePane.js';

const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown }));
// One mocked read serves every query: the cards with a read of their own see a home.v1 body and stay hidden, as in HomePane.test.tsx.
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => vi.fn(), useMutationHold: () => ({ hasHold: false, token: null, touch: vi.fn() }) }));
const SUMMARY: HomeSummary = {
  schema: 'home.v1', asOf: '2026-11-17T12:00:00.000Z', health: 'healthy', headline: 'Healthy: 2 PRs merged in the last hour and main is green.',
  mergedLastHour: { state: 'ok', value: 2 }, merged24h: { state: 'ok', value: 31 }, medianMergeSeconds: { state: 'ok', value: 360 },
  main: { state: 'ok', value: [{ repo: 'phantom', state: 'green' }] }, running: { state: 'ok', value: [{ lane: 'claude', running: 3, target: 8 }] },
  atRisk: { state: 'ok', value: null }, worklog: { state: 'ok', value: [] }, unreadLeaderReplies: { state: 'ok', value: 0 }, needsYou: { state: 'ok', value: [] },
};
const AGENTS = 'Agents and machines';
const RESOURCES = 'Usage and delivery';
const pane = () => <HomePane {...({ visible: true } as Parameters<typeof HomePane>[0])} />;
const cardsIn = (group: string) => within(screen.getByRole('group', { name: group })).getAllByRole('region').map(node => node.getAttribute('aria-label'));

beforeEach(() => { state.status = 'success'; state.data = undefined; localStorage.clear(); });
afterEach(cleanup);

it('files every card under one of two named groups, agents and machines first', () => {
  state.data = SUMMARY;
  render(pane());
  expect(screen.getAllByRole('group').map(node => node.getAttribute('aria-labelledby') && within(node).getAllByRole('heading', { level: 2 })[0]!.textContent))
    .toEqual([AGENTS, RESOURCES]);
  expect(cardsIn(AGENTS)).toEqual(['Leader', 'Running jobs', 'Main']);
  expect(cardsIn(RESOURCES)).toEqual(['Pools', 'Yield', 'Most at risk of going unused', 'Merged PRs', 'Work log']);
  // No card is left outside the groups, and the health line stays above both.
  const home = screen.getByRole('region', { name: 'Home' });
  expect([...home.querySelectorAll('section')].filter(card => card.closest('[role="group"]') === null)).toEqual([]);
  const headline = screen.getByText(SUMMARY.headline);
  expect(headline.compareDocumentPosition(screen.getByRole('group', { name: AGENTS }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

it('names each group with a heading the card titles sit under', () => {
  state.data = SUMMARY;
  render(pane());
  for (const name of [AGENTS, RESOURCES]) {
    const group = within(screen.getByRole('group', { name }));
    expect(group.getByRole('heading', { level: 2, name })).toBeTruthy();
    expect(group.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
  }
});

it('has the same two groups before the summary arrives, and an open pool stays open when it does', () => {
  const view = render(pane());
  expect(screen.getByText('Reading fleet health…')).toBeTruthy();
  expect(screen.getAllByRole('group').map(node => within(node).getByRole('heading', { level: 2 }).textContent)).toEqual([AGENTS, RESOURCES]);
  expect(cardsIn(RESOURCES)).toEqual(['Pools', 'Yield']);
  const pool = () => within(screen.getByRole('region', { name: 'Pools' })).getAllByRole('button')[0]!;
  expect(pool().getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(pool());
  expect(pool().getAttribute('aria-expanded')).toBe('true');
  state.data = SUMMARY;
  view.rerender(pane());
  expect(screen.getByText(SUMMARY.headline)).toBeTruthy();
  expect(pool().getAttribute('aria-expanded')).toBe('true');
});

it('keeps the groups when the summary cannot be read', () => {
  state.status = 'error';
  render(pane());
  expect(screen.getByText('Fleet health: unknown (the summary could not be read).')).toBeTruthy();
  expect(screen.getAllByRole('group')).toHaveLength(2);
});
