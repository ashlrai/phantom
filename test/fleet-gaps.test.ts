import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetAwake } from '../src/cli/fleet-awake.js';
import { cmdFleetGaps } from '../src/cli/fleet-gaps.js';
import { cmdFleetPlannerTick } from '../src/cli/fleet-planner-tick.js';
import { holdKeepAwake, awakeStatus } from '../src/core/fleet/keep-awake.js';
import { buildFleetGaps, parseTicks, readFleetGaps, type Tick } from '../src/core/fleet/sleep-gaps.js';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { readClockSamples } from '../src/core/fleet/sleep-gaps.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';

const MIN = 60_000;
const T0 = Date.parse('2026-11-19T12:00:00Z');
const tick = (min: number, ready: number | null, run = false, reason: string | null = 'slots-full'): Tick =>
  ({ at: T0 + min * MIN, run, reason, ready, free: 2 });
const base = { now: T0 + 265 * MIN, since: T0 - 60 * MIN, launches: [] as number[] };
const dirs: string[] = [];
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), 'gaps-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('fleet gaps', () => {
  it('names a sleep gap when the clock samples prove the Mac slept', () => {
    const samples = [{ wall: T0 + 10 * MIN, mono: 1_000_000 }, { wall: T0 + 250 * MIN, mono: 1_000_000 + 10 * MIN }];
    const report = buildFleetGaps({ ...base, samples, ticks: [tick(0, 3), tick(10, 3), tick(250, 3), tick(260, 3)] });
    expect(report.schema).toBe('fleet.gaps.v1');
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({ kind: 'no-tick', cause: 'host-asleep', lostWork: true, jobsQueued: 3, minutes: 240 });
    expect(report.gaps[0]!.sleptMinutes).toBe(230);
    expect(report.gaps[0]!.line).toMatch(/^The Mac slept \d\d:\d\d to \d\d:\d\d; 4 hours of work did not run\.$/);
    expect(report.lostMinutes).toBe(240);
  });

  it('calls a no-tick gap a dispatcher stall when the clock shows the Mac was awake', () => {
    const samples = [{ wall: T0 + 10 * MIN, mono: 5_000 }, { wall: T0 + 100 * MIN, mono: 5_000 + 90 * MIN }];
    const gap = buildFleetGaps({ ...base, samples, now: T0 + 115 * MIN, ticks: [tick(0, 2), tick(10, 2), tick(100, 2), tick(110, 2)] }).gaps[0]!;
    expect(gap).toMatchObject({ cause: 'dispatcher-stalled', sleptMinutes: 0, lostWork: true });
    expect(gap.line).toContain('The dispatcher stalled');
  });

  it('shows the cause as unknown without clock samples', () => {
    const report = buildFleetGaps({ ...base, samples: null, now: T0 + 115 * MIN, ticks: [tick(0, 2), tick(100, 2), tick(110, 2)] });
    expect(report.sources.clock).toBe('unknown');
    expect(report.gaps[0]).toMatchObject({ cause: 'unknown', sleptMinutes: null });
    expect(report.gaps[0]!.line).toContain('the cause is unknown');
  });

  it('does not report an empty-queue gap as lost work', () => {
    const report = buildFleetGaps({ ...base, samples: [], now: T0 + 135 * MIN, ticks: [tick(0, 0), tick(120, 0), tick(130, 0)] });
    expect(report.gaps[0]).toMatchObject({ cause: 'queue-empty', lostWork: false });
    expect(report.lostMinutes).toBe(0);
    expect(report.gaps[0]!.line).toContain('the queue was empty');
  });

  it('keeps queue depth unknown when an edge tick could not read it', () => {
    // The planner tick omits phx when ready.tsv was unreadable; a gap whose
    // end edge carries no count cannot claim the queue stayed empty.
    const report = buildFleetGaps({ ...base, samples: [], now: T0 + 135 * MIN, ticks: [tick(0, null), tick(120, null), tick(130, null)] });
    expect(report.gaps[0]).toMatchObject({ kind: 'no-tick', cause: 'unknown', lostWork: null, jobsQueued: null });
    expect(report.gaps[0]!.cause).not.toBe('queue-empty');
    expect(report.lostMinutes).toBe(120);
  });

  it('does not call a gap provably empty when only its start edge read zero', () => {
    // ready=0 at the gap start but the end tick could not read the queue:
    // work may have been enqueued mid-gap, so depth and lost work stay unknown.
    const report = buildFleetGaps({ ...base, samples: [], now: T0 + 135 * MIN, ticks: [tick(0, 0), tick(120, null), tick(130, 0)] });
    expect(report.gaps[0]).toMatchObject({ kind: 'no-tick', cause: 'unknown', lostWork: null, jobsQueued: null });
    expect(report.lostMinutes).toBe(120);
  });

  it('the planner tick omits phx when the ready queue was unreadable', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'queue'), { recursive: true });
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({
      last_tick: new Date(T0).toISOString(), paused: false, mem_free_pct: 50,
      lanes: { devin: { running: 0, target: 2, queued: 0, floor: null, ceiling: null, held: false } },
    }));
    const out: string[] = [];
    const code = await cmdFleetPlannerTick(['--runs-dir', dir], { now: T0, output: (line) => out.push(line) });
    expect(code).toBe(0);
    // The unreadable detail proves this is the unknown-depth path, not an empty queue.
    expect(out.join('\n')).toContain('unreadable');
    const line = readFileSync(join(dir, 'queue', 'dispatch-events.log'), 'utf8').trim().split('\n').at(-1)!;
    expect(line).not.toContain('phx=');
    expect(parseTicks(line, T0 + MIN)).toMatchObject([{ ready: null, free: 2 }]);
  });

  it('flags admission-blocked when ticks ran on time, jobs waited and nothing launched', () => {
    const ticks = Array.from({ length: 5 }, (_, i) => tick(i * 10, 4));
    const report = buildFleetGaps({ ...base, samples: [], now: T0 + 45 * MIN, ticks });
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({ kind: 'no-launch', cause: 'admission-blocked', reason: 'slots-full', minutes: 40 });
    // A launch inside the stretch breaks it up.
    expect(buildFleetGaps({ ...base, samples: [], now: T0 + 45 * MIN, ticks, launches: [12, 24, 36].map(m => T0 + m * MIN) }).gaps).toHaveLength(0);
  });

  it('is unknown when the dispatch log cannot be read', async () => {
    const dir = scratch(), lines: string[] = [];
    expect(await cmdFleetGaps(['--json'], { runsDir: dir, now: T0, out: l => lines.push(l), samples: null, claudeLeftPct: null })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ schema: 'fleet.gaps.v1', count: null, lostMinutes: null });
  });

  it('parses PLANNER_TICK lines and rejects bad options', async () => {
    const ticks = parseTicks('2026-11-19 07:00:00 PLANNER_TICK skip reason=slots-full phx=3 free=0\nnoise\n', Date.parse('2026-11-20T00:00:00Z'));
    expect(ticks).toMatchObject([{ run: false, reason: 'slots-full', ready: 3, free: 0 }]);
    // The planner tick omits phx when the ready queue was unreadable; the
    // fold must read that as unknown depth, never a proven-empty queue.
    const unknown = parseTicks('2026-11-19 07:00:00 PLANNER_TICK run reason=low-supply free=2\n', Date.parse('2026-11-20T00:00:00Z'));
    expect(unknown).toMatchObject([{ run: true, reason: 'low-supply', ready: null, free: 2 }]);
    const report = await readFleetGaps({ runsDir: '/none', now: T0, read: async () => null, samples: null, claudeLeftPct: 40 });
    expect(report.claudeLeftPct).toBe(40);
    expect(await cmdFleetGaps(['--since', 'x'], { err: () => undefined })).toBe(2);
  });
});

describe('fleet awake', () => {
  const run = async (args: string[], dir: string): Promise<string> => { const out: string[] = []; await cmdFleetAwake([...args, '--runs-dir', dir], { out: l => out.push(l) }); return out.join(''); };

  it('is off by default, turns on and off with one switch file, and reports status as JSON', async () => {
    const dir = scratch();
    expect(awakeStatus(dir).enabled).toBe(false);
    expect(await run(['status'], dir)).toContain('Keep-awake is off');
    expect(await run(['on'], dir)).toContain('Keep-awake is on');
    expect(existsSync(join(dir, 'queue', 'keep-awake.on'))).toBe(true);
    expect(JSON.parse(await run(['status', '--json'], dir))).toMatchObject({ schema: 'fleet.awake.v1', enabled: true });
    await run(['off'], dir);
    expect(existsSync(join(dir, 'queue', 'keep-awake.on'))).toBe(false);
    expect(await cmdFleetAwake(['maybe'], { err: () => undefined })).toBe(2);
  });

  it('holds a caffeinate -i assertion bound to the tick pid only when on, queued and on power', async () => {
    const dir = scratch();
    const calls: string[][] = []; let killed = 0;
    const deps = { platform: 'darwin' as const, readPower: () => 'ac' as const, spawn: (a: string[]) => { calls.push(a); return { kill: () => { killed++; } }; } };
    expect(holdKeepAwake(dir, 3, deps).state).toBe('off');
    await run(['on'], dir);
    expect(holdKeepAwake(dir, 0, deps).state).toBe('queue-empty');
    expect(holdKeepAwake(dir, 3, { ...deps, readPower: () => 'battery' }).state).toBe('on-battery');
    expect(holdKeepAwake(dir, 3, { ...deps, platform: 'linux' }).state).toBe('not-macos');
    expect(calls).toHaveLength(0);
    const hold = holdKeepAwake(dir, 3, deps);
    expect(hold.state).toBe('held');
    expect(calls).toEqual([['-i', '-w', String(process.pid)]]);
    expect(awakeStatus(dir).line).toContain('holding the Mac awake');
    hold.release();
    expect(killed).toBe(1);
    expect(holdKeepAwake(dir, 3, { ...deps, spawn: () => null }).state).toBe('unavailable');
  });
});

describe('Mason digest', () => {
  it('adds the gap line only when one is given', () => {
    const fact = <T>(value: T) => ({ ok: true as const, value });
    const input = { installedVersion: fact('1'), publishedVersion: fact('1'), updatePending: false, mergesLastHour: fact(0), mergesLast24h: fact(0),
      lanes: fact([]), needsMason: fact(0), topP0: fact(null) };
    expect(buildStatusDigest(input)).toHaveLength(5);
    const line = 'The Mac slept 12:33 to 18:42; 6 hours of work did not run.';
    expect(buildStatusDigest({ ...input, gapLine: line })).toContain(line);
  });
});

describe('self-tick wiring', () => {
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.map(name => [name, async () => ({ exitCode: 0, output: '{}' })])) as unknown as SelfTickSteps;

  it('records a clock sample and holds then releases keep-awake on an applied tick; a dry run does neither', async () => {
    const dir = scratch(); let spawned = 0, killed = 0;
    const awake = { platform: 'darwin' as const, readPower: () => 'ac' as const, queued: async () => 2, spawn: () => { spawned++; return { kill: () => { killed++; } }; } };
    const call = (extra: string[]) => cmdFleetSelfTick(['--json', '--runs-dir', dir, ...extra], { steps, awake, home: dir, output: () => undefined, error: () => undefined });
    await cmdFleetAwake(['on', '--runs-dir', dir], { out: () => undefined });
    await call([]);
    expect([spawned, readClockSamples(dir)]).toEqual([0, null]);
    await call(['--apply']);
    expect(spawned).toBe(1);
    expect(killed).toBe(1);
    expect(readClockSamples(dir)).toHaveLength(1);
  });
});
