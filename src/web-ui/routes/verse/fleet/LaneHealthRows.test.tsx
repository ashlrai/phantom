import { afterEach, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { fleetLive } from '../command/fixtures.test-support.js';
import { LanesStrip } from './FleetCards.js';
import { resetLaneHistory } from './lane-history-store.js';

afterEach(() => { resetLaneHistory(); });

it('shows the four numbers over the stated window and a stuck badge with phase age', () => {
  const base = fleetLive('live', Date.parse('2026-01-01T12:00:00Z'));
  const live = { ...base, commit: 'abc1234', lanes: [{ lane: 'codex' as const, slots: 2, busy: 1, capReason: null }],
    runs: [{ id: 'r1', taskId: null, repo: 'a/b', title: 't', lane: 'codex' as const, seatId: null, engine: null, model: null,
      phase: 'producing' as const, startedAt: '2026-01-01T11:00:00Z', phaseStartedAt: '2026-01-01T11:00:00Z',
      endedAt: null, outcome: null, prNumber: null, hold: null, seatDecision: null }] };
  render(<LanesStrip live={{ ...live, generatedAt: '2026-01-01T12:00:00Z' }} />);
  const rows = screen.getByRole('list', { name: 'Lane health, last 12 hours' });
  expect(rows).toHaveTextContent('Codex1 call · unknown errors · unknown p50 · commit abc1234');
  expect(screen.getByRole('status')).toHaveTextContent('stuck · producing 1h');
});
