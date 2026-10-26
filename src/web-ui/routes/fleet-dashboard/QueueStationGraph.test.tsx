import { describe, expect, it, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueueStationGraph } from './QueueStationGraph.js';
import { fixtureQueueStatsSource, commandQueueStatsSource } from '../../data/queue-stats/source.js';
import { QUEUE_STATS_EMPTY, QUEUE_STATS_NORMAL, QUEUE_STATS_OVERLOADED } from '../../data/queue-stats/fixtures.js';
import { AGENT_WORKSPACE_STORAGE_KEY } from '../../data/agent-workspace-flag.js';

afterEach(() => localStorage.removeItem(AGENT_WORKSPACE_STORAGE_KEY));

describe('QueueStationGraph', () => {
  it('renders nothing when the flag is off (default)', () => {
    const { container } = render(<QueueStationGraph source={fixtureQueueStatsSource()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the normal fixture with bands and bottleneck when the flag is on', async () => {
    localStorage.setItem(AGENT_WORKSPACE_STORAGE_KEY, '1');
    render(<QueueStationGraph source={fixtureQueueStatsSource(QUEUE_STATS_NORMAL)} />);
    const node = await screen.findByTestId('station-pr_ci');
    expect(node.getAttribute('data-band')).toBe('amber');
    expect(node.getAttribute('data-bottleneck')).toBe('true');
    expect(screen.getByTestId('station-planned').getAttribute('data-band')).toBe('green');
    expect(screen.getByTestId('queue-bottleneck').textContent).toBe('PR CI');
    expect(screen.queryByTestId('little-drift')).toBeNull();
    expect(screen.getAllByText(/^rho /)).toHaveLength(9);
  });

  it('renders the overloaded fixture with drift flag', async () => {
    render(<QueueStationGraph enabled source={fixtureQueueStatsSource(QUEUE_STATS_OVERLOADED)} />);
    expect((await screen.findByTestId('queue-bottleneck')).textContent).toBe('PR CI');
    expect(screen.getByTestId('little-drift')).toBeTruthy();
    expect(screen.getByTestId('station-merge_queue').getAttribute('data-band')).toBe('red');
    expect(screen.getByText('rho 1.20 q 18')).toBeTruthy();
  });

  it('renders the empty fixture as an empty state', async () => {
    render(<QueueStationGraph enabled source={fixtureQueueStatsSource(QUEUE_STATS_EMPTY)} />);
    expect(await screen.findByText('No queue activity in this window.')).toBeTruthy();
  });

  it('shows the not-wired command stub as an inline error', async () => {
    render(<QueueStationGraph enabled source={commandQueueStatsSource()} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/RQ-QUEUE-3/);
  });

  it('never renders secrets smuggled into the payload', async () => {
    const leaky = {
      ...QUEUE_STATS_NORMAL,
      token: 'ghp_SECRETSECRET',
      stations: QUEUE_STATS_NORMAL.stations.map((s) => ({ ...s, note: 'sk-live-SECRET' })),
    };
    const { container } = render(<QueueStationGraph enabled source={fixtureQueueStatsSource(leaky)} />);
    await screen.findByTestId('station-planned');
    expect(container.innerHTML).not.toMatch(/SECRET|ghp_|sk-live/);
    const badPool = { ...QUEUE_STATS_NORMAL, pools: [{ ...QUEUE_STATS_NORMAL.pools[0], pool: 'ghp_SECRETSECRET' }] };
    const r2 = render(<QueueStationGraph enabled source={fixtureQueueStatsSource(badPool)} />);
    await r2.findByRole('alert');
    expect(r2.container.innerHTML).not.toMatch(/SECRET/);
  });
});
