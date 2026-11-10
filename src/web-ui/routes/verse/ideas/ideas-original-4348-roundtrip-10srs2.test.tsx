import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { IdeasPane } from './IdeasPane.js';

const items = [1, 2].map(i => ({ id: `id${i}`, title: `Idea ${i}`, repo: 'org/alpha', score: 10 - i, source: 'issue' }));
const reply = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { evictAll(); setMutationToken('tok'); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it('sends a single draft only once while pending and shows existing status', async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const stub = stubSurfaceFetch({ routes: { '/api/backlog': items }, post: () => pending });
  render(<IdeasPane />);
  const button = (await screen.findAllByRole('button', { name: 'Draft job' }))[0]!;
  expect(stub.posted).toHaveLength(0);
  fireEvent.click(button); fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(stub.posted).toEqual([{ url: '/api/ideas/draft', body: { ideaIds: ['id1'] } }]);
  resolve(reply({ draftId: 'EXISTING', collisions: [], written: false, existing: true }));
  expect(await screen.findByTestId('idea-draft-chip')).toHaveTextContent('EXISTING');
  expect(screen.getByTestId('idea-draft-chip')).toHaveTextContent('already drafted');
});

it('keeps a batch through collision confirmation and retries a network failure', async () => {
  let calls = 0;
  const stub = stubSurfaceFetch({ routes: { '/api/backlog': items }, post: () => {
    calls++;
    if (calls === 1) return reply({ draftId: 'HELD', collisions: [{ path: 'a', queued: ['other'] }], written: false, existing: false });
    if (calls === 2) return Promise.reject(new TypeError('Network unavailable'));
    return reply({ draftId: 'DONE', collisions: [], written: true, existing: false });
  } });
  render(<IdeasPane />);
  fireEvent.click(await screen.findByLabelText('Select Idea 1'));
  fireEvent.click(screen.getByLabelText('Select Idea 2'));
  fireEvent.click(screen.getByRole('button', { name: 'Draft together' }));
  fireEvent.click((await screen.findAllByRole('button', { name: 'Draft anyway' }))[0]!);
  await screen.findAllByRole('alert');
  expect(screen.getByLabelText('Select Idea 1')).toBeChecked();
  expect(screen.getByLabelText('Select Idea 2')).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Draft together' }));
  await waitFor(() => expect(screen.getAllByTestId('idea-draft-chip')[0]).toHaveTextContent('DONE'));
  expect(stub.posted.map(p => p.body)).toEqual([
    { ideaIds: ['id1', 'id2'] }, { ideaIds: ['id1', 'id2'], confirmCollisions: true }, { ideaIds: ['id1', 'id2'] },
  ]);
});
