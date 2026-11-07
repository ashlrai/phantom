import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resourceFixture } from './fixtures.test-support.js';
import { TaskInspector, type ResourceTaskRow } from './TaskInspector.js';

function row(minute: number, workerId = 'local-a'): ResourceTaskRow {
  const receipt = resourceFixture().snapshot.recentAttempts[0]!;
  return { id: receipt.id, receipt: { ...receipt, workerId,
    finishedAt: new Date(Date.UTC(2026, 8, 7, 12, minute)).toISOString() } };
}
const props = { enabled: false, busy: false, onCancel: vi.fn() };
function historyRows() {
  return within(screen.getByRole('region', { name: 'Routing observation history' })).getAllByRole('row').slice(1);
}

describe('task routing observation history', () => {
  it('orders late observations by timestamp and deduplicates repeated entries', () => {
    const { rerender } = render(<TaskInspector {...props} row={row(3, 'newest')} />);
    rerender(<TaskInspector {...props} row={row(1, 'oldest')} />);
    rerender(<TaskInspector {...props} row={row(2, 'middle')} />);
    rerender(<TaskInspector {...props} row={row(1, 'oldest')} />);
    expect(historyRows().map(item => within(item).getAllByRole('cell')[1]!.textContent)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('retains eight newest unique observations even after late arrivals', () => {
    const { rerender } = render(<TaskInspector {...props} row={row(0, 'worker-0')} />);
    for (let minute = 1; minute <= 10; minute++) rerender(<TaskInspector {...props} row={row(minute, `worker-${minute}`)} />);
    rerender(<TaskInspector {...props} row={row(0, 'too-old')} />);
    expect(historyRows()).toHaveLength(8);
    expect(historyRows()[0]).toHaveTextContent('worker-10');
    expect(historyRows()[7]).toHaveTextContent('worker-3');
  });

  it('uses stable tie ordering and preserves distinct observations at the same timestamp', () => {
    const { rerender } = render(<TaskInspector {...props} row={row(1, 'z-worker')} />);
    rerender(<TaskInspector {...props} row={row(1, 'a-worker')} />);
    expect(historyRows()[0]).toHaveTextContent('a-worker');
    expect(historyRows()[1]).toHaveTextContent('z-worker');
    rerender(<TaskInspector {...props} row={row(1, 'z-worker')} />);
    expect(historyRows()).toHaveLength(2);
  });

  it('resets history when selecting another task and ignores invalid timestamps', () => {
    const { rerender } = render(<TaskInspector {...props} row={row(1, 'previous-worker')} />);
    const next = row(2, 'next-worker');
    rerender(<TaskInspector {...props} row={{ ...next, id: 'another-task' }} />);
    expect(historyRows()).toHaveLength(1);
    expect(historyRows()[0]).toHaveTextContent('next-worker');
    rerender(<TaskInspector {...props} row={{ id: 'invalid', receipt: { ...next.receipt!, finishedAt: 'invalid' } }} />);
    expect(screen.getByText('No timestamped task observations available.')).toBeVisible();
  });
});
