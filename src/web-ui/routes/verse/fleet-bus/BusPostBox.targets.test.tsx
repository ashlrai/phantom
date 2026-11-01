import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { setMutationToken, clearMutationToken } from '../../../data/auth-store.js';
import { apiPost } from '../../../data/client.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { BusPostBox } from './BusPostBox.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiPost: vi.fn() }));
const snapshot = { lanes: [{ lane: 'build' }], workers: [
  { job: 'RQ-P-OLD', ageSeconds: 60 }, { job: 'RQ-P-NEW', ageSeconds: 2 },
] } as FleetRuns;
afterEach(() => { cleanup(); evictAll(); clearMutationToken(); });

it('groups live targets and posts to the chosen worker', async () => {
  vi.spyOn(opsRunsQuery, 'fetch').mockResolvedValue(snapshot);
  vi.mocked(apiPost).mockResolvedValue({ status: 'posted', cursor: 1 });
  setMutationToken('a'.repeat(64));
  render(<BusPostBox senders={['agent', 'build']} prefill={null} onPosted={() => {}} />);
  const worker = await screen.findByRole('option', { name: 'RQ-P-NEW' });
  expect(within(screen.getByRole('group', { name: 'Leaders' })).getByRole('option')).toHaveTextContent('leaders');
  expect(within(screen.getByRole('group', { name: 'Lanes' })).getByRole('option')).toHaveTextContent('build');
  expect(within(screen.getByRole('group', { name: 'Workers' })).getAllByRole('option').map(item => item.textContent)).toEqual(['RQ-P-NEW', 'RQ-P-OLD']);
  expect(within(screen.getByRole('group', { name: 'Recent senders' })).getByRole('option')).toHaveTextContent('agent');
  fireEvent.change(screen.getByLabelText('To'), { target: { value: worker.getAttribute('value') } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/Posted/);
  expect(apiPost).toHaveBeenCalledWith('/api/verse/agent-bus', expect.objectContaining({ to: 'RQ-P-NEW' }), expect.any(String));
});

it('inserts a selected mention with Enter and supports Escape', async () => {
  vi.spyOn(opsRunsQuery, 'fetch').mockResolvedValue(snapshot);
  render(<BusPostBox senders={[]} prefill={null} onPosted={() => {}} />);
  await screen.findByRole('option', { name: 'RQ-P-NEW' });
  const input = screen.getByLabelText('Message');
  fireEvent.change(input, { target: { value: '@RQ-P' } });
  expect(screen.getByRole('listbox', { name: 'Running jobs' })).toBeInTheDocument();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input).toHaveValue('@RQ-P-OLD ');
  fireEvent.change(input, { target: { value: '@RQ-P' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

it('keeps recent senders when live runs fails', async () => {
  vi.spyOn(opsRunsQuery, 'fetch').mockRejectedValue(new Error('offline'));
  render(<BusPostBox senders={['agent']} prefill={null} onPosted={() => {}} />);
  expect(screen.getByRole('option', { name: 'leaders' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'agent' })).toBeInTheDocument();
});
