/** The reset line renders for a Codex row and never for another engine. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { accountStatus, type CapacityRow } from '../usage/capacity-strip-model.js';
import { ResourceCard } from './ResourceCard.js';

const FUTURE = new Date(Date.now() + 50.5 * 3_600_000).toISOString();
const base: CapacityRow = {
  seatId: 'codex-fake', label: 'Codex', engine: 'codex', monogram: 'X', kind: 'subscription', plan: null,
  cls: 'unknown' as CapacityRow['cls'], word: 'no reading', summary: '', connection: null, credits: null,
  windows: [{ id: 'weekly', label: 'weekly window', usedPercent: 10, limitReached: false, resetText: null, resetsAt: FUTURE, binding: true }],
  reserve: null, notes: [], localCount: 1, checkedAt: null, resetAt: null, signedOut: false,
};

function card(row: CapacityRow) {
  const status = accountStatus(row, { now: Date.now(), healthRead: true, checking: false });
  render(<ResourceCard row={row} status={status} settled={status} mode={null} busy={null} onAction={() => {}} />);
}

afterEach(cleanup);

describe('ResourceCard reset line', () => {
  it('shows it for a Codex row, with no free-reset claim or redeem button', () => {
    card(base);
    expect(screen.getByText(/^Resets .+\(in 2d 2h\)$/)).toBeTruthy();
    expect(screen.queryByText(/Free resets/)).toBeNull();
    expect(screen.queryByRole('button', { name: /redeem/i })).toBeNull();
  });
  it('does not show it for a Devin row', () => {
    card({ ...base, seatId: 'devin-fake', label: 'Devin', engine: 'devin' as CapacityRow['engine'] });
    expect(screen.queryByText(/^Resets /)).toBeNull();
  });
});
