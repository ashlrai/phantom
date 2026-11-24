import { describe, expect, it } from 'vitest';
import { computeLanesHeld, lanesHeldLines, laneHeldReason, LANES_HELD_SCHEMA } from '../src/core/fleet/lane-held.js';
import { cmdLanes } from '../src/cli/lanes.js';

const NOW = new Date(2026, 10, 20, 6, 0, 0).getTime();
/** Event line `min` minutes before NOW, in the log's local-time format. */
function at(min: number, body: string): string {
  const d = new Date(NOW - min * 60_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${body}`;
}
const launch = (min: number, id: string, lane = 'zai'): string => at(min, `LAUNCH ${id} phantom ${lane} mid`);
const held = (min: number, id: string): string => at(min, `LAUNCH_DEFERRED ${id} HELD (requeued, backoff 1800s)`);
const run = (lines: string[]) => computeLanesHeld(lines.join('\n'), NOW);

describe('computeLanesHeld', () => {
  it('3 held and 0 finishes is self-held', () => {
    const r = run([launch(50, 'A'), held(48, 'A'), launch(40, 'B'), held(38, 'B'), launch(20, 'C'), held(18, 'C')]);
    expect(r.schema).toBe(LANES_HELD_SCHEMA);
    expect(r.selfHeld).toEqual(['zai']);
    expect(r.lanes).toEqual([{ lane: 'zai', held: 3, finishes: 0, selfHeld: true, reason: 'lane zai holds every launch (3 in 60 min)' }]);
  });
  it('3 held and 1 finish is not self-held', () => {
    const r = run([launch(50, 'A'), held(48, 'A'), launch(40, 'B'), held(38, 'B'), launch(30, 'D'), at(25, 'PUBLISHED D https://x/pr/1'), launch(20, 'C'), held(18, 'C')]);
    expect(r.selfHeld).toEqual([]);
    expect(r.lanes[0]).toMatchObject({ lane: 'zai', held: 3, finishes: 1, selfHeld: false, reason: null });
  });
  it('an empty finish also counts as the lane running', () => {
    const r = run([launch(50, 'A'), held(48, 'A'), launch(40, 'B'), held(38, 'B'), launch(30, 'D'), at(25, 'EMPTY_DONE D'), launch(20, 'C'), held(18, 'C')]);
    expect(r.selfHeld).toEqual([]);
  });
  it('ignores events older than 60 min but still resolves their lane', () => {
    const r = run([launch(200, 'A'), held(61, 'A'), launch(90, 'B'), held(75, 'B'), launch(70, 'C'), held(10, 'C'), held(9, 'B'), held(8, 'A')]);
    expect(r.lanes).toEqual([expect.objectContaining({ held: 3, selfHeld: true })]);
    const old = run([launch(100, 'A'), held(90, 'A'), launch(95, 'B'), held(80, 'B'), launch(90, 'C'), held(70, 'C')]);
    expect(old.lanes).toEqual([]);
    expect(old.selfHeld).toEqual([]);
  });
  it('a finish older than the window does not clear a lane', () => {
    const r = run([launch(200, 'D'), at(120, 'PUBLISHED D https://x/pr/1'), launch(50, 'A'), held(48, 'A'), held(30, 'A'), held(10, 'A')]);
    expect(r.selfHeld).toEqual(['zai']);
  });
  it('skips malformed lines and counts them', () => {
    const r = run([launch(50, 'A'), held(48, 'A'), 'garbage with no timestamp', at(40, 'LAUNCH only-two parts'), at(39, 'LAUNCH_DEFERRED'),
      '2026-13-45 99:99:99 LAUNCH_DEFERRED A HELD', launch(30, 'B'), held(29, 'B'), launch(20, 'C'), held(19, 'C')]);
    expect(r.malformedLines).toBe(3);
    expect(r.lanes[0]).toMatchObject({ held: 3, selfHeld: true });
  });
  it('keeps lanes apart and ignores non-HELD deferrals', () => {
    const r = run([launch(50, 'A'), held(49, 'A'), launch(48, 'B'), held(47, 'B'), launch(46, 'C', 'claude'), held(45, 'C'),
      launch(44, 'E'), at(43, 'LAUNCH_DEFERRED E PAUSED (requeued)')]);
    expect(r.selfHeld).toEqual([]);
    expect(r.lanes.map(l => [l.lane, l.held])).toEqual([['zai', 2], ['claude', 1]]);
  });
  it('an unreadable log is unavailable, not clear', () => {
    const r = computeLanesHeld(null, NOW);
    expect(r).toMatchObject({ source: 'unavailable', lanes: [], selfHeld: [] });
    expect(lanesHeldLines(r)[0]).toMatch(/unreadable/);
  });
  it('plain words', () => {
    expect(laneHeldReason('zai', 6)).toBe('lane zai holds every launch (6 in 60 min)');
    expect(lanesHeldLines(run([]))).toEqual(['No lane has had a held launch in the last 60 min.']);
  });
});

describe('phm lanes held', () => {
  it('rejects bad flags', async () => {
    const err = console.error; console.error = () => undefined;
    try { expect(await cmdLanes(['held', '--bogus'])).toBe(2); } finally { console.error = err; }
  });
});
