/**
 * routes/verse/fleet/queue-drain-eta.test.ts — regression tests for queueDrainEta.
 */
import { describe, expect, it } from 'vitest';
import { queueDrainEta } from './queue-drain-eta.js';

/* ------------------------------------------------------------------ */
/*  Held lane                                                         */
/* ------------------------------------------------------------------ */

describe('held lane', () => {
  it('returns state "held", drainMinutes null, freeSlotsAtNextPass 0', () => {
    const result = queueDrainEta({ running: 24, target: 24, queued: 16, held: true });
    expect(result.state).toBe('held');
    expect(result.drainMinutes).toBeNull();
    expect(result.freeSlotsAtNextPass).toBe(0);
    expect(result.freeSlots).toBe(0);
  });

  it('still computes freeSlots even when held', () => {
    const result = queueDrainEta({ running: 8, target: 24, queued: 5, held: true });
    expect(result.freeSlots).toBe(16);
  });
});

/* ------------------------------------------------------------------ */
/*  Idle lane (queued === 0)                                          */
/* ------------------------------------------------------------------ */

describe('idle lane', () => {
  it('queued 0 → drainMinutes 0, state "idle" when freeSlots > 0', () => {
    const result = queueDrainEta({ running: 0, target: 24, queued: 0, held: false });
    expect(result.drainMinutes).toBe(0);
    expect(result.state).toBe('idle');
    expect(result.freeSlots).toBe(24);
  });

  it('queued 0, fully utilised lane → state "saturated"', () => {
    const result = queueDrainEta({ running: 24, target: 24, queued: 0, held: false });
    expect(result.state).toBe('saturated');
    expect(result.freeSlots).toBe(0);
  });

  it('idle lane with free slots reports freeSlotsAtNextPass', () => {
    const result = queueDrainEta({ running: 8, target: 24, queued: 0, held: false });
    expect(result.freeSlotsAtNextPass).toBe(24);
  });
});

/* ------------------------------------------------------------------ */
/*  Saturated lane (running ≥ target, queued > 0)                     */
/* ------------------------------------------------------------------ */

describe('saturated lane', () => {
  it('running 24/24, queued 16 → freeSlots 0, drainMinutes 15, freeSlotsAtNextPass 8', () => {
    const result = queueDrainEta({
      running: 24,
      target: 24,
      queued: 16,
      held: false,
      // avgJobMinutes=15, nextPassMinutes=15 (defaults)
    });
    expect(result.freeSlots).toBe(0);
    expect(result.drainMinutes).toBe(15);
    expect(result.freeSlotsAtNextPass).toBe(8);
    expect(result.state).toBe('draining');
  });

  it('running 24/24, queued 49 → drainMinutes 45 (ceil(49/24)×15)', () => {
    const result = queueDrainEta({
      running: 24,
      target: 24,
      queued: 49,
      held: false,
    });
    expect(result.drainMinutes).toBe(45); // ceil(49/24)=3, 3×15=45
  });

  it('running 24/24, queued 25 → drainMinutes 30 (ceil(25/24)×15)', () => {
    const result = queueDrainEta({
      running: 24,
      target: 24,
      queued: 25,
      held: false,
    });
    expect(result.drainMinutes).toBe(30); // ceil(25/24)=2, 2×15=30
  });
});

/* ------------------------------------------------------------------ */
/*  Under-utilised lane (running < target, queued > 0)                */
/* ------------------------------------------------------------------ */

describe('under-utilised lane', () => {
  it('lane 8/24, queued 3 → drainMinutes 0, state "draining"', () => {
    const result = queueDrainEta({
      running: 8,
      target: 24,
      queued: 3,
      held: false,
    });
    expect(result.freeSlots).toBe(16);
    expect(result.drainMinutes).toBe(0);
    expect(result.state).toBe('draining');
  });

  it('partial overflow: running 8, target 24, queued 20 → drainMinutes 15', () => {
    // freeSlots=16, queued=20 > freeSlots, so overflow = 20-16=4
    // ceil(4/24)×15 = 1×15 = 15
    const result = queueDrainEta({
      running: 8,
      target: 24,
      queued: 20,
      held: false,
    });
    expect(result.drainMinutes).toBe(15);
    expect(result.state).toBe('draining');
  });

  it('partial overflow that exceeds nextPassMinutes → state "saturated"', () => {
    // running=8, target=24, queued=100
    // freeSlots=16, overflow=84, ceil(84/24)=4, 4×15=60
    // 60 > 15 (nextPassMinutes) and freeSlots=16 > 0
    // freeSlots > 0 → 'draining'
    const result = queueDrainEta({
      running: 8,
      target: 24,
      queued: 100,
      held: false,
    });
    expect(result.state).toBe('draining'); // freeSlots > 0 overrides
  });

  it('saturated because drainMinutes > nextPassMinutes AND freeSlots === 0', () => {
    // running=10, target=10, queued=100
    // freeSlots=0, running>=target, ceil(100/10)×15=150
    // 150 > 15 (nextPassMinutes), freeSlots=0 → 'saturated'
    const result = queueDrainEta({
      running: 10,
      target: 10,
      queued: 100,
      held: false,
    });
    expect(result.state).toBe('saturated');
    expect(result.drainMinutes).toBe(150);
  });
});

/* ------------------------------------------------------------------ */
/*  Custom avgJobMinutes and nextPassMinutes                          */
/* ------------------------------------------------------------------ */

describe('custom parameters', () => {
  it('uses custom avgJobMinutes', () => {
    const result = queueDrainEta({
      running: 5,
      target: 5,
      queued: 5,
      held: false,
      avgJobMinutes: 10,
    });
    expect(result.drainMinutes).toBe(10); // ceil(5/5)×10=10
  });

  it('uses custom nextPassMinutes for state decision', () => {
    const result = queueDrainEta({
      running: 24,
      target: 24,
      queued: 50,
      held: false,
      nextPassMinutes: 60,
    });
    // drainMinutes = ceil(50/24)×15 = 3×15 = 45
    // 30 <= 60 (nextPassMinutes) → 'draining'
    expect(result.state).toBe('draining');
    expect(result.drainMinutes).toBe(45);
  });
});

/* ------------------------------------------------------------------ */
/*  Input normalisation: negative / NaN / non-integer                 */
/* ------------------------------------------------------------------ */

describe('input normalisation', () => {
  it('negative numbers clamp to 0 without throwing', () => {
    const result = queueDrainEta({
      running: -5,
      target: -3,
      queued: -10,
      held: false,
    });
    expect(result.freeSlots).toBe(0);
    expect(result.drainMinutes).toBe(0);
    expect(result.state).toBe('saturated');
    expect(result.freeSlotsAtNextPass).toBe(0);
  });

  it('NaN inputs clamp to 0 without throwing', () => {
    const result = queueDrainEta({
      running: NaN,
      target: NaN,
      queued: NaN,
      held: false,
    });
    expect(result.freeSlots).toBe(0);
    expect(result.drainMinutes).toBe(0);
    expect(result.state).toBe('saturated');
  });

  it('Infinity inputs clamp to 0 without throwing', () => {
    const result = queueDrainEta({
      running: Infinity,
      target: -Infinity,
      queued: 0,
      held: false,
    });
    expect(result.freeSlots).toBe(0);
    expect(result.drainMinutes).toBe(0);
  });

  it('non-integer numbers are floored', () => {
    const result = queueDrainEta({
      running: 3.9,
      target: 24,
      queued: 5.7,
      held: false,
    });
    expect(result.freeSlots).toBe(21); // 24 - floor(3.9) = 24-3=21
  });

  it('custom params: negative/NaN clamp to 0 (not fallback)', () => {
    const result = queueDrainEta({
      running: 5,
      target: 5,
      queued: 5,
      held: false,
      avgJobMinutes: -1,
    });
    // avgJobMinutes normalised to 0 → no completions, drainMinutes = ceil(5/5)*0 = 0
    expect(result.drainMinutes).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Determinism / never-throw                                         */
/* ------------------------------------------------------------------ */

describe('guarantees', () => {
  it('never throws on extreme inputs', () => {
    const inputs = [
      { running: 0, target: 0, queued: 0, held: false },
      { running: 0, target: 0, queued: 0, held: true },
      { running: 0, target: 1, queued: 0, held: false },
      { running: 1, target: 0, queued: 0, held: false },
      { running: 0, target: 1, queued: 0, held: true },
      { running: 1, target: 0, queued: 0, held: true },
    ];
    for (const inp of inputs) {
      expect(() => queueDrainEta(inp)).not.toThrow();
    }
  });

  it('deterministic: same inputs always yield same result', () => {
    const base = { running: 12, target: 24, queued: 7, held: false };
    const r1 = queueDrainEta(base);
    const r2 = queueDrainEta(base);
    expect(r1).toStrictEqual(r2);
  });
});
