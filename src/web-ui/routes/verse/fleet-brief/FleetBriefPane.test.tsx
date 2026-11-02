import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetBriefPane } from './FleetBriefPane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], claimed: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const serve = (data: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data, { status })));
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('copies the displayed brief and reports clipboard failures', async () => {
  serve(fixture);
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  render(<FleetBriefPane visible />);
  const field = await screen.findByRole('textbox', { name: 'Fleet brief text' }) as HTMLTextAreaElement;
  expect(field.value).toContain('Lanes: codex 1/2');
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(field.value));
  expect(await screen.findByText('Copied')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  expect(await screen.findByText('Copy failed')).toBeInTheDocument();
});
it('explains a missing endpoint and refreshes', async () => {
  serve({}, 404); render(<FleetBriefPane visible />);
  expect(await screen.findByText('The fleet runs API has not landed in this build yet.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('polls only while visible', async () => {
  vi.useFakeTimers(); serve(fixture);
  const view = render(<FleetBriefPane visible />);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(fetch).toHaveBeenCalledTimes(3);
  view.rerender(<FleetBriefPane visible={false} />);
  await act(async () => { vi.advanceTimersByTime(20_000); });
  expect(fetch).toHaveBeenCalledTimes(3);
});
