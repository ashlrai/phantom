import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { IdeasPane } from './IdeasPane.js';

/**
 * IdeasPane.notnow.test.tsx — "Not now" dismissal on an Ideas row
 * (RQ-PHX-IDEANOTNOW94): the reason form, the optimistic hide with rollback,
 * the Show dismissed toggle, and the hide/return rules for server verdicts.
 * IdeaSteer's own "Not now" button (fleet inbox steer) is a different control;
 * the dismissal opener is queried by its aria-label.
 */

const item = (i: number, extra: object = {}) => ({ id: `id${i}`, title: `Idea ${i}`, repo: 'org/alpha', score: 100 - i, source: 'issue', ...extra });
const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const isoDaysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => { evictAll(); setMutationToken('tok'); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

describe('IdeasPane not-now dismissal', () => {
  it('posts the verdict with the reason and removes the row', async () => {
    const stub = stubSurfaceFetch({ routes: { '/api/backlog': [item(1), item(2)] },
      post: () => reply({ ok: true, entry: { ideaId: 'id1', verdict: 'not-now', reason: 'later this quarter', at: new Date().toISOString() } }) });
    render(<IdeasPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now — dismiss idea: Idea 1' }));
    const input = screen.getByLabelText('Reason for dismissing idea: Idea 1');
    fireEvent.change(input, { target: { value: 'later this quarter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm not now' }));
    await waitFor(() => expect(screen.queryByText('Idea 1')).toBeNull());
    expect(screen.getByText('Idea 2')).toBeInTheDocument();
    expect(stub.posted).toEqual([{ url: '/api/ideas/verdict', body: { ideaId: 'id1', verdict: 'not-now', reason: 'later this quarter' } }]);
  });

  it('Never posts verdict=never without needing a reason', async () => {
    const stub = stubSurfaceFetch({ routes: { '/api/backlog': [item(1)] },
      post: () => reply({ ok: true, entry: { ideaId: 'id1', verdict: 'never', reason: '', at: new Date().toISOString() } }) });
    render(<IdeasPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now — dismiss idea: Idea 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Never' }));
    await waitFor(() => expect(screen.queryByText('Idea 1')).toBeNull());
    expect(stub.posted[0]!.body).toEqual({ ideaId: 'id1', verdict: 'never' });
    expect(await screen.findByText(/Every idea here is dismissed/)).toBeInTheDocument();
  });

  it('Escape closes the reason form without posting', async () => {
    const stub = stubSurfaceFetch({ routes: { '/api/backlog': [item(1)] } });
    render(<IdeasPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now — dismiss idea: Idea 1' }));
    fireEvent.keyDown(screen.getByLabelText('Reason for dismissing idea: Idea 1'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Reason for dismissing idea: Idea 1')).toBeNull());
    expect(stub.posted).toHaveLength(0);
    expect(screen.getByText('Idea 1')).toBeInTheDocument();
  });

  it('Cancel closes the reason form without posting', async () => {
    const stub = stubSurfaceFetch({ routes: { '/api/backlog': [item(1)] } });
    render(<IdeasPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now — dismiss idea: Idea 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Reason for dismissing idea: Idea 1')).toBeNull();
    expect(stub.posted).toHaveLength(0);
  });

  it('Show dismissed reveals the row with the reason', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': [item(1), item(2)] },
      post: () => reply({ ok: true, entry: { ideaId: 'id1', verdict: 'not-now', reason: 'busy', at: new Date().toISOString() } }) });
    render(<IdeasPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now — dismiss idea: Idea 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm not now' }));
    await waitFor(() => expect(screen.queryByText('Idea 1')).toBeNull());
    fireEvent.click(screen.getByRole('checkbox', { name: /Show dismissed/ }));
    expect(await screen.findByText('Idea 1')).toBeInTheDocument();
    expect(screen.getByText(/You said not now on .*busy/)).toBeInTheDocument();
  });

  it('restores the row with an alert when the post fails', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': [item(1)] },
      post: () => reply({ error: 'no' }, 500) });
    render(<IdeasPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now — dismiss idea: Idea 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm not now' }));
    expect(await screen.findByText('Idea 1')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('hides a server-side "never" verdict until Show dismissed is on', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': [
      item(1, { verdict: { verdict: 'never', reason: 'dropped on purpose', at: isoDaysAgo(30) } }),
      item(2),
    ] } });
    render(<IdeasPane />);
    expect(await screen.findByText('Idea 2')).toBeInTheDocument();
    expect(screen.queryByText('Idea 1')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Show dismissed/ }));
    expect(await screen.findByText('Idea 1')).toBeInTheDocument();
    expect(screen.getByText(/You said never on .*dropped on purpose/)).toBeInTheDocument();
  });

  it('returns a "not now" row after seven days with the note line', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': [
      item(1, { verdict: { verdict: 'not-now', reason: 'busy', at: isoDaysAgo(8) } }),
    ] } });
    render(<IdeasPane />);
    expect(await screen.findByText('Idea 1')).toBeInTheDocument();
    expect(screen.getByText(/You said not now on .*busy/)).toBeInTheDocument();
  });

  it('keeps a recent "not now" hidden', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': [
      item(1, { verdict: { verdict: 'not-now', reason: '', at: isoDaysAgo(2) } }),
    ] } });
    render(<IdeasPane />);
    expect(await screen.findByText(/Every idea here is dismissed/)).toBeInTheDocument();
    expect(screen.queryByText('Idea 1')).toBeNull();
  });
});
