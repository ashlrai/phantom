import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { WorkerLogPane } from './WorkerLogPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.restoreAllMocks(); evictAll(); });

it('shows new lines while not following and jumps back to live output', async () => {
  let tail = ['one', 'two', 'three'];
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path.includes('/job/changes') ? null : path.includes('/job?')
    ? { schema: 'fleet.job.v1', state: 'running', log: { source: 'live', bytes: tail.join('\n').length, tail } }
    : { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' }, lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [], workers: [{ job: 'RQ-ONE', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 60 }], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null });
  render(<WorkerLogPane visible />);
  const log = await screen.findByRole('log');
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 100 });
  const follow = screen.getByRole('checkbox', { name: 'Follow' });
  fireEvent.click(follow);
  tail = [...tail, 'four', 'five', 'six'];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  const button = await screen.findByRole('button', { name: '3 new lines ↓' });
  expect(follow).not.toBeChecked();
  fireEvent.click(button);
  expect(follow).toBeChecked();
  expect(log.scrollTop).toBe(100);
  expect(screen.queryByRole('button', { name: /new lines/ })).not.toBeInTheDocument();
  fireEvent.click(follow);
  tail = [...tail, 'seven'];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('button', { name: '1 new line ↓' });
  fireEvent.scroll(log);
  await waitFor(() => expect(screen.queryByRole('button', { name: /new line/ })).not.toBeInTheDocument());
  expect(follow).not.toBeChecked();
}, 15000);
