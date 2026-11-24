/** Home shows the Blocked card before Pools in both layouts; its action opens Lanes. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import { HomePane } from './HomePane.js';

const state = vi.hoisted(() => ({ reads: {} as Record<string, { status: string; data: unknown; error?: unknown }>, openDockPane: vi.fn() }));
// Only the keys a test sets have an answer; every other card is still loading and stays hidden.
vi.mock('../../../data/hooks.js', () => ({ useQuery: (def: { key: string }) => state.reads[def.key] ?? { status: 'loading', data: undefined },
  useRefetch: () => vi.fn(), useMutationHold: () => ({ hasHold: false, token: null, touch: vi.fn() }) }));
vi.mock('../dock/dock-store.js', async original => ({ ...await original<typeof import('../dock/dock-store.js')>(), openDockPane: state.openDockPane }));

const AT = '2026-11-17T12:00:00.000Z';
const unknown = { state: 'unknown', reason: 'Not read in this test.' };
const HOME = { schema: 'home.v1', asOf: AT, health: 'unknown', headline: 'Unknown: not read in this test.', mergedLastHour: unknown, merged24h: unknown, medianMergeSeconds: unknown,
  main: unknown, running: unknown, atRisk: unknown, worklog: unknown, unreadLeaderReplies: unknown, needsYou: unknown };
const BLOCKED = {
  'home-blocked-live': { status: 'success', data: { v: 1, generatedAt: AT, summary: { parked: 0 }, blockedHolds: [{ repo: 'ashlrai/phantom', reason: 'Main is red.', until: null }] } },
  'verse-fleet-launch-stall': { status: 'success', data: null },
};
const show = (reads: typeof state.reads) => { state.reads = reads; return render(<HomePane {...({ visible: true } as Parameters<typeof HomePane>[0])} />); };
beforeEach(() => { state.openDockPane.mockClear(); resetVerseUi(); });
afterEach(cleanup);

it('shows what is blocked before the health summary arrives', () => {
  show(BLOCKED);
  expect(screen.getByText('Reading fleet health…')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Blocked' })).getByText('Blocked: 1 repo held.')).toBeTruthy();
});

it('sits between the summary line and Pools, and opens Lanes', () => {
  const view = show({ ...BLOCKED, 'fleet-home': { status: 'success', data: HOME } });
  const cards = [...view.container.querySelectorAll('section section')].map(node => node.getAttribute('aria-label'));
  expect(cards.indexOf('Blocked')).toBe(cards.indexOf('Pools') - 1);
  fireEvent.click(within(screen.getByRole('region', { name: 'Blocked' })).getByRole('button', { name: 'Open Lanes' }));
  expect(state.openDockPane).toHaveBeenLastCalledWith('fleet-lanes');
  expect(getVerseUiState().section).toBe('chat');
});
