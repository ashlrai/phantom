/**
 * RQ-PHX-LANEAUTOHOLD01 — `ashlr fleet lane-autohold` is the action half of
 * `fleet lane-streaks`: it plans bounded holds with planLaneAutoHold and, on
 * --apply, writes them through placeLaneHold under 'lane-autohold'
 * attribution. Tests drive the real path — a temp runs dir with real
 * queue/slots.json and dispatch-events.log text in the real format — and
 * read slots.json back. Temp runs dirs only; nothing touches a real
 * ~/.ashlr-runs.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLaneAutohold } from '../src/cli/fleet-lane-autohold.js';
import { readDispatchEventsLog } from '../src/cli/fleet-lane-streaks.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const NOW = new Date('2026-11-01T06:00:00Z');
const now = () => NOW;
const DAY = '2026-11-01';
const UNTIL = '2026-11-01T07:00:00Z'; // NOW + default --hold-minutes 60
const AUDIT = () => join(runsDir, 'queue/lane-target-changes.log');
const EVENTS = () => join(runsDir, 'dispatch-events.log');
const SLOTS = () => join(runsDir, 'queue/slots.json');

let runsDir: string;
let seq = 0;

const row = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ target: 2, floor: 0, ceiling: 4, held: false, last_change: 1793448000, ...over });
const slots = (lanes: Record<string, Record<string, unknown>>): string => JSON.stringify(lanes);
const readSlots = async (): Promise<Record<string, Record<string, unknown>>> =>
  JSON.parse(await readFile(SLOTS(), 'utf8')) as Record<string, Record<string, unknown>>;
const event = (clock: string, rest: string): string => `${DAY} ${clock} ${rest}`;

/** n launches on `lane`, each ending EMPTY_DONE a minute later, starting at 05:0x. */
const burn = (lane: string, n: number, fromMin: number): string[] => {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    seq += 1;
    const id = `RQ-T${String(seq).padStart(2, '0')}A1101X8`;
    lines.push(event(`05:${String(fromMin + i).padStart(2, '0')}:00`, `LAUNCH ${id} repo-x ${lane} mid`));
    lines.push(event(`05:${String(fromMin + i).padStart(2, '0')}:30`, `EMPTY_DONE ${id}`));
  }
  return lines;
};
/** One launch ending PUBLISHED — an 'ok' lane with a launch in the window. */
const okLane = (lane: string, min: number): string[] => {
  seq += 1;
  const id = `RQ-T${String(seq).padStart(2, '0')}A1101X8`;
  return [event(`05:${String(min).padStart(2, '0')}:00`, `LAUNCH ${id} repo-x ${lane} mid`),
    event(`05:${String(min).padStart(2, '0')}:30`, `PUBLISHED ${id} pr-1`)];
};

beforeEach(async () => {
  seq = 0;
  runsDir = await mkdtemp(join(tmpdir(), 'lane-autohold-'));
  await mkdir(join(runsDir, 'queue'));
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

interface RunResult { code: number; out: string[]; err: string[] }
const run = async (args: string[]): Promise<RunResult> => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetLaneAutohold(args, {
    now,
    output: (text) => out.push(text),
    error: (text) => err.push(text),
  });
  return { code, out, err };
};
const jsonOut = (r: RunResult): { applied: boolean; decisions: Array<Record<string, unknown>> } =>
  JSON.parse(r.out.join('\n')) as { applied: boolean; decisions: Array<Record<string, unknown>> };

/** Base fixture: one holdable burning lane + ok lanes so the fleet-wide guard stays off. */
const baseFixture = async () => {
  await writeFile(SLOTS(), slots({
    'claude-api': row({ target: 4, ceiling: 8 }),
    'grok-x': row({ target: 1 }),
    'gemini-x': row({ target: 1 }),
    'kimi-x': row({ target: 1 }),
  }));
  await writeFile(EVENTS(), [
    ...burn('claude-api', 4, 10),
    ...okLane('grok-x', 30),
    ...okLane('gemini-x', 32),
    ...okLane('kimi-x', 34),
    '',
  ].join('\n'));
};

describe('fleet lane-autohold', () => {
  it('dry run prints decisions and writes nothing', async () => {
    await baseFixture();
    const original = await readFile(SLOTS(), 'utf8');
    const r = await run(['--runs-dir', runsDir, '--json']);
    expect(r.code).toBe(0);
    const report = jsonOut(r);
    expect(report.applied).toBe(false);
    expect(report.decisions).toEqual([
      expect.objectContaining({
        lane: 'claude-api', action: 'hold', result: 'would-hold',
        reason: 'burning: 4 of 4 empty in 90 min', launches: 4, empties: 4, heldUntil: null,
      }),
    ]);
    expect(await readFile(SLOTS(), 'utf8')).toBe(original);
    expect(existsSync(AUDIT())).toBe(false);
  });

  it('--apply holds the burning lane through placeLaneHold and leaves ok lanes alone', async () => {
    await baseFixture();
    const r = await run(['--runs-dir', runsDir, '--apply', '--json']);
    expect(r.code).toBe(0);
    expect(jsonOut(r).decisions).toEqual([
      expect.objectContaining({ lane: 'claude-api', result: 'held', heldUntil: UNTIL }),
    ]);
    const file = await readSlots();
    expect(file['claude-api']).toMatchObject({
      target: 4, held: true,
      held_reason: 'burning: 4 of 4 empty in 90 min',
      held_until: UNTIL,
      last_change: Math.floor(NOW.getTime() / 1000),
    });
    expect(String(file['claude-api']!.held_by)).toMatch(/^phantom lane-autohold /);
    expect(file['grok-x']).toMatchObject({ target: 1, held: false });
    expect(file['gemini-x']).toMatchObject({ target: 1, held: false });
    expect(file['kimi-x']).toMatchObject({ target: 1, held: false });
    expect((await readFile(AUDIT(), 'utf8')).split('\n').filter(Boolean)).toEqual([
      `${NOW.toISOString()}\tclaude-api\thold 60m\tlane-autohold: burning: 4 of 4 empty in 90 min`,
    ]);
    expect((await readFile(EVENTS(), 'utf8')).split('\n').filter(Boolean).at(-1)).toBe(
      `2026-11-01 06:00:00 LANE_HOLD placed claude-api by phantom: burning: 4 of 4 empty in 90 min (until ${UNTIL})`,
    );
  });

  it('text mode prints one line per decision', async () => {
    await baseFixture();
    const r = await run(['--runs-dir', runsDir]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['"claude-api"  would-hold  "burning: 4 of 4 empty in 90 min"']);
  });

  it("a person's hold stays unchanged and is reported skipped", async () => {
    const lanes = {
      'claude-api': row({ target: 4, ceiling: 8 }),
      devin: row({ held: true, held_reason: 'manual: operator', held_by: 'mason', held_until: '2026-11-01T09:00:00Z' }),
      'grok-x': row({ target: 1 }),
      'gemini-x': row({ target: 1 }),
      'kimi-x': row({ target: 1 }),
      'o-three': row({ target: 1 }),
    };
    await writeFile(SLOTS(), slots(lanes));
    await writeFile(EVENTS(), [
      ...burn('claude-api', 4, 10), ...burn('devin', 4, 20),
      ...okLane('grok-x', 40), ...okLane('gemini-x', 42), ...okLane('kimi-x', 44), ...okLane('o-three', 46), '',
    ].join('\n'));
    const original = await readFile(SLOTS(), 'utf8');
    const r = await run(['--runs-dir', runsDir, '--apply', '--json']);
    expect(r.code).toBe(0);
    const decisions = jsonOut(r).decisions;
    expect(decisions.find((d) => d.lane === 'devin')).toMatchObject({
      action: 'skip', result: 'skipped', reason: 'already-held',
    });
    expect(decisions.find((d) => d.lane === 'claude-api')).toMatchObject({ result: 'held' });
    const file = await readSlots();
    expect(file.devin).toEqual(lanes.devin);
    expect(await readFile(SLOTS(), 'utf8')).not.toBe(original);
  });

  it('skips an already-held lane and a target-0 lane', async () => {
    const lanes = {
      'claude-api': row({ target: 4, ceiling: 8 }),
      'zed-local': row({ held: true, held_reason: 'auto: empty streak', held_by: 'autobackoff' }),
      'codex-personal': row({ target: 0 }),
      'grok-x': row({ target: 1 }),
      'gemini-x': row({ target: 1 }),
      'kimi-x': row({ target: 1 }),
      'o-three': row({ target: 1 }),
      'q-two': row({ target: 1 }),
    };
    await writeFile(SLOTS(), slots(lanes));
    await writeFile(EVENTS(), [
      ...burn('claude-api', 4, 0), ...burn('zed-local', 4, 10), ...burn('codex-personal', 4, 20),
      ...okLane('grok-x', 40), ...okLane('gemini-x', 42), ...okLane('kimi-x', 44), ...okLane('o-three', 46), ...okLane('q-two', 48), '',
    ].join('\n'));
    const r = await run(['--runs-dir', runsDir, '--apply', '--json']);
    expect(r.code).toBe(0);
    const decisions = jsonOut(r).decisions;
    expect(decisions.find((d) => d.lane === 'zed-local')).toMatchObject({ result: 'skipped', reason: 'already-held' });
    expect(decisions.find((d) => d.lane === 'codex-personal')).toMatchObject({ result: 'skipped', reason: 'target-zero' });
    const file = await readSlots();
    expect(file['claude-api']!.held).toBe(true);
    expect(file['zed-local']).toMatchObject({ held_by: 'autobackoff' });
    expect(file['codex-personal']!.held).toBe(false);
  });

  it('fleet-wide guard holds nothing when more than half of active lanes burn', async () => {
    await writeFile(SLOTS(), slots({
      'claude-api': row({ target: 4, ceiling: 8 }),
      'codex-personal': row(),
      'grok-x': row({ target: 1 }),
    }));
    await writeFile(EVENTS(), [
      ...burn('claude-api', 4, 10), ...burn('codex-personal', 4, 20), ...okLane('grok-x', 40), '',
    ].join('\n'));
    const original = await readFile(SLOTS(), 'utf8');
    const r = await run(['--runs-dir', runsDir, '--apply', '--json']);
    expect(r.code).toBe(0);
    expect(jsonOut(r).decisions).toEqual([
      expect.objectContaining({ lane: 'claude-api', action: 'skip', result: 'skipped', reason: 'fleet-wide' }),
      expect.objectContaining({ lane: 'codex-personal', action: 'skip', result: 'skipped', reason: 'fleet-wide' }),
    ]);
    expect(await readFile(SLOTS(), 'utf8')).toBe(original);
    expect(existsSync(AUDIT())).toBe(false);
  });

  it('holds at most 2 lanes per run, worst first', async () => {
    await writeFile(SLOTS(), slots({
      'a-first': row(), 'b-second': row(), 'c-third': row(),
      'grok-x': row({ target: 1 }), 'gemini-x': row({ target: 1 }), 'kimi-x': row({ target: 1 }),
    }));
    await writeFile(EVENTS(), [
      ...burn('a-first', 6, 0), ...burn('b-second', 5, 10), ...burn('c-third', 4, 20),
      ...okLane('grok-x', 40), ...okLane('gemini-x', 42), ...okLane('kimi-x', 44), '',
    ].join('\n'));
    const r = await run(['--runs-dir', runsDir, '--apply', '--json']);
    expect(r.code).toBe(0);
    const decisions = jsonOut(r).decisions;
    expect(decisions.map((d) => [d.lane, d.result, d.reason])).toEqual([
      ['a-first', 'held', 'burning: 6 of 6 empty in 90 min'],
      ['b-second', 'held', 'burning: 5 of 5 empty in 90 min'],
      ['c-third', 'skipped', 'over-cap'],
    ]);
    const file = await readSlots();
    expect(file['a-first']!.held).toBe(true);
    expect(file['b-second']!.held).toBe(true);
    expect(file['c-third']!.held).toBe(false);
  });

  it('an unreadable events log exits 1 and holds nothing', async () => {
    await writeFile(SLOTS(), slots({ 'claude-api': row() }));
    const original = await readFile(SLOTS(), 'utf8');
    for (const args of [['--runs-dir', runsDir], ['--runs-dir', runsDir, '--apply']]) {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.out).toEqual(['lane-autohold: dispatch events unavailable']);
    }
    expect(await readFile(SLOTS(), 'utf8')).toBe(original);
    expect(existsSync(AUDIT())).toBe(false);
  });

  it('unavailable lane targets exit 1 and hold nothing', async () => {
    await writeFile(EVENTS(), [...burn('claude-api', 4, 10), ''].join('\n'));
    const r = await run(['--runs-dir', runsDir, '--apply']);
    expect(r.code).toBe(1);
    expect(r.out).toEqual(['lane-autohold: lane targets unavailable (missing)']);
  });

  it('bad flags exit 2 before any read or write', async () => {
    await baseFixture();
    const original = await readFile(SLOTS(), 'utf8');
    for (const args of [
      ['--bogus'], ['claude-api'], ['--minutes'], ['--minutes', '5'], ['--minutes', '1441'],
      ['--minutes', 'abc'], ['--hold-minutes', '4'], ['--hold-minutes', '241'], ['--hold-minutes', 'x'],
      ['--min-empties', '0'], ['--runs-dir', 'relative/path'], ['--json', '--json'], ['--apply', '--apply'],
    ]) {
      const r = await run(args);
      expect(r.code).toBe(2);
      expect(r.err[0]).toContain('Invalid arguments');
    }
    expect(await readFile(SLOTS(), 'utf8')).toBe(original);
    expect(existsSync(AUDIT())).toBe(false);
  });

  it('--help exits 0 without reading anything', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain('lane-autohold');
  });

  it('resolves through the fleet convention registry', async () => {
    expect(resolveFleetSubcommand('lane-autohold')).toEqual({
      module: './fleet-lane-autohold.js', exportName: 'cmdFleetLaneAutohold',
    });
    expect(Object.hasOwn(FLEET_SUBCOMMAND_LOADERS, 'lane-autohold')).toBe(true);
    const loaded = await FLEET_SUBCOMMAND_LOADERS['lane-autohold']!();
    expect(typeof loaded['cmdFleetLaneAutohold']).toBe('function');
  });

  it('dispatches end-to-end through cmdFleet', async () => {
    const log: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...p: unknown[]) => log.push(p.join(' ')));
    try {
      expect(await cmdFleet(['lane-autohold', '--help'])).toBe(0);
    } finally { spy.mockRestore(); }
    expect(log[0]).toContain('Usage: ashlr fleet lane-autohold');
  });

  it('readDispatchEventsLog honors an explicit runs dir', async () => {
    await writeFile(EVENTS(), [...burn('claude-api', 4, 10), ''].join('\n'));
    expect(await readDispatchEventsLog(runsDir)).toContain('LAUNCH RQ-T01A1101X8 repo-x claude-api mid');
  });
});
