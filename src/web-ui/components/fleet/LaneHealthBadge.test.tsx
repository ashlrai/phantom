import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LANE_HEALTH_STATES, type LaneHealth, type LaneHealthState } from '../../../core/fleet/lane-badge.js';
import { buildFleetLiveMap } from '../../../core/fleet/live-map.js';
import { narrowLiveMap } from '../../routes/verse/fleet-map/map-model.js';
import { LaneHealthBadge } from './LaneHealthBadge.js';

const REASONS: Record<LaneHealthState, string> = {
  ok: 'ok: 3 running, 2 ready',
  held: 'held: keeps 8 launch slots and refuses to run',
  starved: 'starved: 5 free slots, 0 ready rows for 40 min',
  wasteful: 'wasteful: 8 starts, 1 merged PR in 60 min',
  drained: 'drained: credit is spent, nothing launched here would run',
};

describe('LaneHealthBadge', () => {
  it.each(LANE_HEALTH_STATES)('renders the %s badge with its reason as the tooltip', (state) => {
    const health: LaneHealth = { state, reason: REASONS[state], number: 1 };
    render(<LaneHealthBadge health={health} />);
    const badge = screen.getByTestId('lane-health');
    expect(badge.textContent).toBe(state);
    expect(badge.getAttribute('data-state')).toBe(state);
    expect(badge.getAttribute('title')).toBe(REASONS[state]);
    expect(screen.getByLabelText(REASONS[state])).toBe(badge);
  });

  it('adds the lane top empty reason to the tooltip', () => {
    render(<LaneHealthBadge health={{ state: 'wasteful', reason: REASONS.wasteful, number: 8, emptyNote: 'top empty reason: timeout (2 of 3 empty jobs)' }} />);
    expect(screen.getByTestId('lane-health').getAttribute('title')).toBe(`${REASONS.wasteful}. top empty reason: timeout (2 of 3 empty jobs)`);
  });

  it('renders nothing when the server sent no verdict', () => {
    const { container } = render(<LaneHealthBadge health={undefined} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('lane node health on the live map', () => {
  it('carries each lane verdict onto its node and survives the browser narrowing', () => {
    const health: LaneHealth = { state: 'starved', reason: REASONS.starved, number: 5 };
    const map = buildFleetLiveMap({
      now: Date.parse('2026-11-19T10:00:00Z'),
      org: null,
      usage: { lanes: [{ lane: 'claude' }] } as never,
      lanes: { lanes: [{ lane: 'claude', health }] } as never,
    });
    const node = map.nodes.find(row => row.id === 'lane:claude');
    expect(node?.health).toEqual(health);
    expect(narrowLiveMap(JSON.parse(JSON.stringify(map)))?.nodes.find(row => row.id === 'lane:claude')?.health).toEqual(health);
  });
});
