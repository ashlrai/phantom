import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { apiGet, ApiError } from '../../../../data/client.js';
import { renderMobile } from '../mobile.test-support.js';
import { WorkersSection } from '../WorkersSection.js';
import { WorkerScreen } from './WorkerScreen.js';

vi.mock('../../../../data/client.js', async (original) => ({
  ...await original<typeof import('../../../../data/client.js')>(), apiGet: vi.fn(),
}));
const fixture = {
  schema: 'fleet.job.v1', state: 'running', lane: 'fake-lane', tier: 'work', model: 'fake-model',
  launchedAt: '2026-10-31T00:00:00Z', publish: { prUrl: 'https://github.com/example/fake/pull/31' },
  log: { tail: ['first fake line', 'newest fake line'] },
};

afterEach(() => {
  evictAll();
  vi.resetAllMocks();
  vi.useRealTimers();
  document.head.querySelector('meta[name="ashlr-remote-gateway"]')?.remove();
});

describe('WorkerScreen', () => {
  it('renders facts, a safe PR and ordered tail lines', async () => {
    vi.mocked(apiGet).mockResolvedValue(fixture);
    renderMobile(<WorkerScreen job="RQ-FAKE" />);
    expect(await screen.findByText('fake-lane')).toBeInTheDocument();
    expect(screen.getByText('running', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PR #31' })).toHaveAttribute('href', fixture.publish.prUrl);
    expect(screen.getByLabelText('Worker log tail').textContent).toBe('first fake line\nnewest fake line');
  });

  it('refreshes the running tail every four seconds', async () => {
    vi.useFakeTimers();
    vi.mocked(apiGet).mockResolvedValueOnce(fixture).mockResolvedValue({ ...fixture, log: { tail: ['updated fake line'] } });
    renderMobile(<WorkerScreen job="RQ-FAKE" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Worker log tail')).toHaveTextContent('updated fake line');
  });

  it('shows the local 404 state', async () => {
    vi.mocked(apiGet).mockRejectedValue(new ApiError('fake missing', 404, '/api/fleet/job'));
    renderMobile(<WorkerScreen job="RQ-FAKE" />);
    expect(await screen.findByText('Job detail is not in this build yet')).toBeInTheDocument();
  });

  it.each([401, 403, 404, 503])('explains gateway refusal for HTTP %s', async (status) => {
    if (status !== 401 && status !== 403) {
      const meta = document.createElement('meta');
      meta.name = 'ashlr-remote-gateway'; meta.content = 'v1'; document.head.append(meta);
    }
    vi.mocked(apiGet).mockRejectedValue(new ApiError('fake refusal', status, '/api/fleet/job'));
    renderMobile(<WorkerScreen job="RQ-FAKE" />);
    expect(await screen.findByText('Worker logs are not available through this gateway yet. Open Phantom on your Mac.')).toBeInTheDocument();
  });

  it('retries other errors', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new ApiError('fake failure', 503, '/api/fleet/job')).mockResolvedValue(fixture);
    renderMobile(<WorkerScreen job="RQ-FAKE" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('fake-lane')).toBeInTheDocument();
  });

  it('opens a worker from the fleet row', async () => {
    const navigate = vi.fn();
    vi.mocked(apiGet).mockResolvedValue({ workers: [{ job: 'RQ-FAKE', lane: 'fake', tier: 'work', ageSeconds: 1 }] });
    renderMobile(<WorkersSection />, { navigate });
    await userEvent.click(await screen.findByRole('button', { name: 'Open worker RQ-FAKE' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ screen: 'worker', job: 'RQ-FAKE' }));
  });
});
