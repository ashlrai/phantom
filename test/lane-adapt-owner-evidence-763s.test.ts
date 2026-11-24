import { describe, expect, it, vi } from 'vitest';
import { parseDispatchEventLine } from '../src/core/fabric/dispatch-events.js';
import { buildLaneAdapt, formatLaneAdaptText, healthySamples, parseAdaptEvent, readLaneAdapt } from '../src/core/fleet/lane-adapt.js';
import { cmdFleetLaneAdapt } from '../src/cli/fleet-lane-adapt.js';

const now = Date.parse('2026-11-21T12:00:00Z');
const event = (time: string, payload: string) => {
  const result = parseDispatchEventLine(`2026-11-21T${time}:00Z ${payload}`);
  if (!result.ok) throw new Error('bad fixture');
  return result.event;
};
const events = [event('11:10', 'ADAPT alpha 8->2 reason=backoff:memguard mem_why=PAUSE file present'),
  event('11:20', 'ADAPT beta 6->4 reason=backoff:swap_growth swap_growth_gb=3.2'),
  event('11:30', 'ADAPT alpha 2->3 reason=raise'), event('11:40', 'EMPTY_SIGNAL alpha swap unreadable')];
const input = { events, lanes: [], memFreePct: 55, paused: false, nowMs: now, sinceMs: now - 3600000 };

describe('preserved controller evidence', () => {
  it('keeps recorded cuts, ramp, times, unknown targets and missing readings', () => {
    const report = buildLaneAdapt(input);
    expect(report.lanes[0]).toMatchObject({ target: null, normal_level: 8, adapted_level: 3, empty_signals: { count: 1 }, last_cut: { pause_file: true } });
    expect(report.lanes[1]).toMatchObject({ cause_now: { present: null }, last_cut: { signals: { swap_growth_gb: 3.2 } } });
    expect(formatLaneAdaptText(report)).toContain('alpha: 2->3 at 2026-11-21T11:30:00.000Z');
    expect(report.flagged).toEqual([]);
  });
  it('requires positive memory evidence and rejects mixed unknown causes', () => {
    const samples = healthySamples(JSON.stringify({ ts: '2026-11-21T11:35:00Z', event: 'launch', mem_free_pct: 60 }));
    expect(buildLaneAdapt({ ...input, samples }).flagged).toEqual(['alpha']);
    expect(buildLaneAdapt({ ...input, samples, paused: null }).flagged).toEqual([]);
    expect(buildLaneAdapt({ ...input, samples, events: [event('11:10', 'ADAPT alpha 8->2 reason=backoff:memguard,swap')] }).flagged).toEqual([]);
    expect(healthySamples('{broken\n' + JSON.stringify({ ts: 'bad', event: 'launch' }))).toEqual([]);
    expect(parseAdaptEvent(event('11:00', 'ADAPT malformed'))).toBeNull();
  });
  it('skips node-pool producer rows when reading healthy memory samples', () => {
    // A session-pool `launch` reuses the dispatchd event name but carries no
    // mem_free_pct — its null reading would reset the healthy streak
    // clearedBy needs, so node-pool rows never become samples.
    const text = [
      JSON.stringify({ schema: 'fleet.session-pool.v1', ts: '2026-11-21T11:20:00Z', sessionId: 'sess-a', event: 'launch', context: 0, job: 'sess-a:1', jobId: 'ready:RQ-NODE-1:1' }),
      JSON.stringify({ schema: 'phm-node-runner.v1', ts: '2026-11-21T11:21:00Z', event: 'finish', job: 'ready:RQ-NODE-1:1:4', jobId: 'ready:RQ-NODE-1:1', node: 'muse', pack: 'shell-check', token: 4, outcome: 'succeeded' }),
      JSON.stringify({ ts: '2026-11-21T11:35:00Z', event: 'launch', mem_free_pct: 60 }),
    ].join('\n');
    expect(healthySamples(text)).toEqual([{ at: Date.parse('2026-11-21T11:35:00Z'), memFreePct: 60 }]);
  });
  it('reports missing and unreadable sources through injected readers', async () => {
    const readers = { events: vi.fn().mockRejectedValue(new Error('unreadable')), state: vi.fn().mockRejectedValue(new Error('unreadable')), jobs: vi.fn().mockRejectedValue(new Error('unreadable')) };
    const report = await readLaneAdapt({ now: () => now, runsDir: '/fake', readers });
    expect(report).toMatchObject({ source: 'unreadable', memory: { free_pct: null, paused: null }, lanes: [] });
    expect(formatLaneAdaptText(report)).toContain('unreadable');
    readers.events.mockResolvedValue({ source: 'missing', events: [], truncated: 4, malformedLines: 2 });
    expect(await readLaneAdapt({ now: () => now, runsDir: '/fake', readers })).toMatchObject({ source: 'missing', truncated: 4, malformed: 2 });
  });
  it('uses the same typed result for CLI JSON and rejects bad intervals', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = buildLaneAdapt(input);
    const reader = vi.fn().mockResolvedValue(report);
    expect(await cmdFleetLaneAdapt(['--since', '1h', '--json'], reader, () => now)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(report);
    expect(await cmdFleetLaneAdapt(['--since', '0h'], reader, () => now)).toBe(2);
    expect(await cmdFleetLaneAdapt(['--since', 'soon'], reader, () => now)).toBe(2);
    log.mockRestore(); error.mockRestore();
  });
});
