import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { IdeasPane } from './IdeasPane.js';

const item = (i: number) => ({ id: `id${i}`, title: `Idea ${i}`, repo: 'org/alpha', score: 100 - i, source: 'issue' });
const reply = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { evictAll(); setMutationToken('tok'); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

describe('IdeasPane draft actions', () => {
  it('Draft job posts the idea id and shows the draft id with a clear check', async () => {
    const stub = stubSurfaceFetch({ routes: { '/api/backlog': [item(1), item(2)] },
      post: () => reply({ draftId: 'IDEAABC', collisions: [], written: true, existing: false }) });
    render(<IdeasPane />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Draft job' }))[0]!);
    const chip = await screen.findByTestId('idea-draft-chip');
    expect(stub.posted).toEqual([{ url: '/api/ideas/draft', body: { ideaIds: ['id1'] } }]);
    expect(chip).toHaveTextContent('IDEAABC');
    expect(chip).toHaveTextContent('no collisions');
    expect(chip).toHaveTextContent('queued');
  });

  it('Draft together posts the checked ideas once', async () => {
    const stub = stubSurfaceFetch({ routes: { '/api/backlog': [item(1), item(2), item(3)] },
      post: () => reply({ draftId: 'IDEABATCH', collisions: [], written: true, existing: false }) });
    render(<IdeasPane />);
    const together = await screen.findByRole('button', { name: 'Draft together' });
    expect(together).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Select Idea 1'));
    fireEvent.click(screen.getByLabelText('Select Idea 3'));
    expect(together).toBeEnabled();
    fireEvent.click(together);
    await waitFor(() => expect(screen.getAllByTestId('idea-draft-chip')).toHaveLength(2));
    expect(stub.posted).toHaveLength(1);
    expect(stub.posted[0]!.body).toEqual({ ideaIds: ['id1', 'id3'] });
  });

  it('shows collisions and re-sends with confirmation on Draft anyway', async () => {
    let calls = 0;
    const stub = stubSurfaceFetch({ routes: { '/api/backlog': [item(1)] },
      post: () => reply(calls++ === 0
        ? { draftId: 'IDEAHELD', collisions: [{ path: 'src/a.ts', queued: ['RQ-PHX-OTHER'] }], written: false, existing: false }
        : { draftId: 'IDEAHELD', collisions: [{ path: 'src/a.ts', queued: ['RQ-PHX-OTHER'] }], written: true, existing: false }) });
    render(<IdeasPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft job' }));
    expect(await screen.findByText(/Collides: src\/a\.ts \(queued: RQ-PHX-OTHER\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Draft anyway' }));
    await waitFor(() => expect(stub.posted).toHaveLength(2));
    expect(stub.posted[1]!.body).toEqual({ ideaIds: ['id1'], confirmCollisions: true });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Draft anyway' })).toBeNull());
  });

  it('says so when actions are locked', async () => {
    clearMutationToken();
    stubSurfaceFetch({ routes: { '/api/backlog': [item(1)] } });
    render(<IdeasPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft job' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unlock actions/);
  });
});
