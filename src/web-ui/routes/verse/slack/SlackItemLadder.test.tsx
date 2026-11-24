import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SlackItemLadderTable, boardInputs } from './SlackItemLadder.js';
import type { LadderRow } from './slack-item-ladder.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const row = (i: number, o: Partial<LadderRow> = {}): LadderRow => ({
  threadLabel: `1700000${String(i).padStart(3, '0')}.000100`, firstSeenIso: '2026-01-01T10:00:00.000Z',
  state: 'RECEIVED', owner: 'unknown', evidence: 'none', asOf: '2026-01-01T10:00:00.000Z', stale: true, ...o });

describe('SlackItemLadderTable', () => {
  it('shows chips, owner, evidence and as-of per row', () => {
    render(<SlackItemLadderTable rows={[row(1, { state: 'VERIFIED', owner: 'agent-a', evidence: 'PR #9001', stale: false }), row(2)]} nowMs={NOW} />);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('VERIFIED')).toBeInTheDocument();
    expect(screen.getByText('RECEIVED')).toBeInTheDocument();
    expect(screen.getByText('agent-a')).toBeInTheDocument();
    expect(screen.getByText('PR #9001')).toBeInTheDocument();
    expect(screen.getByText(/stale/)).toBeInTheDocument();
  });
  it('caps at 20 rows with a +N more count', () => {
    render(<SlackItemLadderTable rows={Array.from({ length: 23 }, (_, i) => row(i))} nowMs={NOW} />);
    expect(screen.getAllByRole('row')).toHaveLength(21);
    expect(screen.getByText('+3 more')).toBeInTheDocument();
  });
  it('shows an empty state and an unknown state', () => {
    const { rerender } = render(<SlackItemLadderTable rows={[]} nowMs={NOW} />);
    expect(screen.getByText('No Slack work items.')).toBeInTheDocument();
    rerender(<SlackItemLadderTable rows={null} nowMs={NOW} />);
    expect(screen.getByText(/unknown/)).toBeInTheDocument();
  });
});

describe('boardInputs', () => {
  it('keeps only Slack items and is null for an unreadable board', () => {
    expect(boardInputs({ inbox: 'unavailable', items: [] })).toBeNull();
    const out = boardInputs({ inbox: 'ok', items: [
      { channel: 'slack', channelRef: 'T1/C1/1700000001.000100', receivedAt: '2026-01-01T10:00:00Z', state: 'RECEIVED' },
      { channel: 'email', channelRef: 'x', receivedAt: '2026-01-01T10:00:00Z', state: 'RECEIVED' }] });
    expect(out?.threads.map(t => t.threadKey)).toEqual(['1700000001.000100']);
  });
});
