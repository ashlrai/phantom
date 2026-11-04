import { describe, expect, it } from 'vitest';
import type { UsageResetRow, UsageResetsV1 } from '../../src/core/fleet/usage-reset-detect.js';
import { readFleetUsageResets } from '../../src/mcp/fleet-usage-resets.js';

const states: UsageResetRow['state'][] = [
  'reset-detected', 'reset-time-passed', 'hold-expired', 'consistent',
  'stale-reading', 'no-reading', 'manual-hold', 'open',
];

function row(state: UsageResetRow['state'], releasable = true): UsageResetRow {
  return {
    lane: `fake-${state}`, state, held: true, heldBy: 'autobackoff',
    heldReason: 'private reason', holdSince: '2026-01-01T00:00:00Z',
    heldUntil: '2026-01-02T00:00:00Z', usedPct: 12,
    readingAsOf: '2026-01-01T00:00:00Z', resetAt: '2026-01-02T00:00:00Z',
    releasable, tell: 'private tell',
  };
}

function snapshot(rows: UsageResetRow[], sourceState: UsageResetsV1['sourceState'] = 'healthy'): UsageResetsV1 {
  return { v: 1, generatedAt: '2026-01-03T00:00:00Z', sourceState, rows };
}

describe('fleet usage reset projection', () => {
  it('preserves all detector states and public evidence, excluding private fields', async () => {
    const input = states.map(state => ({ ...row(state), extra: 'private extra' }));
    input[1].releasable = false;
    const result = await readFleetUsageResets(async () => snapshot(input));
    expect(result.sourceState).toBe('healthy');
    expect(result.schemaVersion).toBe(1);
    expect(result.rows.map(item => item.state)).toEqual(states);
    expect(result.rows[1]).toEqual({
      lane: 'fake-reset-time-passed', state: 'reset-time-passed', held: true,
      heldBy: 'autobackoff', heldUntil: '2026-01-02T00:00:00Z', usedPct: 12,
      readingAsOf: '2026-01-01T00:00:00Z', resetAt: '2026-01-02T00:00:00Z', releasable: false,
    });
    expect(result.rows[0].releasable).toBe(true);
    expect(result.rows[6].releasable).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private reason|private tell|private extra|holdSince/);
  });

  it('preserves a releasable passed reset from a healthy source', async () => {
    const result = await readFleetUsageResets(async () => snapshot([row('reset-time-passed')]));
    expect(result.sourceState).toBe('healthy');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ state: 'reset-time-passed', releasable: true });
  });

  it('degrades unknown runtime states and prevents release of every retained row', async () => {
    const unknown = { ...row('open'), state: 'future-state' } as unknown as UsageResetRow;
    const result = await readFleetUsageResets(async () => snapshot([row('reset-time-passed'), unknown]));
    expect(result.sourceState).toBe('degraded');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ state: 'reset-time-passed', releasable: false });
  });

  it.each(['degraded', 'missing'] as const)('prevents release when source is %s', async sourceState => {
    const result = await readFleetUsageResets(async () => snapshot([row('reset-time-passed')], sourceState));
    expect(result.sourceState).toBe(sourceState);
    expect(result.rows[0].releasable).toBe(false);
  });
});
