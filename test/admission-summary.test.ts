import { expect, it, vi } from 'vitest';
import { summarizeAdmission } from '../src/core/fleet/admission-summary.js';
import { cmdFleetAdmission } from '../src/cli/fleet-admission.js';

const now = new Date(2026, 10, 21, 12).getTime();
const tick = (time: string, launched: number, wall: number, why = 'open') => `2026-11-21 ${time} tick run={"work":3} q=4 launched=${launched} reap=0 pause=False wall=${wall}s why=${why}`;
const guard = JSON.stringify({ why: 'over_host', settle_s: 300, total_running: 3, max_total_running: 20 });
it('scales a half hour of starts and load events, counts launch ticks and takes the median', () => {
  const log = [tick('11:30:00', 2, 3, 'over_host'), tick('11:40:00', 0, 5, 'over_owned'), tick('12:00:00', 2, 9)].join('\n');
  const b = summarizeAdmission(guard, log, now, { work: { target: 20 } });
  expect(b).toMatchObject({ startsPerHour: 8, ticksWithLaunch: 2, ticks: 3, settleSeconds: 300, lastWhy: 'over_host', overHostEventsPerHour: 4, medianTickWallSeconds: 5, windowSeconds: 1800,
    perLane: [{ lane: 'work', running: 3, target: 20, gap: 17 }], unknown: {} });
  expect(b.answer).toContain('3 of 20 running: guard reports 300 s settle');
  expect(b.answer).toContain('4 host or fleet load events/hour'); expect(b.answer).toContain('host load too high');
});
it('filters old, future and malformed ticks and averages the middle two walls', () => {
  const log = [tick('10:00:00', 9, 99), tick('12:01:00', 9, 99), 'plain', tick('11:00:00', 0, 2), tick('12:00:00', 0, 4)].join('\n');
  expect(summarizeAdmission(guard, log, now)).toMatchObject({ startsPerHour: 0, ticks: 2, ticksWithLaunch: 0, medianTickWallSeconds: 3, overHostEventsPerHour: 0 });
});
it('keeps missing files, missing reason history, zero duration and stale running counts unknown with reasons', () => {
  expect(summarizeAdmission(null, null, now)).toMatchObject({ startsPerHour: null, ticks: null, settleSeconds: null, lastWhy: null, unknown: { ticks: expect.stringContaining('missing'), settleSeconds: expect.stringContaining('missing') } });
  const b = summarizeAdmission(guard, tick('12:00:00', 2, 1).replace(' why=open', ''), now);
  expect(b.startsPerHour).toBeNull(); expect(b.overHostEventsPerHour).toBeNull(); expect(b.unknown.overHostEventsPerHour).toContain('history');
  expect(summarizeAdmission(guard, tick('11:30:00', 2, 1), now, { work: { target: 20 } }).perLane[0]).toMatchObject({ running: null, gap: null });
});
it('exposes measured pace through the existing CLI without requiring admission state', async () => {
  const log = [tick('11:30:00', 2, 3), tick('12:00:00', 0, 5)].join('\n');
  const files: Record<string, string> = { 'status.json': JSON.stringify({ admission: { cap: 20, running: 3, load1: 1 }, lanes: {} }), 'dispatchd.log': log, 'slots.json': JSON.stringify({ work: { target: 20 } }) };
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const reader = async (path: string) => { const text = files[path.split('/').at(-1)!]; if (!text) throw new Error('missing'); return text; };
    expect(await cmdFleetAdmission(['--json'], reader, now)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0])).admission).toMatchObject({ startsPerHour: 4, settleSeconds: null, unknown: { settleSeconds: expect.stringContaining('missing') } });
  } finally { output.mockRestore(); }
});
