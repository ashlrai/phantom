import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { apiGet, ApiError } from '../../../../data/client.js';
import { renderMobile } from '../mobile.test-support.js';
import { WorkerScreen } from './WorkerScreen.js';

vi.mock('../../../../data/client.js', async (original) => ({
  ...await original<typeof import('../../../../data/client.js')>(), apiGet: vi.fn(),
}));
const fixture = {
  schema: 'fleet.job.v1', state: 'running', lane: 'example', model: 'example',
  log: { tail: ['Working', '[redacted line]', '~/project'] },
};
const notice = 'Worker logs are not available through this gateway yet. Open Phantom on your Mac.';
beforeEach(() => {
  const meta = document.createElement('meta');
  meta.name = 'ashlr-remote-gateway'; meta.content = 'v1'; document.head.append(meta);
});
afterEach(() => {
  evictAll(); vi.resetAllMocks(); vi.useRealTimers();
  document.head.querySelector('meta[name="ashlr-remote-gateway"]')?.remove();
});

it('renders the gateway tail and refreshes job detail', async () => {
  vi.mocked(apiGet).mockResolvedValueOnce(fixture)
    .mockResolvedValue({ ...fixture, log: { tail: ['Refreshed'] } });
  renderMobile(<WorkerScreen job="RQ-EXAMPLE" />);
  expect(await screen.findByLabelText('Worker log tail')).toHaveTextContent('[redacted line]');
  expect(screen.queryByText(notice)).toBeNull();
  const scroller = screen.getByLabelText('Worker log tail').parentElement!.parentElement!;
  fireEvent.touchStart(scroller, { touches: [{ clientY: 0 }] });
  fireEvent.touchMove(scroller, { touches: [{ clientY: 200 }] });
  fireEvent.touchEnd(scroller);
  expect(await screen.findByText('Refreshed')).toBeInTheDocument();
  expect(apiGet).toHaveBeenLastCalledWith('/api/fleet/job?id=RQ-EXAMPLE', undefined);
});

it('polls the running gateway detail', async () => {
  vi.useFakeTimers();
  vi.mocked(apiGet).mockResolvedValueOnce(fixture)
    .mockResolvedValue({ ...fixture, log: { tail: ['Polled'] } });
  renderMobile(<WorkerScreen job="RQ-EXAMPLE" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
  expect(screen.getByLabelText('Worker log tail')).toHaveTextContent('Polled');
});

it.each([403, 404])('keeps the older gateway notice for %s', async (status) => {
  vi.mocked(apiGet).mockImplementation(async (path) => {
    if (path.startsWith('/api/fleet/job')) throw new ApiError('Route unavailable', status, path);
    return { workers: [] };
  });
  renderMobile(<WorkerScreen job="RQ-EXAMPLE" />);
  expect(await screen.findByText(notice)).toBeInTheDocument();
});

it.each([401, 503])('shows a retryable error without claiming missing logs for %s', async (status) => {
  vi.mocked(apiGet).mockRejectedValue(new ApiError('Unavailable', status, '/api/fleet/job'));
  renderMobile(<WorkerScreen job="RQ-EXAMPLE" />);
  expect(await screen.findByText('Couldn’t load worker')).toBeInTheDocument();
  expect(screen.queryByText(notice)).toBeNull();
});
