import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { laneRowProblem, readLaneTargets, setLaneTarget } from '../src/core/fleet/runs-lane-targets.js';
import { releaseLaneHold } from '../src/core/fleet/runs-lane-hold.js';
import { placeLaneHold } from '../src/core/fleet/runs-lane-hold-place.js';
import { formatLaneTargets } from '../src/cli/fleet-lane-target.js';

// Shaped like the dispatch daemon's real file: null ceiling means "no fixed
// ceiling", some lanes omit it, extra keys ride along, and one lane is broken.
const fixture = () => ({
  hard_cap: 12,
  last_change_by: 'Fake leader 2026-11-20T10:00:00Z',
  claude: { target: 3, floor: 1, ceiling: null, held: false, pause_new_until: '2026-11-20T11:00:00Z', backoff_note: 'fixture note' },
  'codex-local': { target: 5, floor: 2, held: true, held_by: 'autobackoff', held_reason: 'fixture hold', held_until: '2026-11-21T00:00:00Z' },
  sol: { target: 2, floor: 0, ceiling: 4, hard_cap: 3, held: false },
  grok: { target: 1, floor: 0, ceiling: 'lots' },
  cursor: { target: 1, floor: 3, ceiling: 2 },
});
let runsDir: string;
let path: string;
const now = () => new Date('2026-11-20T12:00:00Z');
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'lane-ceiling-null-'));
  await mkdir(join(runsDir, 'queue'));
  path = join(runsDir, 'queue/slots.json');
  await writeFile(path, JSON.stringify(fixture(), null, 1));
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

it('reads null and missing ceilings as no fixed ceiling and skips only broken lanes', async () => {
  const state = await readLaneTargets({ runsDir, now });
  expect(state.sourceState).toBe('healthy');
  expect(state.lanes.map(l => [l.lane, l.ceiling])).toEqual([['claude', null], ['codex-local', null], ['sol', 4]]);
  expect(state.skipped).toEqual([
    { lane: 'grok', reason: 'ceiling is not a whole number (use null for no fixed ceiling)' },
    { lane: 'cursor', reason: 'floor is above ceiling' },
  ]);
  const text = formatLaneTargets(state);
  expect(text).toContain('1..none');
  expect(text).toContain('skipped lane grok: ceiling is not a whole number');
});
it('rejects real garbage per row', () => {
  expect(laneRowProblem('a1', { target: 1, floor: 0, ceiling: -1 })).toMatch(/ceiling/);
  expect(laneRowProblem('a1', { target: -1, floor: 0 })).toMatch(/target/);
  expect(laneRowProblem('a1', { target: 1, floor: 0, ceiling: null })).toBeNull();
});
it('sets a target on an unbounded lane, bounded only by hard_cap when present', async () => {
  await setLaneTarget('claude', 40, { runsDir, now });
  expect((await readLaneTargets({ runsDir })).lanes[0].target).toBe(40);
  await expect(setLaneTarget('sol', 4, { runsDir, now })).rejects.toMatchObject({ code: 'out-of-range' });
  await expect(setLaneTarget('grok', 1, { runsDir, now })).rejects.toMatchObject({ code: 'unavailable' });
});
it('releases and places holds with null ceilings and leaves other rows untouched', async () => {
  await releaseLaneHold('codex-local', { runsDir, now, reason: 'reset' });
  const afterRelease = JSON.parse(await readFile(path, 'utf8'));
  expect(afterRelease['codex-local'].held).toBe(false);
  expect(afterRelease.grok).toEqual(fixture().grok);
  await placeLaneHold('claude', { runsDir, now, minutes: 30, reason: 'fixture reason' });
  const afterPlace = JSON.parse(await readFile(path, 'utf8'));
  expect(afterPlace.claude).toMatchObject({ held: true, ceiling: null, pause_new_until: '2026-11-20T11:00:00Z' });
  await expect(placeLaneHold('grok', { runsDir, now, minutes: 30, reason: 'fixture reason' })).rejects.toMatchObject({ code: 'unavailable' });
});
