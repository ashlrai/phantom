import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { apiGet } from '../../../../data/client.js';
import { renderMobile } from '../mobile.test-support.js';
import { WorkerScreen } from './WorkerScreen.js';

vi.mock('../../../../data/client.js', async (original) => ({
  ...await original<typeof import('../../../../data/client.js')>(), apiGet: vi.fn(),
}));

const fixture = {
  schema: 'fleet.job.v1', state: 'running', lane: 'gateway-lane', tier: 'work', model: 'gateway-model',
  launchedAt: '2026-10-31T00:00:00Z', publish: { prUrl: 'https://github.com/example/fake/pull/31' },
  log: { tail: ['gateway tail line'] },
};

afterEach(() => {
  evictAll();
  vi.resetAllMocks();
  document.head.querySelector('meta[name="ashlr-remote-gateway"]')?.remove();
});

describe('WorkerScreen through the paired remote gateway', () => {
  it('shows lane, model and PR from the job detail instead of the fleet snapshot', async () => {
    const meta = document.createElement('meta');
    meta.name = 'ashlr-remote-gateway'; meta.content = 'v1'; document.head.append(meta);
    vi.mocked(apiGet).mockImplementation(async (path) => {
      if (path.startsWith('/api/fleet/job')) return fixture;
      return { workers: [{ job: 'RQ-PHX-EXAMPLE31', lane: 'snapshot-lane', tier: 'snap', ageSeconds: 60 }] };
    });
    renderMobile(<WorkerScreen job="RQ-PHX-EXAMPLE31" />);
    expect(await screen.findByText('gateway-lane')).toBeInTheDocument();
    expect(screen.getByText('gateway-model')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PR #31' })).toHaveAttribute('href', fixture.publish.prUrl);
    expect(screen.getByLabelText('Worker log tail')).toHaveTextContent('gateway tail line');
    expect(screen.queryByRole('region', { name: 'Worker (from the fleet snapshot)' })).toBeNull();
    expect(screen.queryByText('snapshot-lane')).toBeNull();
    expect(vi.mocked(apiGet).mock.calls.map((call) => call[0]))
      .toEqual(['/api/fleet/job?id=RQ-PHX-EXAMPLE31']);
  });
});
