import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { buildJobWindow } from '../../../../core/fleet/job-window.js';
import { WorkerLogPane } from './WorkerLogPane.js';

beforeEach(() => {
  evictAll();
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => {
    if (path === '/api/verse/fleet/runs') return {
      v: 1, generatedAt: '2026-11-22T12:00:00Z',
      sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' },
      lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
      workers: [{ job: 'RQ-YOUNG', repo: 'phantom', lane: 'codex', tier: 'work', ageSeconds: 30 },
        { job: 'RQ-OLDER', repo: 'phantom', lane: 'codex', tier: 'work', ageSeconds: 300 }],
      leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] },
      events: [], codexPersonal: null, inbox: [], drop: null,
    };
    const job = new URL(path, 'http://localhost').searchParams.get('id');
    if (path.startsWith('/api/fleet/job/window?')) return buildJobWindow({ job: job!, detailState: job === 'RQ-DONE' ? 'archived' : 'running', model: `model-${job}` });
    if (path.startsWith('/api/verse/fleet/runs/notes?')) return {
      schema: 'fleet.job.notes.v1', job, count: 1,
      notes: [{ id: `note-${job}`, at: '2026-11-22T12:00:00Z', text: `instruction for ${job}` }],
    };
    if (path.startsWith('/api/fleet/job?')) return {
      schema: 'fleet.job.v1', job, state: job === 'RQ-DONE' ? 'archived' : 'running',
      log: { source: job === 'RQ-DONE' ? 'archived' : 'live', tail: [`output for ${job}`] },
    };
    return null;
  });
});
afterEach(() => { vi.restoreAllMocks(); evictAll(); });

it('keeps real note/window integration on the selected session across wrapping navigation', async () => {
  render(<WorkerLogPane visible />);
  await screen.findByText('output for RQ-OLDER');
  const picker = screen.getByRole('combobox', { name: 'Worker' });
  const note = screen.getByRole('textbox', { name: 'Note to this job' });
  fireEvent.change(note, { target: { value: 'keep [this] draft' } });
  for (const key of ['[', ']']) fireEvent.keyDown(note, { key });
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) fireEvent.keyDown(screen.getByRole('log'), { key: ']', [modifier]: true });
  expect(picker).toHaveValue('RQ-OLDER');
  expect(note).toHaveValue('keep [this] draft');
  expect(within(screen.getByRole('region', { name: 'Job window' })).getByText('model-RQ-OLDER')).toBeInTheDocument();
  expect(await screen.findByText(/instruction for RQ-OLDER/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Previous session' }));
  await screen.findByText('output for RQ-YOUNG');
  expect(picker).toHaveValue('RQ-YOUNG');
  expect(await screen.findByText('model-RQ-YOUNG')).toBeInTheDocument();
  expect(await screen.findByText(/instruction for RQ-YOUNG/)).toBeInTheDocument();
  expect(screen.queryByText(/instruction for RQ-OLDER/)).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Note to this job' })).toHaveValue('');
  fireEvent.keyDown(screen.getByRole('log'), { key: ']' });
  await screen.findByText('output for RQ-OLDER');
  expect(picker).toHaveValue('RQ-OLDER');
  expect(screen.getByRole('button', { name: 'Copy as Markdown' })).toBeEnabled();
  expect(screen.getByRole('searchbox', { name: 'Find in log' })).toBeInTheDocument();
});

it('returns a retained finished job to running sessions in either direction', async () => {
  render(<WorkerLogPane visible />);
  await screen.findByText('output for RQ-OLDER');
  const id = screen.getByRole('textbox', { name: 'Job ID' });
  fireEvent.change(id, { target: { value: 'RQ-DONE' } });
  await screen.findByText('output for RQ-DONE');
  expect(screen.getByRole('group', { name: 'Step through sessions' })).toHaveTextContent('not listed · 2 running');
  fireEvent.click(screen.getByRole('button', { name: 'Next session' }));
  await screen.findByText('output for RQ-OLDER');
  fireEvent.change(id, { target: { value: 'RQ-DONE' } });
  await screen.findByText('output for RQ-DONE');
  fireEvent.keyDown(screen.getByRole('log'), { key: '[' });
  await screen.findByText('output for RQ-YOUNG');
  expect(screen.getByRole('combobox', { name: 'Worker' })).toHaveValue('RQ-YOUNG');
});
