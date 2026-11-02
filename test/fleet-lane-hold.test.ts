/**
 * RQ-PHX-LANEHOLDPLACE01 — `ashlr fleet lane-hold` places a bounded,
 * self-expiring hold on a lane through the same guarded slots.json rewrite
 * releaseLaneHold uses. A person's hold is never overwritten (manual-hold),
 * a Phantom hold always expires (minutes capped at 1440), and every
 * placement audits lane-target-changes.log plus one dispatch-events.log
 * narration line. Temp runs dirs only — nothing here touches a real
 * ~/.ashlr-runs.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { placeLaneHold } from '../src/core/fleet/runs-lane-hold-place.js';
import { cmdFleetLaneHold } from '../src/cli/fleet-lane-hold.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const NOW = new Date('2026-11-01T00:08:00Z');
const now = () => NOW;
const ISO = NOW.toISOString();
const UNTIL = '2026-11-01T00:38:00Z';
const AUDIT = () => join(runsDir, 'queue/lane-target-changes.log');
const EVENTS = () => join(runsDir, 'dispatch-events.log');

let runsDir: string;
let slotsPath: string;
const fixture = () => ({
  'claude-api': { target: 4, floor: 0, ceiling: 8, held: false, last_change: 1793448000, changed_by: 'Fake leader 2026-10-31T10:00:00Z' },
  devin: { target: 2, floor: 0, ceiling: 4, held: true, held_reason: 'manual: operator', held_by: 'mason', last_change: 1793448000 },
  'codex-personal': { target: 1, floor: 0, ceiling: 3, held: false, last_change: 1793448000 },
});
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'lane-hold-place-'));
  await mkdir(join(runsDir, 'queue'));
  slotsPath = join(runsDir, 'queue/slots.json');
  await writeFile(slotsPath, JSON.stringify(fixture()));
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

it('places a bounded hold: sets held/held_by/held_until, keeps other rows untouched', async () => {
  const state = await placeLaneHold('claude-api', { runsDir, now, minutes: 30, reason: 'claude-api token rejected' });
  const file = JSON.parse(await readFile(slotsPath, 'utf8')) as Record<string, Record<string, unknown>>;
  expect(file['claude-api']).toMatchObject({
    target: 4, floor: 0, ceiling: 8, held: true,
    held_reason: 'claude-api token rejected',
    held_by: `phantom Phantom desktop ${ISO}`,
    held_until: UNTIL,
    last_change: Math.floor(NOW.getTime() / 1000),
    changed_by: 'Fake leader 2026-10-31T10:00:00Z',
  });
  expect(file.devin).toEqual(fixture().devin);
  expect(file['codex-personal']).toEqual(fixture()['codex-personal']);
  expect(state).toMatchObject({ v: 1, sourceState: 'healthy' });
  expect(state.lanes.find((entry) => entry.lane === 'claude-api'))
    .toMatchObject({ held: true, heldReason: 'claude-api token rejected', heldUntil: UNTIL });
});
it('appends exactly one audit line and one dispatch-events line per placement', async () => {
  await writeFile(EVENTS(), '2026-10-31 23:59:00 LANE_UNHOLD seed existing\n');
  await placeLaneHold('claude-api', { runsDir, now, minutes: 30, reason: 'claude-api token rejected', changedBy: 'fake-agent' });
  expect((await readFile(AUDIT(), 'utf8')).split('\n').filter(Boolean))
    .toEqual([`${ISO}\tclaude-api\thold 30m\tfake-agent: claude-api token rejected`]);
  expect((await readFile(EVENTS(), 'utf8')).split('\n').filter(Boolean)).toEqual([
    '2026-10-31 23:59:00 LANE_UNHOLD seed existing',
    `2026-11-01 00:08:00 LANE_HOLD placed claude-api by phantom: claude-api token rejected (until ${UNTIL})`,
  ]);
});
it('refuses a hold a person placed (manual-hold) and leaves the file untouched', async () => {
  const original = await readFile(slotsPath, 'utf8');
  await expect(placeLaneHold('devin', { runsDir, now, minutes: 30, reason: 'nope' }))
    .rejects.toMatchObject({ code: 'manual-hold', status: 422 });
  expect(await readFile(slotsPath, 'utf8')).toBe(original);
  expect(existsSync(AUDIT())).toBe(false);
});
it('rejects out-of-bounds minutes and an empty reason before any write', async () => {
  const original = await readFile(slotsPath, 'utf8');
  for (const opts of [
    { minutes: 0, reason: 'x' }, { minutes: 1441, reason: 'x' }, { minutes: 1.5, reason: 'x' },
    { minutes: 30, reason: '' }, { minutes: 30, reason: '   ' }, { minutes: 30, reason: 'no\nnewline' },
  ]) {
    await expect(placeLaneHold('claude-api', { runsDir, now, ...opts })).rejects.toThrow(TypeError);
  }
  expect(await readFile(slotsPath, 'utf8')).toBe(original);
  expect(existsSync(AUDIT())).toBe(false);
  expect(existsSync(EVENTS())).toBe(false);
});
it('refreshes a hold Phantom itself placed and extends its until', async () => {
  await placeLaneHold('claude-api', { runsDir, now, minutes: 30, reason: 'first' });
  await placeLaneHold('claude-api', { runsDir, now: () => new Date('2026-11-01T00:20:00Z'), minutes: 60, reason: 'second' });
  const file = JSON.parse(await readFile(slotsPath, 'utf8')) as Record<string, Record<string, unknown>>;
  expect(file['claude-api']).toMatchObject({ held: true, held_reason: 'second', held_until: '2026-11-01T01:20:00Z' });
});
it('verb: 2 on missing --reason, 0 with --json on success, 0 on --help', async () => {
  const out: string[] = [], err: string[] = [];
  const deps = { output: (text: string) => out.push(text), error: (text: string) => err.push(text) };
  expect(await cmdFleetLaneHold(['claude-api', '--minutes', '30', '--runs-dir', runsDir], deps)).toBe(2);
  expect(await readFile(slotsPath, 'utf8')).toBe(JSON.stringify(fixture()));
  expect(await cmdFleetLaneHold(['--help'], deps)).toBe(0);
  out.length = 0; err.length = 0;
  expect(await cmdFleetLaneHold(['claude-api', '--minutes', '30', '--reason', 'claude-api token rejected', '--runs-dir', runsDir, '--json'], deps)).toBe(0);
  const state = JSON.parse(out.join('\n')) as { v: number; lanes: { lane: string; held: boolean; heldUntil: string | null }[] };
  expect(state.v).toBe(1);
  expect(state.lanes.find((entry) => entry.lane === 'claude-api')).toMatchObject({ held: true });
});
it('routes through the fleet convention dispatch', () => {
  expect(resolveFleetSubcommand('lane-hold')).toEqual({ module: './fleet-lane-hold.js', exportName: 'cmdFleetLaneHold' });
});
