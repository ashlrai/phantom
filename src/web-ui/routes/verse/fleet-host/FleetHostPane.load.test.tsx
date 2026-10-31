import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetHostPane } from './FleetHostPane.js';

const snapshot = {
  v: 1, generatedAt: '', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: 40, diskFreeGb: 30, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const notice = 'Workers are starving for CPU; lower lane targets in the Lanes pane.';
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('shows overloaded host load and the actionable warning first', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...snapshot, host: { load1: 194, load5: 180, load15: 160, cores: 18, ratio: 10.8 } })));
  render(<FleetHostPane visible />);
  const text = await screen.findByText('Load 194 on 18 cores (10.8×)');
  expect(text.closest('[data-tone]')).toHaveAttribute('data-tone', 'bad');
  expect(text.closest('[data-tone]')?.parentElement?.firstElementChild).toBe(text.closest('[data-tone]'));
  expect(screen.getByText(notice)).toBeInTheDocument();
});
it('shows unknown load without a warning for an older server', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)));
  render(<FleetHostPane visible />);
  expect(await screen.findByText('Load unknown')).toBeInTheDocument();
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
});
