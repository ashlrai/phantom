import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { JobDetailSheet } from './JobDetailSheet.js';
import { WorkersCard } from './WorkersCard.js';

const job = 'RQ-PHX-FAKE';
const detail = { schema: 'fleet.job.v1', job, state: 'running', branch: 'fake-branch', notes: { hasNotes: true }, lane: 'codex-personal',
  log: { source: 'live', tail: [] }, sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
const notes = { v: 1, job, kind: 'notes', state: 'ok', bytes: 10, truncated: false, text: 'Closes #12' };
const snapshot = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { workers: 'healthy' }, workers: [{ job, repo: 'ashlrai/verse', lane: 'work', tier: 'mid', ageSeconds: 10 }], publishesLastHour: [] };

beforeEach(() => {
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.startsWith('/api/fleet/job/text?') ? Response.json(notes)
    : path === '/api/verse/fleet/runs' ? Response.json(snapshot) : Response.json(detail)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); });

it('links closing issues to the supplied repository', async () => {
  render(<JobDetailSheet job={job} repo="ashlrai/verse" onClose={vi.fn()} />);
  const section = await screen.findByRole('region', { name: 'Bridge notes' });
  const link = await within(section).findByRole('link', { name: '#12' });
  expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/verse/issues/12');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

it.each([null, undefined, 'ashlrai/verse/extra', 'ashlrai/verse\n', '../repo'])('renders issue text for an unknown or malformed repository: %s', async repo => {
  render(<JobDetailSheet job={job} repo={repo} onClose={vi.fn()} />);
  const section = await screen.findByRole('region', { name: 'Bridge notes' });
  const issue = await within(section).findByTitle('repository unknown');
  expect(issue).toHaveTextContent('#12');
  expect(within(section).queryByRole('link', { name: '#12' })).not.toBeInTheDocument();
});

it('passes the selected worker repository to the sheet', async () => {
  render(<WorkersCard />);
  fireEvent.click(await screen.findByRole('button', { name: `Job ${job}` }));
  expect(await screen.findByRole('link', { name: '#12' })).toHaveAttribute('href', 'https://github.com/ashlrai/verse/issues/12');
});

it('copies the branch and reports success', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
  expect(writeText).toHaveBeenCalledWith('fake-branch');
  expect(await screen.findByText('Copied')).toHaveAttribute('role', 'status');
});

it('reports clipboard failure', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
  expect(await screen.findByText('Copy failed')).toHaveAttribute('role', 'status');
});
