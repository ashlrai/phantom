import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { WorkerLogPane } from './WorkerLogPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.restoreAllMocks(); evictAll(); });

it('navigates matches, suspends follow, and resumes it after clearing', async () => {
  let tail = ['start', 'ERROR one', 'working', 'ERROR two', 'ERROR three'];
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path.includes('/job/changes') ? null : path.includes('/job?')
    ? { schema: 'fleet.job.v1', state: 'running', log: { source: 'live', tail } }
    : { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' }, lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [], workers: [{ job: 'RQ-ONE', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 60 }], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null });
  render(<WorkerLogPane visible />);
  const log = await screen.findByRole('log');
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 100 });
  const input = screen.getByRole('searchbox', { name: 'Find in log' });
  fireEvent.change(input, { target: { value: 'error' } });
  expect(screen.getByText('1 of 3')).toBeInTheDocument();
  expect(within(log).getByText('ERROR one')).toHaveAttribute('aria-current', 'true');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByText('2 of 3')).toBeInTheDocument();
  expect(within(log).getByText('ERROR two')).toHaveAttribute('aria-current', 'true');
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  expect(screen.getByText('1 of 3')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  expect(screen.getByText('3 of 3')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('1 of 3')).toBeInTheDocument();
  log.scrollTop = 10;
  tail = [...tail, 'new output'];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('new output');
  expect(log.scrollTop).toBe(10);
  expect(screen.getByRole('checkbox', { name: 'Follow' })).toBeChecked();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(input).toHaveValue('');
  log.scrollTop = 10;
  tail = [...tail, 'more output'];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('more output');
  await waitFor(() => expect(log.scrollTop).toBe(100));
}, 15000);
