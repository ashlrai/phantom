import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as auth from '../../../data/auth-store.js';
import { QueueMoveControl } from './QueueMoveControl.js';
import { QUEUE_MOVE_PATH } from './queue-move-action.js';

const fetchMock = vi.fn();
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(auth, 'getMutationToken').mockReturnValue('test-only');
  vi.spyOn(auth, 'touchMutationHold').mockImplementation(() => {});
  vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  const onMoved = vi.fn();
  render(<QueueMoveControl fromLane="source" lanes={['source', 'held', 'devin'].map(lane => ({ lane }))} heldLanes={['source', 'held']} onMoved={onMoved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move Phantom jobs to…' }));
  return onMoved;
}
it('excludes held and source lanes', () => {
  setup();
  expect(screen.queryByRole('option', { name: 'source' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'held' })).toBeNull();
  expect(screen.getByRole('option', { name: 'devin' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'keep tier' })).toBeInTheDocument();
});
it('posts selected lane and tier, disables while pending, and calls onMoved', async () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
  const onMoved = setup();
  fireEvent.change(screen.getByLabelText('Target lane for source'), { target: { value: 'devin' } });
  fireEvent.change(screen.getByLabelText('Tier for source'), { target: { value: 'work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
  expect(screen.getByRole('button', { name: 'Confirm move' })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledWith(QUEUE_MOVE_PATH, expect.objectContaining({ body: JSON.stringify({ fromLane: 'source', lane: 'devin', tier: 'work' }), headers: expect.objectContaining({ 'x-ashlr-token': 'test-only' }) }));
  resolve(new Response(JSON.stringify({ v: 1, applied: true, lane: 'devin', moved: [], skipped: [], verified: null })));
  expect(await screen.findByRole('status')).toHaveTextContent('moved 0 jobs');
  expect(onMoved).toHaveBeenCalledOnce();
});
it('shows a refusal sentence without refreshing', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'REASSIGN_REFUSED', reason: 'lane-held' }), { status: 409 }));
  const onMoved = setup();
  fireEvent.change(screen.getByLabelText('Target lane for source'), { target: { value: 'devin' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Target lane is held.');
  expect(onMoved).not.toHaveBeenCalled();
});
