/**
 * Security #952 L3: the standing-merge-pass judge holds merge rights, so it
 * must refuse a seat whose engine is unclassified, and a local seat when no
 * loopback local inference is configured, even when the base router would
 * admit every seat. Hermetic: snapshot, budget and base router are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshot = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../src/core/routing/budget-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/routing/budget-store.js')>()),
  readCapacitySnapshot: () => snapshot.value,
  loadBudgetPolicy: () => ({ mode: 'balanced', seats: {} }),
}));

const routeSeat = vi.fn();
vi.mock('../src/core/routing/router.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/routing/router.js')>()),
  routeSeat: (...args: unknown[]) => routeSeat(...args),
}));

const { legacyJudgeSeatLanes } = await import('../src/core/fleet/standing-merge-pass.js');

beforeEach(() => {
  routeSeat.mockReset();
  // Base router admits everything it is shown: the refusal must come from the merge-rights filter.
  routeSeat.mockImplementation((_req: unknown, seats: { seatId: string }[]) => ({ candidates: seats.map((s) => s.seatId), exclusions: [] }));
});

describe('standing merge pass judge refuses unclassified seats (#952 L3)', () => {
  it('an unknown engine id never becomes a judge lane', () => {
    snapshot.value = { seats: [{ seatId: 'mystery-1', engine: 'mystery-engine' }] };
    expect(legacyJudgeSeatLanes({ producerFamily: 'xai', nowMs: Date.now() }).lanes).toEqual([]);
  });

  it('an unknown seat next to a frontier seat leaves only the frontier lane', () => {
    snapshot.value = { seats: [{ seatId: 'mystery-1', engine: 'mystery-engine' }, { seatId: 'claude-a', engine: 'claude' }] };
    expect(legacyJudgeSeatLanes({ producerFamily: 'xai', nowMs: Date.now() }).lanes).toEqual(['claude-cli']);
  });

  it('a local seat without configured loopback local inference is refused merge rights', () => {
    snapshot.value = { seats: [{ seatId: 'local-0', engine: 'local' }] };
    expect(legacyJudgeSeatLanes({ producerFamily: 'xai', nowMs: Date.now() }).lanes).toEqual([]);
  });
});
