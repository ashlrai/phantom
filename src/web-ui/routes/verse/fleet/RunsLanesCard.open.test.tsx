import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { openDockPane } from '../dock/dock-store.js';
import { RunsLanesCard } from './RunsLanesCard.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));

const lane = { lane: 'codex-personal', running: 24, target: 24, queued: 2, held: false, heldReason: null, tokensLastHour: 12000, merged24h: 3, mergeRate24h: 0.125 };
const data = { v: 1, generatedAt: '2026-10-31T12:00:40Z', lastTick: '2026-10-31T12:00:00Z', paused: false, switches: [], sources: { runsDir: 'healthy' }, lanes: [lane, { ...lane, lane: 'devin', running: 10, target: 10, queued: 0, held: true, heldReason: 'quota', tokensLastHour: null, merged24h: null }] };
function stub(value: unknown = data, status = 200) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL) => Response.json(value, { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const card = () => <SectionVisibilityProvider visible><RunsLanesCard /></SectionVisibilityProvider>;
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('opens the Lanes pane when a lane name is clicked', async () => {
  stub(); render(card());
  fireEvent.click(await screen.findByRole('button', { name: 'Open Lanes pane for codex-personal' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-lanes');
  fireEvent.click(screen.getByRole('button', { name: 'Open Lanes pane for devin' }));
  expect(openDockPane).toHaveBeenCalledTimes(2);
});

it('opens the Queue pane when a non-zero queued count is clicked', async () => {
  stub(); render(card());
  fireEvent.click(await screen.findByRole('button', { name: 'Open Queue pane, 2 queued in codex-personal' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-queue');
});

it('renders a zero queued count as plain text, not a button', async () => {
  stub(); render(card());
  const table = await screen.findByRole('table');
  const devinRow = within(table).getByTitle('devin').closest('tr')!;
  expect(within(devinRow).queryByRole('button', { name: /Queue pane/ })).not.toBeInTheDocument();
  expect(within(devinRow).getByTitle('held: quota')).toHaveTextContent('0');
});
