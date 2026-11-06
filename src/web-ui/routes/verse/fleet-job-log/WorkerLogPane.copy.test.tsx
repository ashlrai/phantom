import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { WorkerLogPane } from './WorkerLogPane.js';

const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
  workers: [{ job: 'RQ-FAKE', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 60 }],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const detail = { schema: 'fleet.job.v1', state: 'running', lane: 'codex', log: { source: 'live', tail: ['evidence'] } };
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); evictAll(); });

it('copies the selected worker report and shows confirmation', async () => {
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? runs : detail);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  render(<WorkerLogPane visible />);
  await screen.findByRole('log');
  fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
  expect(await screen.findByText('Copied')).toHaveAttribute('role', 'status');
  expect(writeText).toHaveBeenCalledOnce();
  expect(writeText.mock.calls[0]![0]).toMatch(/^### RQ-FAKE\n/);
  expect(writeText.mock.calls[0]![0]).toContain('evidence');
});

it('disables copy for invalid jobs and reports clipboard failures', async () => {
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? runs : detail);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  render(<WorkerLogPane visible />);
  await screen.findByRole('log');
  const button = screen.getByRole('button', { name: 'Copy as Markdown' });
  fireEvent.click(button);
  expect(await screen.findByText('Copy failed')).toHaveAttribute('role', 'status');
  fireEvent.change(screen.getByRole('textbox', { name: 'Job ID' }), { target: { value: '../bad' } });
  expect(button).toBeDisabled();
});
