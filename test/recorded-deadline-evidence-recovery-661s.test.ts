import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEADLINE_WINDOW_MS,
  RECORDED_DEADLINE_EVIDENCE_PROVENANCE,
  recordedDeadlineEvidence,
  type RecordedDeadlineInput,
} from '../src/core/providers/coding-cli/recorded-deadline-evidence.js';

const NOW = 1_000_000;
const H = 3_600_000;
const run = (o: Partial<RecordedDeadlineInput>) =>
  recordedDeadlineEvidence({ carryover: false, asOfMs: NOW, ...o });

describe('recordedDeadlineEvidence (PR #5952 loseItUrgency recovery)', () => {
  it('carries source provenance and historical-offline basis', () => {
    expect(run({}).provenance).toEqual({
      sourcePr: 5952,
      sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
      basis: 'historical-offline',
    });
    expect(RECORDED_DEADLINE_EVIDENCE_PROVENANCE.basis).toBe('historical-offline');
  });

  it('missing deadlines mean no evidence, zero urgency', () => {
    for (const o of [{}, { expiresAtMs: null, resetAtMs: null }, { resetAtMs: Number.NaN }]) {
      expect(run(o)).toMatchObject({ deadlineMs: null, reason: 'no-deadline-evidence', urgency: 0 });
    }
  });

  it('expiry before reset wins and uses source arithmetic', () => {
    const r = run({ expiresAtMs: NOW + 24 * H, resetAtMs: NOW + 48 * H, resetEveryMs: 48 * H });
    expect(r).toMatchObject({ deadlineMs: NOW + 24 * H, reason: 'expiry', urgency: 0.5 });
  });

  it('expiry equal to reset is not an expiry candidate; reset is used unless carryover', () => {
    const at = NOW + 12 * H;
    expect(run({ expiresAtMs: at, resetAtMs: at })).toMatchObject({ deadlineMs: at, reason: 'reset' });
    expect(run({ expiresAtMs: at, resetAtMs: at, carryover: true })).toMatchObject({
      deadlineMs: null,
      urgency: 0,
    });
  });

  it('expiry after reset loses to the reset (noncarryover) and is ignored (carryover)', () => {
    const o = { expiresAtMs: NOW + 30 * H, resetAtMs: NOW + 10 * H };
    expect(run(o)).toMatchObject({ deadlineMs: NOW + 10 * H, reason: 'reset' });
    expect(run({ ...o, carryover: true }).deadlineMs).toBeNull();
  });

  it('carryover true ignores reset but keeps an expiry before it', () => {
    const r = run({ carryover: true, expiresAtMs: NOW + H, resetAtMs: NOW + 2 * H });
    expect(r).toMatchObject({ deadlineMs: NOW + H, reason: 'expiry' });
    expect(run({ carryover: true, resetAtMs: NOW + H }).deadlineMs).toBeNull();
  });

  it('expiry with no reset is a candidate', () => {
    expect(run({ expiresAtMs: NOW + H })).toMatchObject({ deadlineMs: NOW + H, reason: 'expiry' });
  });

  it('passed and exact-boundary deadlines are not candidates', () => {
    expect(run({ expiresAtMs: NOW - 1, resetAtMs: NOW - 1 }).deadlineMs).toBeNull();
    expect(run({ expiresAtMs: NOW, resetAtMs: NOW }).deadlineMs).toBeNull();
    expect(run({ resetAtMs: NOW + 1 }).deadlineMs).toBe(NOW + 1);
  });

  it('a passed expiry does not hide a future reset', () => {
    expect(run({ expiresAtMs: NOW - H, resetAtMs: NOW + H })).toMatchObject({ reason: 'reset' });
  });

  it('defaults to a seven-day window and honours an explicit one', () => {
    const left = DEFAULT_DEADLINE_WINDOW_MS / 4;
    const d = run({ resetAtMs: NOW + left });
    expect(d.windowMs).toBe(DEFAULT_DEADLINE_WINDOW_MS);
    expect(d.urgency).toBeCloseTo(0.75, 12);
    expect(run({ resetAtMs: NOW + left, resetEveryMs: null }).windowMs).toBe(DEFAULT_DEADLINE_WINDOW_MS);
    expect(run({ resetAtMs: NOW + 1000, resetEveryMs: 4000 }).urgency).toBeCloseTo(0.75, 12);
  });

  it('clamps urgency into [0, 1]', () => {
    expect(run({ resetAtMs: NOW + 10 * DEFAULT_DEADLINE_WINDOW_MS }).urgency).toBe(0);
    expect(run({ resetAtMs: NOW + 1, resetEveryMs: 1e12 }).urgency).toBeLessThanOrEqual(1);
    expect(run({ resetAtMs: NOW + 1, resetEveryMs: 0.5 }).urgency).toBe(0);
    expect(run({ resetAtMs: NOW + 1, resetEveryMs: 1 }).urgency).toBe(0);
    expect(run({ resetAtMs: NOW + 1, resetEveryMs: 2 }).urgency).toBe(0.5);
  });

  it('rejects invalid clocks and nonpositive/nonfinite supplied windows', () => {
    for (const asOfMs of [Number.NaN, Infinity, -Infinity]) {
      expect(() => run({ asOfMs, resetAtMs: NOW + 1 })).toThrow(RangeError);
    }
    for (const resetEveryMs of [0, -1, Number.NaN, Infinity]) {
      expect(() => run({ resetAtMs: NOW + 1, resetEveryMs })).toThrow(RangeError);
    }
  });

  it('is deterministic and leaves input unchanged', () => {
    const input = Object.freeze({
      carryover: false,
      asOfMs: NOW,
      expiresAtMs: NOW + H,
      resetAtMs: NOW + 2 * H,
      resetEveryMs: 4 * H,
    });
    const snapshot = JSON.stringify(input);
    expect(recordedDeadlineEvidence(input)).toEqual(recordedDeadlineEvidence(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
