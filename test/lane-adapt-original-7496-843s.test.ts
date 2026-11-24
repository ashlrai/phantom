import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleetLaneAdapt } from '../src/cli/fleet-lane-adapt.js';
import { parseDispatchEventLine } from '../src/core/fabric/dispatch-events.js';
import { buildLaneAdapt, formatLaneAdaptText, healthySamples, laneAdaptDigestLine, readLaneAdapt } from '../src/core/fleet/lane-adapt.js';

const now = Date.parse('2026-11-19T15:00:00Z');
const minute = 60_000;
const stamp = (ago: number) => new Date(now - ago * minute).toISOString();
const event = (ago: number, payload: string) => {
  const parsed = parseDispatchEventLine(`${stamp(ago)} ${payload}`);
  if (!parsed.ok) throw new Error('invalid synthetic dispatch event');
  return parsed.event;
};
const pause = 'ADAPT claude 8->2 reason=backoff:memguard load1=1.2 mem_why=PAUSE file present';
const sample = (ago: number, free: number | null) => JSON.stringify({ ts: stamp(ago), event: 'launch', mem_free_pct: free });
const base = { lanes: [{ lane: 'claude', target: 3, floor: 2, ceiling: 8 }, { lane: 'codex-local', target: 4, floor: 1, ceiling: 9 }], nowMs: now, sinceMs: now - 360 * minute };

describe('original lane adaptation evidence', () => {
  it('attributes PAUSE to memory and distinguishes configured target from observed high', () => {
    const report = buildLaneAdapt({ ...base, events: [event(30, pause)], memFreePct: 55, paused: true });
    const row = report.lanes[0]!;
    expect(report.schema).toBe('lanes.adapt.v1');
    expect(row).toMatchObject({ target: 3, floor: 2, ceiling: 8, adapted_level: 2, normal_level: 8, still_cut: true, minutes_below_target: 30, cause_now: { present: true }, backed_off_while_healthy: false });
    expect(row.last_cut).toMatchObject({ from: 8, to: 2, reason: 'backoff:memguard', causes: ['memory'], pause_file: true, signals: { load1: 1.2 } });
    expect(row.last_cut!.why).toContain('the PAUSE file was present');
  });

  it('keeps a swap cause unknown without a current swap reading', () => {
    const report = buildLaneAdapt({ ...base, events: [event(20, 'ADAPT codex-local 6->4 reason=backoff:swap_growth swap_growth_gb=3.2 swap_gb=9.1')], memFreePct: 60, paused: false });
    const row = report.lanes[1]!;
    expect(row.last_cut).toMatchObject({ causes: ['swap'], signals: { swap_growth_gb: 3.2 } });
    expect(row.last_cut!.why).toContain('swap grew 3.2 GB');
    expect(row).toMatchObject({ cause_now: { present: null }, cause_cleared_by: null, backed_off_while_healthy: false });
  });

  it('counts separate below-high intervals across recovery and records missing readings', () => {
    const report = buildLaneAdapt({ ...base, memFreePct: null, paused: null, events: [event(50, pause), event(30, 'ADAPT claude 2->8 reason=raise'), event(20, 'ADAPT claude 8->6 reason=backoff:memguard free=12'), event(10, 'ADAPT claude 6->8 reason=raise'), event(5, 'EMPTY_SIGNAL claude swap unreadable')] });
    expect(report.lanes[0]).toMatchObject({ still_cut: false, minutes_below_target: 30, empty_signals: { count: 1, last_at: stamp(5) }, cause_now: null });
    expect(report.lanes[1]!.line).toContain('did not move it');
    expect(report.memory).toEqual({ free_pct: null, paused: null });
  });

  it('requires sustained positive memory samples and resets the streak on low or missing readings', () => {
    const input = { ...base, events: [event(40, pause), event(30, 'ADAPT claude 2->3 reason=raise')], memFreePct: 55, paused: false };
    for (const samples of [[], healthySamples(sample(5, 60)), healthySamples([sample(25, 60), sample(5, null)].join('\n'))]) {
      const report = buildLaneAdapt({ ...input, samples });
      expect(report.flagged).toEqual([]);
      expect(report.lanes[0]!.backed_off_while_healthy).toBe(false);
    }
    const report = buildLaneAdapt({ ...input, samples: healthySamples([sample(30, 60), sample(20, 14), sample(15, 70), sample(12, 58)].join('\n')) });
    expect(report.lanes[0]).toMatchObject({ adapted_level: 3, still_cut: true, minutes_below_target: 40, cause_now: { present: false }, cause_cleared_by: stamp(15), backed_off_while_healthy: true });
    expect(report.flagged).toEqual(['claude']);
    expect(laneAdaptDigestLine(report)).toBe('adapt: claude is at 3 of 8 slots but the cause (memory) cleared over 10 min ago');
    expect(formatLaneAdaptText(report)).toContain('Cut while healthy: claude');
  });

  it('runs the current CLI JSON path against a synthetic isolated runs root', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'adapt-843s-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mkdirSync(join(runsDir, 'queue'));
      writeFileSync(join(runsDir, 'queue', 'dispatch-events.log'), `${stamp(30)} ${pause}\n`);
      const reader = (options: { sinceMs: number; now: () => number }) => readLaneAdapt({ ...options, runsDir });
      expect(await cmdFleetLaneAdapt(['--since', '2h', '--json'], reader, () => now)).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ schema: 'lanes.adapt.v1', window_minutes: 120, source: 'present', lanes: [{ lane: 'claude', target: null, last_cut: { pause_file: true }, cause_now: { present: null } }], flagged: [] });
      expect(await cmdFleetLaneAdapt(['--since', 'soon'], reader, () => now)).toBe(2);
      expect(await cmdFleetLaneAdapt(['--bogus'], reader, () => now)).toBe(2);
    } finally { log.mockRestore(); error.mockRestore(); rmSync(runsDir, { recursive: true, force: true }); }
  });
});
