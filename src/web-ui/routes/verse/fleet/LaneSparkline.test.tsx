import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { fleetLive } from '../command/fixtures.test-support.js';
import { LanesStrip } from './FleetCards.js';
import { LaneSparkline } from './LaneSparkline.js';
import { recordLaneSamples, resetLaneHistory } from './lane-history-store.js';

const start = Date.parse('2026-01-01T00:00:00Z');
function snapshot(offset: number, busy: number, slots = 4) {
  return { ...fleetLive('live', start), generatedAt: new Date(start + offset).toISOString(), lanes: [{ lane: 'codex' as const, slots, busy, capReason: null }] };
}

afterEach(() => { resetLaneHistory(); });

describe('LaneSparkline', () => {
  it('renders only after two samples and announces the trend', () => {
    recordLaneSamples(snapshot(0, 1));
    const { container } = render(<LaneSparkline lane="codex" />);
    expect(container).toBeEmptyDOMElement();
    act(() => recordLaneSamples(snapshot(5_000, 3)));
    expect(screen.getByRole('img', { name: /^codex: 1 → 3 busy over the last minute/ })).toBeInTheDocument();
  });

  it('marks an off lane as muted and announces it', () => {
    recordLaneSamples(snapshot(0, 1));
    recordLaneSamples(snapshot(5_000, 0, 0));
    render(<LaneSparkline lane="codex" />);
    const trend = screen.getByRole('img', { name: /codex: 1 → 0 busy over the last minute, lane off/ });
    expect(trend.parentElement?.parentElement?.className).toContain('muted');
  });

  it('records successive strip snapshots and shows chips alongside their trends', () => {
    const { rerender } = render(<LanesStrip live={snapshot(0, 1)} />);
    expect(screen.queryByRole('img', { name: /^codex:/ })).not.toBeInTheDocument();
    rerender(<LanesStrip live={snapshot(5_000, 3)} />);
    const list = screen.getByRole('list', { name: 'Lanes: busy of slots' });
    expect(list).toHaveTextContent('Codex · 3/4');
    expect(within(list).getByRole('img', { name: /^codex: 1 → 3 busy over the last minute/ })).toBeInTheDocument();
  });
});
