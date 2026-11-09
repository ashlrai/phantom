import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExperimentResultV1, HarnessVersion, LearningStateV1 } from '../../../../core/learn/harness-types.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { HarnessActions } from './HarnessActions.js';

vi.mock('../../../data/hooks.js', () => ({ useMutationHold: () => ({ token: 'test-token', touch: vi.fn() }) }));
vi.mock('../../../data/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../data/client.js')>();
  return { ...actual, apiPost: vi.fn() };
});
const active = { id: 'h-1', status: 'active' } as HarnessVersion;
const experiment = { id: 'exp-1', status: 'running' } as ExperimentResultV1;
const state = (overrides: Partial<LearningStateV1> = {}) => ({ active, versions: [active], experiments: [], ...overrides }) as LearningStateV1;
beforeEach(() => { vi.mocked(apiPost).mockReset(); });
afterEach(cleanup);

it('confirms and posts a rollback, then refreshes', async () => {
  const refetch = vi.fn(); vi.mocked(apiPost).mockResolvedValue({ ok: true });
  render(<HarnessActions state={state()} onChanged={refetch} />);
  fireEvent.click(screen.getByRole('button', { name: 'Roll back to Baseline' }));
  expect(apiPost).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm rollback' }));
  await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
  expect(apiPost).toHaveBeenCalledWith('/api/verse/learning/rollback', { toVersionId: null, reason: 'rolled back from Phantom desktop' }, 'test-token');
});
it('posts cancellation and refreshes', async () => {
  const refetch = vi.fn(); vi.mocked(apiPost).mockResolvedValue({ ok: true });
  render(<HarnessActions state={state({ active: null, experiments: [experiment] })} onChanged={refetch} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
  expect(apiPost).toHaveBeenCalledWith('/api/verse/learning/experiments/cancel', { experimentId: 'exp-1', reason: 'cancelled from Phantom desktop' }, 'test-token');
});
it('shows a server refusal without refreshing', async () => {
  const refetch = vi.fn(); vi.mocked(apiPost).mockRejectedValue(new ApiError('failed', 409, '', 'Already finished.'));
  render(<HarnessActions state={state({ experiments: [experiment] })} onChanged={refetch} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Already finished.');
  expect(refetch).not.toHaveBeenCalled();
});
it('hides when there is nothing to act on', () => {
  const { container } = render(<HarnessActions state={state({ active: null })} onChanged={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});
