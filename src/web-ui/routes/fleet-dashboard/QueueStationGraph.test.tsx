import { describe, expect, it, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueueStationGraph } from './QueueStationGraph.js';
import { fixtureQueueStatsSource, commandQueueStatsSource, queueNowQueueStatsSource } from '../../data/queue-stats/source.js';
import { QUEUE_STATS_EMPTY, QUEUE_STATS_NORMAL, QUEUE_STATS_OVERLOADED } from '../../data/queue-stats/fixtures.js';
import { QUEUE_NOW_FIXTURE } from '../../data/queue-stats/queue-now-fixture.js';
import { AGENT_WORKSPACE_STORAGE_KEY } from '../../data/agent-workspace-flag.js';

afterEach(() => localStorage.removeItem(AGENT_WORKSPACE_STORAGE_KEY));

describe('QueueStationGraph', () => {
  it('renders nothing when the flag is off (default)', () => {
    const { container } = render(<QueueStationGraph source={fixtureQueueStatsSource()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders all 11 stations of the normal fixture when the flag is on', async () => {
    localStorage.setItem(AGENT_WORKSPACE_STORAGE_KEY, '1');
    render(<QueueStationGraph source={fixtureQueueStatsSource(QUEUE_STATS_NORMAL)} />);
    const node = await screen.findByTestId('station-pr_ci');
    expect(node.getAttribute('data-band')).toBe('amber');
    expect(node.getAttribute('data-bottleneck')).toBe('true');
    expect(screen.getByTestId('station-pr_open_rework').getAttribute('data-band')).toBe('unknown');
    expect(screen.getByTestId('station-claimed').getAttribute('data-band')).toBe('green');
    expect(screen.getByTestId('queue-bottleneck').textContent).toBe('PR CI');
    expect(screen.queryByTestId('little-drift')).toBeNull();
    expect(screen.getAllByText(/^rho /)).toHaveLength(11);
  });

  it('renders the overloaded fixture with drift flag', async () => {
    render(<QueueStationGraph enabled source={fixtureQueueStatsSource(QUEUE_STATS_OVERLOADED)} />);
    expect((await screen.findByTestId('queue-bottleneck')).textContent).toBe('PR CI');
    expect(screen.getByTestId('little-drift')).toBeTruthy();
    expect(screen.getByTestId('station-builder_run').getAttribute('data-band')).toBe('red');
    expect(screen.getByTestId('station-merge_group').getAttribute('data-band')).toBe('amber');
    expect(screen.getByText('rho 1.25 q 18')).toBeTruthy();
  });

  it('renders the empty fixture as an empty state', async () => {
    render(<QueueStationGraph enabled source={fixtureQueueStatsSource(QUEUE_STATS_EMPTY)} />);
    expect(await screen.findByText('No queue activity in this window.')).toBeTruthy();
  });

  it('renders CI Efficiency queue-now.json through the queue-now adapter', async () => {
    const { container } = render(<QueueStationGraph enabled source={queueNowQueueStatsSource(() => QUEUE_NOW_FIXTURE)} />);
    expect((await screen.findByTestId('queue-bottleneck')).textContent).toBe('merge group');
    expect(screen.getAllByText(/^rho /)).toHaveLength(11);
    expect(screen.getByTestId('station-pr_ci').getAttribute('data-band')).toBe('unknown');
    expect(screen.getByTestId('little-drift')).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/c_source|runner concurrency|emitters/);
  });

  it('shows the not-wired command stub as an inline error', async () => {
    render(<QueueStationGraph enabled source={commandQueueStatsSource()} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/RQ-QUEUE-3/);
  });

  it('never renders secrets smuggled into the payload', async () => {
    const leaky = {
      ...QUEUE_STATS_NORMAL,
      token: 'ghp_SECRETSECRET',
      stations: { ...QUEUE_STATS_NORMAL.stations, claimed: { ...QUEUE_STATS_NORMAL.stations.claimed, note: 'sk-live-SECRET' } },
    };
    const { container } = render(<QueueStationGraph enabled source={fixtureQueueStatsSource(leaky)} />);
    await screen.findByTestId('station-claimed');
    expect(container.innerHTML).not.toMatch(/SECRET|ghp_|sk-live/);
    const leakyNow = { ...QUEUE_NOW_FIXTURE, stations: { ...QUEUE_NOW_FIXTURE.stations, live: { status: 'no data', note: 'ghp_SECRETSECRET' } } };
    const r2 = render(<QueueStationGraph enabled source={queueNowQueueStatsSource(() => leakyNow)} />);
    await r2.findAllByTestId('station-live');
    expect(r2.container.innerHTML).not.toMatch(/SECRET/);
    const badPool = { ...QUEUE_STATS_NORMAL, pools: [{ ...QUEUE_STATS_NORMAL.pools[0], pool: 'ghp_SECRETSECRET' }] };
    const r3 = render(<QueueStationGraph enabled source={fixtureQueueStatsSource(badPool)} />);
    await r3.findByRole('alert');
    expect(r3.container.innerHTML).not.toMatch(/SECRET/);
  });
});
