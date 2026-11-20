/** Fixture tests for lanes.adapt.v1 (`phm lanes adapt`): real-format dispatch log lines, no real home. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdLanes } from '../src/cli/lanes.js';
import { parseDispatchEventLine } from '../src/core/fabric/dispatch-events.js';
import { asksText, listAsks } from '../src/core/fleet/asks.js';
import {
  buildLaneAdapt, formatLaneAdaptText, healthySamples, laneAdaptAskRequest, laneAdaptDigestLine, LANE_ADAPT_SCHEMA, raiseLaneAdaptAsks,
} from '../src/core/fleet/lane-adapt.js';

const NOW = new Date(2026, 10, 19, 15, 0, 0).getTime();
const MIN = 60_000;
/** dispatchd's own form: local wall clock `YYYY-MM-DD HH:MM:SS KIND payload`. */
const line = (minAgo: number, text: string): string => {
  const d = new Date(NOW - minAgo * MIN);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${text}`;
};
const events = (...lines: string[]) => lines.map(l => {
  const r = parseDispatchEventLine(l);
  if (!r.ok) throw new Error(`fixture line did not parse: ${l}`);
  return r.event;
});
const lanes = [{ lane: 'claude', target: 3, floor: 2, ceiling: 8 }, { lane: 'codex-local', target: 4, floor: 1, ceiling: 9 }];
const launch = (minAgo: number, free: number) => JSON.stringify({ ts: new Date(NOW - minAgo * MIN).toISOString(), event: 'launch', mem_free_pct: free });
const base = { lanes, nowMs: NOW, sinceMs: NOW - 6 * 60 * MIN };

const PAUSE_CUT = 'ADAPT claude 8->2 reason=backoff:memguard load1=1.2 mem_why=PAUSE file present';
const SWAP_CUT = 'ADAPT codex-local 6->4 reason=backoff:swap_growth swap_growth_gb=3.2 swap_gb=9.1';

describe('buildLaneAdapt', () => {
  it('reads the PAUSE-file cut in plain words and counts minutes below target', () => {
    const r = buildLaneAdapt({ ...base, events: events(line(30, PAUSE_CUT)), memFreePct: 55, paused: true });
    const row = r.lanes.find(l => l.lane === 'claude')!;
    expect(r.schema).toBe(LANE_ADAPT_SCHEMA);
    expect(row).toMatchObject({ target: 3, floor: 2, ceiling: 8, adapted_level: 2, normal_level: 8, still_cut: true, minutes_below_target: 30 });
    expect(row.last_cut).toMatchObject({ from: 8, to: 2, reason: 'backoff:memguard', pause_file: true });
    expect(row.last_cut!.causes).toContain('memory');
    expect(row.last_cut!.why).toContain('the PAUSE file was present');
    expect(row.cause_now).toMatchObject({ present: true });
    expect(row.backed_off_while_healthy).toBe(false);
  });

  it('reads the swap_growth cut and shows the current cause as unknown, never healthy', () => {
    const r = buildLaneAdapt({ ...base, events: events(line(20, SWAP_CUT)), memFreePct: 60, paused: false });
    const row = r.lanes.find(l => l.lane === 'codex-local')!;
    expect(row.last_cut).toMatchObject({ from: 6, to: 4, causes: ['swap'], signals: { swap_growth_gb: 3.2 } });
    expect(row.last_cut!.why).toContain('swap grew 3.2 GB');
    expect(row.cause_now).toMatchObject({ present: null });
    expect(row.backed_off_while_healthy).toBe(false);
  });

  it('flags a lane still cut when memory has been fine for over 10 minutes', () => {
    const r = buildLaneAdapt({
      ...base, events: events(line(40, PAUSE_CUT), line(30, 'ADAPT claude 2->3 reason=raise')), memFreePct: 55, paused: false,
      samples: healthySamples([launch(25, 60), launch(12, 58)].join('\n')),
    });
    const row = r.lanes.find(l => l.lane === 'claude')!;
    expect(row).toMatchObject({ still_cut: true, adapted_level: 3, backed_off_while_healthy: true, minutes_below_target: 40 });
    expect(row.cause_now).toMatchObject({ present: false });
    expect(r.flagged).toEqual(['claude']);
    expect(laneAdaptDigestLine(r)).toBe('adapt: claude is at 3 of 8 slots but the cause (memory) cleared over 10 min ago');
    expect(formatLaneAdaptText(r)).toContain('Cut while healthy: claude');
  });

  it('does not flag when the cause cleared under 10 minutes ago, or when when it cleared is unknown', () => {
    const recent = buildLaneAdapt({ ...base, events: events(line(40, PAUSE_CUT)), memFreePct: 55, paused: false, samples: healthySamples(launch(5, 60)) });
    expect(recent.flagged).toEqual([]);
    const unknown = buildLaneAdapt({ ...base, events: events(line(40, PAUSE_CUT)), memFreePct: 55, paused: false });
    expect(unknown.lanes[0]!.cause_now).toMatchObject({ present: false });
    expect(unknown.lanes[0]!.cause_cleared_by).toBeNull();
    expect(unknown.flagged).toEqual([]);
  });

  it('keeps a low-memory reading after the cut from counting as healthy', () => {
    const cut = 'ADAPT claude 8->6 reason=backoff:memguard free=12';
    const r = buildLaneAdapt({ ...base, events: events(line(40, cut)), memFreePct: 55, paused: false, samples: healthySamples([launch(30, 60), launch(20, 14), launch(15, 70)].join('\n')) });
    expect(r.lanes[0]!.last_cut!.signals.mem_free_pct).toBe(12);
    expect(r.lanes[0]!.cause_cleared_by).toBe(new Date(NOW - 15 * MIN).toISOString());
    expect(r.flagged).toEqual(['claude']);
  });

  it('reports a recovered lane, missing-reading notices, and a lane the controller never moved', () => {
    const r = buildLaneAdapt({
      ...base, memFreePct: null, paused: null,
      events: events(line(50, PAUSE_CUT), line(10, 'ADAPT claude 2->8 reason=raise'), line(5, 'EMPTY_SIGNAL claude swap unreadable'), line(4, 'LAUNCH something else')),
    });
    const claude = r.lanes.find(l => l.lane === 'claude')!;
    expect(claude).toMatchObject({ still_cut: false, minutes_below_target: 40, empty_signals: { count: 1 } });
    expect(r.lanes.find(l => l.lane === 'codex-local')!.line).toContain('did not move it');
    expect(r.memory).toEqual({ free_pct: null, paused: null });
  });
});

describe('Asks card and CLI', () => {
  let runsDir = '';
  beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'lane-adapt-')); });
  afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('renders one stable card per flagged lane and does not duplicate it', async () => {
    const r = buildLaneAdapt({
      ...base, events: events(line(40, PAUSE_CUT)), memFreePct: 55, paused: false, samples: healthySamples(launch(25, 60)),
    });
    const options = { runsDir, now: () => NOW };
    const ids = await raiseLaneAdaptAsks(r, options);
    expect(await raiseLaneAdaptAsks(r, options)).toEqual(ids);
    const list = listAsks(options);
    expect(list.count).toBe(1);
    expect(list.asks[0]).toMatchObject({ kind: 'approval', subject: 'claude-slots', request: laneAdaptAskRequest(r.lanes[0]!) });
    const text = asksText(list).join('\n');
    expect(text).toContain('Lane claude was cut from 8 to 2 slots');
    expect(text).toContain('Reply yes to raise it back now');
  });

  it('prints typed JSON with a schema id, and rejects bad usage with exit 2', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdLanes(['adapt', '--since', '2h', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ schema: 'lanes.adapt.v1', window_minutes: 120, flagged: [] });
    expect(await cmdLanes(['adapt', '--since', 'soon'])).toBe(2);
    expect(await cmdLanes(['adapt', '--bogus'])).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});
