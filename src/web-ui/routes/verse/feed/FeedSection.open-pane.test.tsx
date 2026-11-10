import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopUpdatesForTests } from '../../../app/desktop-updates.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot } from '../command/fixtures.test-support.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { FeedSection } from './FeedSection.js';

vi.mock('../command/nav.js', () => ({ openChat: vi.fn() }));
vi.mock('../dock/dock-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane: vi.fn(),
}));
vi.mock('../fleet-job-log/worker-log-selection.js', async importOriginal => ({
  ...await importOriginal<typeof import('../fleet-job-log/worker-log-selection.js')>(), requestWorkerLogJob: vi.fn(),
}));

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const runs = { inbox: [], mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Merged the feed pane', mergedAt: at(2) }] }, events: [] };
const busPage = { v: 1, status: 'ok', nextCursor: 1, messages: [{ cursor: 1, receivedAt: now - 60_000,
  envelope: { id: 'env-1', from: 'claude-1', to: 'leader', priority: 'P0', ttl: 3_600_000, body: { text: 'RQ-FAKEJOB-1 is stuck on review' } } }] };
const routes = {
  '/api/verse/leader/thread': { messages: [msg({ id: 'l1', at: at(1), text: 'Leader memo.' })] },
  '/api/verse/fleet/runs': runs, '/api/verse/comms/owner-thread': null, '/api/verse/ops/self-update': null,
  '/api/verse/agent-bus': busPage,
};

beforeEach(() => { evictAll(); resetDesktopUpdatesForTests(); resetActivityForTest(async () => ({ ...activitySnapshot('live', now), needsYou: [] })); });
afterEach(() => { resetDesktopUpdatesForTests(); resetActivityForTest(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('FeedSection opens the pane that owns an item', () => {
  it('opens Merges through the pane host from a keyboard-reachable link naming the item', async () => {
    stubSurfaceFetch({ routes });
    const host = { openPane: vi.fn() };
    render(<FeedSection visible host={host} />);
    const link = await screen.findByRole('link', { name: 'Open in Merges: Merged the feed pane' });
    expect(link).toHaveTextContent('Open in Merges');
    expect(link.getAttribute('href')).toContain('pane=fleet-merges');
    expect(link.tabIndex).toBe(0);
    fireEvent.click(link);
    expect(host.openPane).toHaveBeenCalledWith('fleet-merges');
    expect(openDockPane).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open in Leader: Leader memo.' })).toBeInTheDocument();
  });

  it('opens the job log for a job id in a bus item, and the Bus pane for the item', async () => {
    stubSurfaceFetch({ routes });
    const host = { openPane: vi.fn() };
    render(<FeedSection visible host={host} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open log for RQ-FAKEJOB-1' }));
    expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-FAKEJOB-1');
    expect(host.openPane).toHaveBeenCalledWith('worker-log');
    fireEvent.click(screen.getByRole('link', { name: 'Open in Bus: RQ-FAKEJOB-1 is stuck on review' }));
    expect(host.openPane).toHaveBeenLastCalledWith('fleet-bus');
  });

  it('falls back to the dock store without a host, and keeps the external link in a new tab', async () => {
    stubSurfaceFetch({ routes });
    render(<FeedSection visible />);
    fireEvent.click(await screen.findByRole('link', { name: 'Open in Merges: Merged the feed pane' }));
    expect(openDockPane).toHaveBeenCalledWith('fleet-merges');
    const external = screen.getByRole('link', { name: 'Open' });
    expect(external).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
