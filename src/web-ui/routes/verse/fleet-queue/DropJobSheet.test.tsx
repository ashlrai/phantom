import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setMutationToken, clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { DropJobSheet } from './DropJobSheet.js';
beforeEach(() => { sessionStorage.clear(); evictAll(); setMutationToken('fake-test-token'); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });
it('blocks invalid drafts and suggests an editable id', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<DropJobSheet open onClose={() => {}} />);
  expect(screen.getByRole('button', { name: 'Write' })).toBeDisabled();
  expect(screen.getByText('Body must not be empty.')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Fix the queue' } });
  expect((screen.getByLabelText('Id') as HTMLInputElement).value).toMatch(/^FIXTHEQUEUE\d{2}$/);
  fireEvent.change(screen.getByLabelText('Id'), { target: { value: 'abc' } });
  expect(screen.getByRole('button', { name: 'Write' })).toBeDisabled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Lane')).toHaveValue('codex-personal');
  expect(screen.getByLabelText('Tier')).toHaveValue('mid');
});
it('writes, keeps routing, and preserves a conflicting draft', async () => {
  let posts = 0;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST'
    ? ++posts === 1 ? Response.json({ v: 1, status: 'written', file: 'RQ-PHX-ABC.md', bytes: 73, at: '2026-11-01' }, { status: 201 }) : Response.json({ status: 'exists' }, { status: 409 })
    : Response.json({ v: 1, items: [] }));
  vi.stubGlobal('fetch', fetcher);
  sessionStorage.setItem('phantom.drop-job-draft.v1', JSON.stringify({ id: 'ABC', lane: 'devin', tier: 'work', body: 'Fix the queue' }));
  const view = render(<DropJobSheet open onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  expect(await screen.findByText('Written RQ-PHX-ABC.md (73 bytes)')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText('Body')).toHaveValue(''));
  expect(screen.getByLabelText('Lane')).toHaveValue('devin');
  expect(screen.getByLabelText('Tier')).toHaveValue('work');
  await waitFor(() => expect(screen.getByLabelText('Body')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Another useful job' } });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  expect(await screen.findByText('A job with this id already exists')).toBeInTheDocument();
  view.unmount();
  render(<DropJobSheet open onClose={() => {}} />);
  expect(screen.getByLabelText('Body')).toHaveValue('Another useful job');
  expect(screen.getByLabelText('Lane')).toHaveValue('devin');
});
it('uses the existing action lock and dispatch-disabled sentence', async () => {
  const fetcher = vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  render(<DropJobSheet open onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Fix useful things' } });
  clearMutationToken();
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  expect(await screen.findByText('Unlock actions with the mutation token before changing the loop.')).toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  setMutationToken('fake-test-token');
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  expect(await screen.findByText('This server was started without --allow-dispatch, so mutations are disabled.')).toBeInTheDocument();
  expect(screen.getByLabelText('Body')).toHaveValue('Fix useful things');
});
