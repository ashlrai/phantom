import { describe, expect, it } from 'vitest';
import { formatDeadSignal } from '../src/cli/resource-ledger.js';
import type { LaneDeadSignal } from '../src/core/fleet/lane-dead-signal.js';

function signal(fields: Partial<LaneDeadSignal>): LaneDeadSignal {
  return { lane: 'test-lane', lastFinishes: 0, emptyFailures: 0, state: 'ok', ...fields };
}

describe('formatDeadSignal (ledger-dead-text-recut-31)', () => {
  it('returns "unknown" for null', () => {
    expect(formatDeadSignal(null)).toBe('unknown');
  });

  it('reports a healthy lane (ok state, no failures)', () => {
    const s = signal({ lane: 'healthy-lane', lastFinishes: 5, emptyFailures: 0, state: 'ok' });
    const result = formatDeadSignal(s);
    expect(result).toContain('state=ok');
    expect(result).toContain('emptyFailures=0');
    expect(result).toContain('lastFinishes=5');
    expect(result).not.toContain('unknown');
  });

  it('reports a failing lane (dead state, max failures)', () => {
    const s = signal({ lane: 'dead-lane', lastFinishes: 8, emptyFailures: 8, state: 'dead' });
    const result = formatDeadSignal(s);
    expect(result).toContain('state=dead');
    expect(result).toContain('emptyFailures=8');
    expect(result).toContain('lastFinishes=8');
    expect(result).not.toContain('unknown');
  });

  it('reports a suspect lane (suspect state, partial failures)', () => {
    const s = signal({ lane: 'suspect-lane', lastFinishes: 6, emptyFailures: 5, state: 'suspect' });
    const result = formatDeadSignal(s);
    expect(result).toContain('state=suspect');
    expect(result).toContain('emptyFailures=5');
    expect(result).toContain('lastFinishes=6');
  });

  it('reports a lane with no finishes yet (empty signal)', () => {
    const s = signal({ lane: 'fresh-lane', lastFinishes: 0, emptyFailures: 0, state: 'ok' });
    const result = formatDeadSignal(s);
    expect(result).toContain('state=ok');
    expect(result).toContain('emptyFailures=0');
    expect(result).toContain('lastFinishes=0');
  });
});
