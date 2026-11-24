import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { JOB_NOTES_PATH, jobSayBody, postJobSay } from './job-note-action.js';
import { JobNoteBox } from './JobNoteBox.js';

const job = 'RQ-FAKE-7';
const note = { id: 'n-1', at: '2026-11-01T00:05:00.000Z', text: 'also update the docs', by: 'cli' };
const listing = (notes: unknown[]) => ({ schema: 'fleet.job.notes.v1', job, count: notes.length, notes });
const said = (status: string, extra: Record<string, unknown> = {}) =>
  ({ schema: 'fleet.job.say.v1', job, status, reason: null, note: null, dryRun: false, duplicate: false, ...extra });

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearMutationToken(); evictAll(); });

it('builds the request and needs the control token before any request', async () => {
  expect(JOB_NOTES_PATH).toBe('/api/verse/fleet/runs/notes');
  expect(jobSayBody(job, 'hi')).toEqual({ id: job, text: 'hi' });
  clearMutationToken();
  const post = vi.spyOn(client, 'apiPost');
  await expect(postJobSay(job, 'hi')).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
});

it('sends a note, clears the box, says so and lists it under Notes sent', async () => {
  const get = vi.spyOn(client, 'apiGet').mockResolvedValueOnce(listing([])).mockResolvedValue(listing([note]));
  const post = vi.spyOn(client, 'apiPost').mockResolvedValue(said('sent', { note }));
  render(<JobNoteBox job={job} open />);
  const box = screen.getByLabelText('Note to this job');
  const send = screen.getByRole('button', { name: 'Send note to this job' });
  expect(send).toBeDisabled();
  fireEvent.change(box, { target: { value: ' also update the docs ' } });
  fireEvent.click(send);
  expect(await screen.findByRole('status')).toHaveTextContent('Note sent to RQ-FAKE-7.');
  expect(post).toHaveBeenCalledWith(JOB_NOTES_PATH, { id: job, text: 'also update the docs' }, 'a'.repeat(64));
  expect(box).toHaveValue('');
  const list = await screen.findByRole('list', { name: 'Notes sent' });
  expect(within(list).getByText('2026-11-01 00:05 · also update the docs')).toBeInTheDocument();
  expect(get).toHaveBeenCalledWith(`${JOB_NOTES_PATH}?id=${job}`, undefined);
});

it('keeps the words and says why when the job has finished', async () => {
  vi.spyOn(client, 'apiGet').mockResolvedValue(listing([]));
  vi.spyOn(client, 'apiPost').mockResolvedValue(said('refused', { reason: 'Job RQ-FAKE-7 has finished, so it cannot read a note.' }));
  render(<JobNoteBox job={job} open />);
  fireEvent.change(screen.getByLabelText('Note to this job'), { target: { value: 'too late' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send note to this job' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Job RQ-FAKE-7 has finished, so it cannot read a note.');
  expect(screen.getByLabelText('Note to this job')).toHaveValue('too late');
});

it('offers no box for a finished job but still lists the notes sent', async () => {
  vi.spyOn(client, 'apiGet').mockResolvedValue(listing([note]));
  render(<JobNoteBox job={job} open={false} />);
  expect(await screen.findByRole('list', { name: 'Notes sent' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Note to this job')).not.toBeInTheDocument();
});

it('renders nothing for a finished job with no notes, or on a server without notes', async () => {
  const get = vi.spyOn(client, 'apiGet').mockResolvedValue(listing([]));
  const view = render(<JobNoteBox job={job} open={false} />);
  await waitFor(() => expect(get).toHaveBeenCalled());
  expect(view.container).toBeEmptyDOMElement();
  cleanup(); evictAll();
  get.mockRejectedValue(new client.ApiError('not found', 404, JOB_NOTES_PATH, 'not found'));
  const old = render(<JobNoteBox job={job} open={false} />);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(old.container).toBeEmptyDOMElement();
});
