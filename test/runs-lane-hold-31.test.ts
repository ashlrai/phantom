import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { parseLaneHoldAction, releaseLaneHold } from '../src/core/fleet/runs-lane-hold.js';

let runsDir: string;
let path: string;
const now = () => new Date('2026-10-31T20:46:00Z');
const iso = now().toISOString();
const fixture = () => ({
  'codex-personal': { target: 4, floor: 0, ceiling: 8, held: true, held_reason: 'autobackoff codex_usage_limit job=j-fake until=2026-11-01T00:00:00Z src=cli_line', held_until: '2026-11-01T00:00:00Z', held_by: 'autobackoff', last_change: 1793448000 },
  devin: { target: 2, floor: 0, ceiling: 4, held: true, held_reason: 'usage cap', held_by: 'Mason t1221u', last_change: 1793448000 },
  claude: { target: 1, floor: 0, ceiling: 3, held: false, last_change: 1793448000, changed_by: 'Fake leader 2026-10-30T10:00:00Z' },
});
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'lane-hold-'));
  await mkdir(join(runsDir, 'queue'));
  path = join(runsDir, 'queue/slots.json');
  await writeFile(path, JSON.stringify(fixture(), null, 1));
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });
it('releases an autobackoff hold: drops the hold keys, stamps attribution and audits', async () => {
  const state = await releaseLaneHold('codex-personal', { runsDir, now, reason: 'codex reset' });
  const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, Record<string, unknown>>;
  const row = file['codex-personal'];
  // `held` stays a boolean — the file's own row checks require it — while the
  // three attribution keys go; the dispatcher reads falsy as unheld either way.
  expect(row).toMatchObject({ target: 4, floor: 0, ceiling: 8, held: false, last_change: Math.floor(now().getTime() / 1000) });
  for (const key of ['held_reason', 'held_by', 'held_until']) expect(row).not.toHaveProperty(key);
  expect(row.unheld_by).toBe(`Phantom desktop release (codex reset) ${iso}`);
  expect(row.unheld_by as string).toMatch(/\d{4}-\d{2}-\d{2}T\S+$/);
  expect(file.devin).toEqual(fixture().devin);
  expect(file.claude).toEqual(fixture().claude);
  expect(await readFile(join(runsDir, 'queue/lane-target-changes.log'), 'utf8')).toBe(`${iso}\tcodex-personal\theld->released\tPhantom desktop\n`);
  expect(state).toMatchObject({ v: 1, sourceState: 'healthy' });
  expect(state.lanes.find((lane) => lane.lane === 'codex-personal')).toMatchObject({ held: false, lastChange: iso, changedBy: `Phantom desktop release (codex reset) ${iso}` });
});
it('never releases a hold a person placed', async () => {
  const original = await readFile(path, 'utf8');
  await expect(releaseLaneHold('devin', { runsDir, now })).rejects.toMatchObject({ code: 'manual-hold', status: 422 });
  expect(await readFile(path, 'utf8')).toBe(original);
});
it('rejects open and unknown lanes without rewriting', async () => {
  const original = await readFile(path, 'utf8');
  for (const [lane, code] of [['claude', 'not-held'], ['absent', 'unknown-lane']] as const) {
    await expect(releaseLaneHold(lane, { runsDir })).rejects.toMatchObject({ code, status: 422 });
  }
  expect(await readFile(path, 'utf8')).toBe(original);
});
it('reports missing, symlinked and oversized sources without touching them', async () => {
  await rm(path);
  await expect(releaseLaneHold('codex-personal', { runsDir })).rejects.toMatchObject({ code: 'unavailable', status: 503 });
  const outside = join(runsDir, 'outside.json');
  await writeFile(outside, JSON.stringify(fixture()));
  await symlink(outside, path);
  await expect(releaseLaneHold('codex-personal', { runsDir })).rejects.toMatchObject({ code: 'unavailable', status: 503 });
  expect(JSON.parse(await readFile(outside, 'utf8'))).toEqual(fixture());
  await rm(path);
  await writeFile(path, 'x'.repeat(70 * 1024));
  await expect(releaseLaneHold('codex-personal', { runsDir })).rejects.toMatchObject({ code: 'unavailable', status: 503 });
});
it('validates exact action keys', async () => {
  expect(parseLaneHoldAction({ lane: 'claude', action: 'release' })).toEqual({ lane: 'claude', action: 'release' });
  expect(parseLaneHoldAction({ lane: 'claude', action: 'release', reason: 'why not' })).toEqual({ lane: 'claude', action: 'release', reason: 'why not' });
  for (const body of [null, [], {}, { lane: 'claude' }, { lane: 'claude', action: 'hold' }, { lane: 'x', action: 'release' }, { lane: '../claude', action: 'release' }, { lane: 'claude', action: 'release', extra: true }, { lane: 'claude', action: 'release', reason: 3 }, { lane: 'claude', action: 'release', reason: 'x'.repeat(121) }, { lane: 'claude', action: 'release', reason: 'no\nnewlines' }]) expect(parseLaneHoldAction(body)).toBeNull();
});
