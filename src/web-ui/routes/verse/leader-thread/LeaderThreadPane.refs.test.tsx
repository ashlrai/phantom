import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

vi.mock('../dock/dock-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane: vi.fn(),
}));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('Leader thread references', () => {
  it('offers job logs and a PR for leader messages, but not Mason messages', async () => {
    stubSurfaceFetch({ routes: {
      '/api/verse/leader/directives': { directives: [] },
      '/api/verse/leader/thread': { messages: [
        msg({ id: 'leader', text: 'Check RQ-PHX-ONE and RQ-PHX-TWO in acme/app#42.' }),
        msg({ id: 'mason', from: 'mason', text: 'Please check RQ-PHX-THREE.' }),
      ] },
      '/api/verse/fleet/runs': { inbox: [] },
    } });
    render(<LeaderThreadPane visible />);
    const row = await screen.findByLabelText('Mentioned');
    const first = within(row).getByRole('button', { name: 'Open log for RQ-PHX-ONE' });
    expect(within(row).getByRole('button', { name: 'Open log for RQ-PHX-TWO' })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: '#42' })).toHaveAttribute('href', 'https://github.com/acme/app/pull/42');
    expect(within(row).getAllByRole('button')).toHaveLength(2);
    expect(screen.getAllByLabelText('Mentioned')).toHaveLength(1);
    expect(screen.getByText('Please check RQ-PHX-THREE.').closest('section')).not.toContainElement(row);
    fireEvent.click(first);
    expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-ONE');
    expect(openDockPane).toHaveBeenCalledWith('worker-log');
  });
});
