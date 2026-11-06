/**
 * usage-resources-model.test.ts — the wire narrowing and row projection for
 * the "Every resource" panel (RQ-NIGHT-USAGE-1). The rules under test:
 * twelve rows always, empty states say so in words, and a measured value
 * never appears for a resource that was not measured.
 */
import { describe, expect, it } from 'vitest';
import { USAGE_RESOURCES } from '../../../../core/usage/resource-usage-types.js';
import { narrowUsageResources, resourceRows } from './usage-resources-model.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');

function wire(overrides: Partial<Record<string, Record<string, unknown>>> = {}) {
  return {
    v: 1,
    generatedAt: '2026-11-02T12:00:00.000Z',
    resources: USAGE_RESOURCES.map(({ id, label }) => ({
      id, label, state: 'no-reader' as const, used: null, limit: null, unit: null,
      resetsAt: null, source: null, asOf: null, reason: null,
      ...overrides[id],
    })),
  };
}

describe('narrowUsageResources', () => {
  it('accepts the contract body', () => {
    const narrowed = narrowUsageResources(wire());
    expect(narrowed).not.toBeNull();
    expect(narrowed!.resources).toHaveLength(12);
    expect(narrowed!.resources.map((row) => row.id)).toEqual(USAGE_RESOURCES.map((r) => r.id));
  });

  it('rejects a drifted roster, a missing row and a malformed row', () => {
    expect(narrowUsageResources(null)).toBeNull();
    expect(narrowUsageResources({ v: 1, generatedAt: 'x', resources: [] })).toBeNull();
    const missing = wire();
    missing.resources.pop();
    expect(narrowUsageResources(missing)).toBeNull();
    const drifted = wire();
    [drifted.resources[0], drifted.resources[1]] = [drifted.resources[1]!, drifted.resources[0]!];
    expect(narrowUsageResources(drifted)).toBeNull();
    const malformed = wire({ zai: { state: 'ok', used: 'lots' } });
    expect(narrowUsageResources(malformed)).toBeNull();
  });
});

describe('resourceRows', () => {
  it('projects a measured row: amount, meter, reset, source, as-of', () => {
    const rows = resourceRows(narrowUsageResources(wire({
      'codex-cmp': { state: 'ok', used: 62, limit: 100, unit: 'percent',
        resetsAt: '2026-11-05T12:00:00.000Z', source: 'codex-session-logs', asOf: '2026-11-02T11:00:00.000Z' },
      devin: { state: 'ok', used: 1240, limit: 2000, unit: 'acu',
        resetsAt: '2026-12-01T00:00:00.000Z', source: 'devin-api-v3-org-cycle', asOf: '2026-11-02T11:59:00.000Z' },
    })), NOW);
    const cmp = rows.find((row) => row.id === 'codex-cmp')!;
    expect(cmp.amountText).toBe('62% used');
    expect(cmp.percent).toBe(62);
    expect(cmp.resetText).toBe('resets in 3 d');
    expect(cmp.sourceText).toBe('codex-session-logs');
    expect(cmp.asOfText).toBe('as of 1h ago');
    const devin = rows.find((row) => row.id === 'devin')!;
    expect(devin.amountText).toBe('1,240 of 2,000 ACU');
    expect(devin.percent).toBe(62);
  });

  it('renders every empty state in words — never a measured value', () => {
    const rows = resourceRows(narrowUsageResources(wire({
      zai: { state: 'no-reader' },
      agy: { state: 'no-reading', source: 'agy-reader' },
      local: { state: 'unavailable', reason: 'reader-timeout' },
    })), NOW);
    expect(rows.find((r) => r.id === 'zai')).toMatchObject({ stateText: 'No reader yet', amountText: null, percent: null });
    expect(rows.find((r) => r.id === 'agy')).toMatchObject({ stateText: 'No reading yet', amountText: null, percent: null, sourceText: 'agy-reader' });
    expect(rows.find((r) => r.id === 'local')).toMatchObject({ stateText: 'Read failed', amountText: null, percent: null, sourceText: 'reader timed out' });
  });

  it('keeps a reading with unmeasured windows honest (null used, not 0%)', () => {
    const rows = resourceRows(narrowUsageResources(wire({
      'codex-cmp': { state: 'ok', used: null, limit: 100, unit: 'percent',
        resetsAt: null, source: 'codex-session-logs', asOf: '2026-11-02T11:00:00.000Z' },
    })), NOW);
    const cmp = rows.find((r) => r.id === 'codex-cmp')!;
    expect(cmp.state).toBe('ok');
    expect(cmp.amountText).toBeNull();
    expect(cmp.percent).toBeNull();
  });

  it('renders usd and points amounts in their own units', () => {
    const rows = resourceRows(narrowUsageResources(wire({
      'claude-api-gift': { state: 'ok', used: 50, limit: 250, unit: 'usd',
        resetsAt: '2026-12-24T00:00:00.000Z', source: 'claude-api-grant-store', asOf: '2026-11-02T09:00:00.000Z' },
      ultra: { state: 'ok', used: 12340, limit: 50000, unit: 'points',
        resetsAt: '2026-11-30T00:00:00.000Z', source: 'grok-ultra-manual', asOf: '2026-11-02T10:00:00.000Z' },
    })), NOW);
    expect(rows.find((r) => r.id === 'claude-api-gift')!.amountText).toBe('$50 of $250');
    expect(rows.find((r) => r.id === 'ultra')!.amountText).toBe('12,340 of 50,000 points');
    expect(rows.find((r) => r.id === 'ultra')!.percent).toBeCloseTo(24.68);
  });

  it('degrades to honest no-reading rows when no wire body exists', () => {
    const rows = resourceRows(null, NOW);
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.state).toBe('no-reading');
      expect(row.amountText).toBeNull();
      expect(row.percent).toBeNull();
    }
  });
});
