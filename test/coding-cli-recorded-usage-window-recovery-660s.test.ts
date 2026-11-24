import { describe, expect, it } from 'vitest';
import {
  projectRecordedUsageWindow,
  RECORDED_USAGE_WINDOW_PROVENANCE,
  type RecordedUsageEvent,
  type RecordedUsageWindowInput,
} from '../src/core/providers/coding-cli/recorded-usage-window.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const T0 = Date.parse('2026-01-08T00:00:00Z'); // reset boundary; window [01-01, 01-08)
const iso = (ms: number) => new Date(ms).toISOString();
const ev = (ms: number, consumer: RecordedUsageEvent['consumer'], fraction: number): RecordedUsageEvent => ({
  ts: iso(ms),
  consumer,
  fraction,
});
const base = (over: Partial<RecordedUsageWindowInput> = {}): RecordedUsageWindowInput => ({
  nowMs: T0 - DAY,
  resetAt: iso(T0),
  resetEveryMs: WEEK,
  events: [],
  ...over,
});

describe('recorded usage window recovery (#5952 projectUltra)', () => {
  it('carries provenance and never claims current allowance', () => {
    const p = projectRecordedUsageWindow(base());
    expect(p.provenance).toEqual({ sourcePr: 5952, sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886', basis: 'historical-offline' });
    expect(RECORDED_USAGE_WINDOW_PROVENANCE.basis).toBe('historical-offline');
    expect(p.currentAllowanceEvidence).toBe(false);
    expect(p.remaining).toBe(1);
  });

  it('counts a snapshot in the window and skips events at or before its as-of', () => {
    const asOf = T0 - 3 * DAY;
    const p = projectRecordedUsageWindow(
      base({
        snapshot: { usedFraction: 0.3, asOf: iso(asOf) },
        events: [ev(asOf - 1, 'orchestrator', 0.5), ev(asOf, 'orchestrator', 0.5), ev(asOf + 1, 'orchestrator', 0.1), ev(asOf + 2, 'cloud-agent', 0.2)],
      }),
    );
    expect(p.snapshotCounted).toBe(true);
    expect(p.unsplitUsedFraction).toBe(0.3);
    expect(p.orchestrator).toBeCloseTo(0.1);
    expect(p.cloudAgent).toBeCloseTo(0.2);
    expect(p.usedFraction).toBeCloseTo(0.6);
    expect(p.remaining).toBeCloseTo(0.4);
  });

  it('excludes expired, future and malformed snapshots without implying zero usage', () => {
    const ev1 = [ev(T0 - 2 * DAY, 'orchestrator', 0.1)];
    for (const asOf of [iso(T0 - WEEK - 1), iso(T0 - DAY + 1), iso(T0), 'garbage']) {
      const p = projectRecordedUsageWindow(base({ snapshot: { usedFraction: 0.9, asOf }, events: ev1 }));
      expect(p.snapshotCounted).toBe(false);
      expect(p.unsplitUsedFraction).toBe(0);
      expect(p.orchestrator).toBeCloseTo(0.1); // events before asOf are no longer covered
      expect(p.currentAllowanceEvidence).toBe(false);
    }
  });

  it('applies start/reset/now boundaries', () => {
    const start = T0 - WEEK;
    const now = T0 - DAY;
    const p = projectRecordedUsageWindow(
      base({
        nowMs: now,
        events: [
          ev(start - 1, 'orchestrator', 0.01), // before start
          ev(start, 'orchestrator', 0.02), // at start: counted
          ev(now, 'cloud-agent', 0.04), // at now: counted
          ev(now + 1, 'cloud-agent', 0.08), // after now
        ],
      }),
    );
    expect(p.windowStartMs).toBe(start);
    expect(p.orchestrator).toBeCloseTo(0.02);
    expect(p.cloudAgent).toBeCloseTo(0.04);
    // snapshot exactly at window start counts; exactly at reset does not (checked above)
    const s = projectRecordedUsageWindow(base({ snapshot: { usedFraction: 0.5, asOf: iso(start) } }));
    expect(s.snapshotCounted).toBe(true);
    // event at the reset instant belongs to the next window, even when now == reset
    const atReset = projectRecordedUsageWindow(base({ nowMs: T0 - 1, events: [ev(T0, 'orchestrator', 0.3)] }));
    expect(atReset.orchestrator).toBe(0);
  });

  it('advances an elapsed reset by whole periods, including exactly at now', () => {
    const exact = projectRecordedUsageWindow(base({ nowMs: T0 }));
    expect(exact.resetAtMs).toBe(T0 + WEEK);
    const later = projectRecordedUsageWindow(base({ nowMs: T0 + 2 * WEEK + DAY, events: [ev(T0 + WEEK, 'orchestrator', 0.2), ev(T0 + WEEK - 1, 'orchestrator', 0.4)] }));
    expect(later.resetAtMs).toBe(T0 + 3 * WEEK);
    expect(later.windowStartMs).toBe(T0 + 2 * WEEK);
    expect(later.orchestrator).toBe(0);
    const inWin = projectRecordedUsageWindow(base({ nowMs: T0 + 2 * WEEK + DAY, events: [ev(T0 + 2 * WEEK + 1, 'cloud-agent', 0.2)] }));
    expect(inWin.cloudAgent).toBeCloseTo(0.2);
  });

  it('skips future, invalid and nonpositive observations; unknown consumer is cloud-agent', () => {
    const p = projectRecordedUsageWindow(
      base({
        events: [
          ev(T0 - 2 * DAY, 'orchestrator', 0),
          ev(T0 - 2 * DAY, 'orchestrator', -0.1),
          ev(T0 - 2 * DAY, 'orchestrator', Number.NaN),
          ev(T0 - 2 * DAY, 'orchestrator', Infinity),
          { ts: 'nope', consumer: 'orchestrator', fraction: 0.5 },
          ev(T0 - 2 * DAY, 'orchestrator', 0.05),
          { ts: iso(T0 - 2 * DAY), consumer: 'other' as never, fraction: 0.06 },
        ],
      }),
    );
    expect(p.orchestrator).toBeCloseTo(0.05);
    expect(p.cloudAgent).toBeCloseTo(0.06);
  });

  it('caps usage at 1 and remaining at 0 while keeping raw splits', () => {
    const p = projectRecordedUsageWindow(
      base({ snapshot: { usedFraction: 0.8, asOf: iso(T0 - 3 * DAY) }, events: [ev(T0 - 2 * DAY, 'orchestrator', 0.5), ev(T0 - 2 * DAY, 'cloud-agent', 0.5)] }),
    );
    expect(p.usedFraction).toBe(1);
    expect(p.remaining).toBe(0);
    expect(p.orchestrator).toBe(0.5);
    expect(p.unsplitUsedFraction).toBe(0.8);
  });

  it('rejects invalid time, period and snapshot input', () => {
    expect(() => projectRecordedUsageWindow(base({ nowMs: Number.NaN }))).toThrow(RangeError);
    expect(() => projectRecordedUsageWindow(base({ resetAt: 'bad' }))).toThrow(RangeError);
    expect(() => projectRecordedUsageWindow(base({ resetEveryMs: 0 }))).toThrow(RangeError);
    expect(() => projectRecordedUsageWindow(base({ resetEveryMs: -WEEK }))).toThrow(RangeError);
    expect(() => projectRecordedUsageWindow(base({ resetEveryMs: Infinity }))).toThrow(RangeError);
    expect(() => projectRecordedUsageWindow(base({ snapshot: { usedFraction: -0.1, asOf: iso(T0 - DAY) } }))).toThrow(RangeError);
    expect(() => projectRecordedUsageWindow(base({ snapshot: { usedFraction: Number.NaN, asOf: iso(T0 - DAY) } }))).toThrow(RangeError);
  });

  it('matches a test-local copy of the source algorithm on a valid corpus', () => {
    // Verbatim projectUltra arithmetic from the pinned source, minus config plumbing.
    const oracle = (resetAt: string, every: number, snap: { f: number; asOf: string } | null, events: readonly RecordedUsageEvent[], now: number) => {
      let r = Date.parse(resetAt);
      if (now >= r) r += (Math.floor((now - r) / every) + 1) * every;
      const ws = r - every;
      const asOf = snap ? Date.parse(snap.asOf) : NaN;
      const inWin = Number.isFinite(asOf) && asOf >= ws && asOf < r && asOf <= now;
      const unsplit = inWin && snap ? snap.f : 0;
      let o = 0;
      let c = 0;
      for (const e of events) {
        const ts = Date.parse(e.ts);
        if (!Number.isFinite(ts) || ts < ws || ts > now || ts >= r) continue;
        if (inWin && ts <= asOf) continue;
        if (!Number.isFinite(e.fraction) || e.fraction <= 0) continue;
        if (e.consumer === 'orchestrator') o += e.fraction;
        else c += e.fraction;
      }
      const used = Math.min(1, Math.max(0, unsplit + o + c));
      return { remaining: Math.max(0, 1 - used), usedFraction: used, unsplitUsedFraction: unsplit, orchestrator: o, cloudAgent: c, resetAtMs: r };
    };
    const events = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 9.5, 13.5].flatMap((d, i) => [ev(T0 - WEEK + d * DAY, i % 2 ? 'cloud-agent' : 'orchestrator', 0.03 * (i + 1))]);
    for (const nowDays of [-3, -0.5, 0, 0.5, 3, 6.9, 7, 10, 20]) {
      for (const snap of [null, { f: 0.25, asOf: iso(T0 - 4 * DAY) }, { f: 0.4, asOf: iso(T0 + 2 * DAY) }]) {
        const now = T0 + nowDays * DAY;
        const got = projectRecordedUsageWindow(base({ nowMs: now, snapshot: snap ? { usedFraction: snap.f, asOf: snap.asOf } : undefined, events }));
        const want = oracle(iso(T0), WEEK, snap, events, now);
        expect({ ...got, provenance: undefined }).toMatchObject(want);
      }
    }
  });
});
