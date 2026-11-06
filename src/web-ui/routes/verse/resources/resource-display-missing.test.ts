import { describe, expect, it } from 'vitest';
import type { CapacityRow } from '../usage/capacity-strip-model.js';
import { projectResourceDisplay } from './resource-display-model.js';

const NOW = Date.parse('2026-01-01T12:00:30.000Z');
function row(over: Partial<CapacityRow> = {}): CapacityRow {
  return {
    seatId: 'synthetic', label: 'Synthetic', engine: 'codex', monogram: 'C', kind: 'subscription', plan: null,
    cls: 'unknown' as CapacityRow['cls'], word: 'no reading', summary: '', connection: null, windows: [], credits: null,
    reserve: null, notes: [], localCount: 1, checkedAt: null, resetAt: null, signedOut: false, ...over,
  };
}
const usage = (value: CapacityRow) => projectResourceDisplay(value, { nowMs: NOW, healthRead: true }).usage;

describe('missing usage summary', () => {
  it('says a never-checked Codex row has not been checked, and keeps the label', () => {
    expect(usage(row())).toMatchObject({ state: 'missing', label: 'No current usage reading', summary: 'No usage check has run on this computer yet. Check now.' });
  });
  it('says a failed probe, not the generic cause', () => {
    const result = usage(row({ engine: 'claude', checkedAt: '2026-01-01T12:00:00.000Z', quotaReadReason: 'status-timed-out' }));
    expect(result).toMatchObject({ state: 'missing', summary: 'The usage check timed out. Check now.' });
  });
});
