import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { markFromRuns } from '../fleet/visit-delta.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetBriefPane } from './FleetBriefPane.js';

const key = 'phantom.fleet-brief.visit.v1';
const older: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, host: null,
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: 4, mergeRate24h: null }],
  workers: [], claimed: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const newer: FleetRuns = { ...older, generatedAt: '2026-10-31T12:15:00Z', lanes: [{ ...older.lanes[0]!, merged24h: 5 }] };
const mark = (runs: FleetRuns) => markFromRuns({ ...runs, host: runs.host ?? null }, Date.parse(runs.generatedAt));

beforeEach(() => {
  evictAll(); localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(newer)));
});
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows and copies the delta before the brief and saves the latest visit on unmount', async () => {
  localStorage.setItem(key, JSON.stringify(mark(older)));
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const view = render(<FleetBriefPane visible />);
  const status = await screen.findByText('Since you last looked (15 min ago): +1 merge');
  expect(status).toHaveAttribute('role', 'status');
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^Since you last looked \(15 min ago\): \+1 merge\nPhantom fleet /)));
  view.unmount();
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(mark(newer));
});

it('shows no visit line when storage is empty', async () => {
  render(<FleetBriefPane visible />);
  await screen.findByRole('textbox', { name: 'Fleet brief text' });
  expect(screen.queryByText(/Since you last looked/)).not.toBeInTheDocument();
});

it('saves on hide and uses that mark when the pane reopens', async () => {
  const view = render(<FleetBriefPane visible />);
  await screen.findByRole('textbox', { name: 'Fleet brief text' });
  view.rerender(<FleetBriefPane visible={false} />);
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(mark(newer));
  view.rerender(<FleetBriefPane visible />);
  expect(screen.queryByText(/Since you last looked/)).not.toBeInTheDocument();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(mark(newer));
  delete (document as { visibilityState?: string }).visibilityState;
});

it('ignores malformed stored marks', async () => {
  localStorage.setItem(key, '{"at":"invalid"}');
  render(<FleetBriefPane visible />);
  await screen.findByRole('textbox', { name: 'Fleet brief text' });
  expect(screen.queryByText(/Since you last looked/)).not.toBeInTheDocument();
});
