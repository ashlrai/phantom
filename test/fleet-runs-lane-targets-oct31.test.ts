import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { parseLaneTargetAction, readLaneTargets, setLaneTarget } from '../src/core/fleet/runs-lane-targets.js';

let runsDir: string;
let path: string;
const now = () => new Date('2026-10-31T12:00:00Z');
const fixture = () => ({ lanes: {
  sol: { target: 2, floor: 0, ceiling: 4, held: false, last_change: 1793448000, unheld_by: 'Fake leader 2026-10-30T10:00:00Z', extra: { keep: true } },
  claude: { target: 1, floor: 1, ceiling: 3, held: true, held_reason: 'fixture hold', held_until: '2026-11-01T00:00:00Z', held_by: 'Fake owner 2026-10-31T10:00:00Z' },
}, metadata: { preserve: ['everything'] } });
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'lane-targets-'));
  await mkdir(join(runsDir, 'queue'));
  path = join(runsDir, 'queue/slots.json');
  await writeFile(path, JSON.stringify(fixture(), null, 1));
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });
it('maps lane fields and attribution with a generated timestamp', async () => {
  const state = await readLaneTargets({ runsDir, now });
  expect(state).toMatchObject({ v: 1, sourceState: 'healthy', generatedAt: now().toISOString() });
  expect(state.lanes).toEqual([
    { lane: 'sol', target: 2, floor: 0, ceiling: 4, held: false, heldReason: null, heldUntil: null, lastChange: new Date(1793448000 * 1000).toISOString(), changedBy: 'Fake leader 2026-10-30T10:00:00Z' },
    { lane: 'claude', target: 1, floor: 1, ceiling: 3, held: true, heldReason: 'fixture hold', heldUntil: '2026-11-01T00:00:00Z', lastChange: null, changedBy: 'Fake owner 2026-10-31T10:00:00Z' },
  ]);
});
it('changes only target and attribution, preserves held lanes and appends audit lines', async () => {
  const expected = fixture();
  const state = await setLaneTarget('sol', 3, { runsDir, now });
  Object.assign(expected.lanes.sol, { target: 3, last_change: now().getTime() / 1000, changed_by: `Phantom desktop ${now().toISOString()}` });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(expected);
  expect(state.lanes[0].changedBy).toBe(`Phantom desktop ${now().toISOString()}`);
  await setLaneTarget('claude', 2, { runsDir, now, changedBy: 'Fake phone' });
  expect((await readLaneTargets({ runsDir })).lanes[1]).toMatchObject({ target: 2, held: true, heldReason: 'fixture hold', floor: 1, ceiling: 3 });
  expect(await readFile(join(runsDir, 'queue/lane-target-changes.log'), 'utf8')).toBe(`${now().toISOString()}\tsol\t2->3\tPhantom desktop\n${now().toISOString()}\tclaude\t1->2\tFake phone\n`);
});
it('rejects unknown lanes and targets outside either bound without rewriting', async () => {
  const original = await readFile(path, 'utf8');
  for (const [lane, target, code] of [['sol', 5, 'out-of-range'], ['claude', 0, 'out-of-range'], ['absent', 1, 'unknown-lane'], ['sol', 1.5, 'out-of-range']] as const) {
    await expect(setLaneTarget(lane, target, { runsDir })).rejects.toMatchObject({ code, status: 422 });
    expect(await readFile(path, 'utf8')).toBe(original);
  }
});
it('reports missing, malformed, oversized and unsafe sources without throwing', async () => {
  await rm(path);
  expect((await readLaneTargets({ runsDir })).sourceState).toBe('missing');
  await expect(setLaneTarget('sol', 1, { runsDir })).rejects.toMatchObject({ code: 'unavailable', status: 503 });
  for (const text of ['{', 'x'.repeat(65537), '{"sol":{"target":1}}']) {
    await writeFile(path, text);
    expect(await readLaneTargets({ runsDir })).toMatchObject({ sourceState: 'degraded', lanes: [] });
  }
  await rm(path);
  const outside = join(runsDir, 'outside.json');
  await writeFile(outside, JSON.stringify(fixture()));
  await symlink(outside, path);
  expect((await readLaneTargets({ runsDir })).sourceState).toBe('degraded');
  await expect(setLaneTarget('sol', 1, { runsDir })).rejects.toMatchObject({ code: 'unavailable' });
  expect(JSON.parse(await readFile(outside, 'utf8'))).toEqual(fixture());
});
it('refuses queue and audit symlinks', async () => {
  const outside = join(runsDir, 'outside.log');
  await writeFile(outside, 'keep');
  await symlink(outside, join(runsDir, 'queue/lane-target-changes.log'));
  await expect(setLaneTarget('sol', 1, { runsDir })).rejects.toMatchObject({ code: 'unavailable' });
  expect(await readFile(outside, 'utf8')).toBe('keep');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(fixture());
  await rm(join(runsDir, 'queue'), { recursive: true });
  await mkdir(join(runsDir, 'elsewhere'));
  await symlink(join(runsDir, 'elsewhere'), join(runsDir, 'queue'));
  expect((await readLaneTargets({ runsDir })).sourceState).toBe('degraded');
});
it('accepts the direct lane map and validates exact action keys', async () => {
  await writeFile(path, JSON.stringify(fixture().lanes));
  expect((await setLaneTarget('sol', 0, { runsDir })).lanes[0].target).toBe(0);
  expect(parseLaneTargetAction({ lane: 'sol', target: 0 })).toEqual({ lane: 'sol', target: 0 });
  for (const body of [null, [], {}, { lane: 's', target: 1 }, { lane: '../sol', target: 1 }, { lane: 'sol', target: -1 }, { lane: 'sol', target: 1.2 }, { lane: 'sol', target: Number.MAX_SAFE_INTEGER + 1 }, { lane: 'sol', target: 1, extra: true }]) expect(parseLaneTargetAction(body)).toBeNull();
});
