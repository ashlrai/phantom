import { describe, expect, it } from 'vitest';
import { localSlotsView, type LocalLaneRow } from './local-slots-row.js';

const lane = (o: Partial<LocalLaneRow> = {}): LocalLaneRow =>
  ({ running: 14, target: 13, queued: 4, held: false, heldReason: null, ...o });
const NOW = Date.parse('2026-11-09T12:00:00Z');

describe('localSlotsView', () => {
  it('reports busy slots and queue', () => {
    const v = localSlotsView([lane()], NOW);
    expect(v.quotaText).toBe('No quota · runs on this Mac');
    expect(v.slotsText).toBe('14 of 13 slots busy · 4 queued');
    expect(v.heldText).toBeNull();
  });
  it('leaves out queued when 0 or unknown', () => {
    expect(localSlotsView([lane({ queued: 0 })], NOW).slotsText).toBe('14 of 13 slots busy');
    expect(localSlotsView([lane({ queued: null })], NOW).slotsText).toBe('14 of 13 slots busy');
  });
  it('never shows 0 of M when running is unknown', () => {
    expect(localSlotsView([lane({ running: null })], NOW).slotsText).toBeNull();
  });
  it('shows held with reason, capped at 120 characters', () => {
    expect(localSlotsView([lane({ held: true, heldReason: 'memory low' })], NOW).heldText).toBe('Held: memory low');
    expect(localSlotsView([lane({ held: true })], NOW).heldText).toBe('Held');
    const long = localSlotsView([lane({ held: true, heldReason: 'x'.repeat(300) })], NOW).heldText!;
    expect(long).toBe(`Held: ${'x'.repeat(120)}`);
  });
  it('has no slots or held text when the lanes read is missing', () => {
    expect(localSlotsView(null, NOW)).toEqual({
      quotaText: 'No quota · runs on this Mac', slotsText: null, heldText: null, stale: false,
    });
    expect(localSlotsView([], NOW).slotsText).toBeNull();
  });
  it('sums codex-local and omlx-local', () => {
    const v = localSlotsView([lane({ running: 3, target: 4, queued: 1 }), lane({ running: 2, target: 2, queued: 2 })], NOW);
    expect(v.slotsText).toBe('5 of 6 slots busy · 3 queued');
  });
  it('flags an old read as stale', () => {
    expect(localSlotsView([lane()], NOW, '2026-11-09T11:00:00Z').stale).toBe(true);
    expect(localSlotsView([lane()], NOW, '2026-11-09T11:59:00Z').stale).toBe(false);
  });
});
