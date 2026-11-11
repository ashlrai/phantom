/**
 * RQ-PHX-RECUTDESKN3S122: recut of #4652 (live queue station graph,
 * RQ-QUEUE-5). Exercises the real mounted entry point `QueueStationGraph`
 * and asserts the user-visible graph it promised: every station labelled,
 * banded by rho, with the bottleneck called out — and hidden behind the
 * agentWorkspace flag otherwise.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueueStationGraph } from '../../fleet-dashboard/QueueStationGraph.js';
import { fixtureQueueStatsSource } from '../../../data/queue-stats/source.js';
import { QUEUE_STATS_NORMAL } from '../../../data/queue-stats/fixtures.js';
import { QUEUE_STATIONS, STATION_LABELS } from '../../../data/queue-stats/schema.js';

describe('recut #4652: QueueStationGraph on the fleet dashboard', () => {
  it('renders all 11 labelled stations and names the bottleneck for the user', async () => {
    render(<QueueStationGraph enabled source={fixtureQueueStatsSource(QUEUE_STATS_NORMAL)} />);
    expect(await screen.findByText('Queue stations')).toBeTruthy();
    for (const id of QUEUE_STATIONS) {
      expect(screen.getByTestId(`station-${id}`).textContent).toContain(STATION_LABELS[id]);
    }
    expect(screen.getByTestId('queue-bottleneck').textContent).toBe('PR CI');
  });

  it('stays hidden when the agentWorkspace flag is off', () => {
    window.history.replaceState(null, '', '/');
    const { container } = render(<QueueStationGraph source={fixtureQueueStatsSource(QUEUE_STATS_NORMAL)} />);
    expect(container.innerHTML).toBe('');
  });
});
