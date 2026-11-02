/** lane-models-write.test.ts — fixtures for setLaneModel: one-key rewrites of
 * models.json, key order + effort.* preservation, resolved-tier preview,
 * audit rows, and every rejection code. Real temp dirs; fake model names. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaneModelWriteError, parseLaneModelKey, setLaneModel } from '../src/core/fleet/lane-models-write.js';

let dir: string;
let modelsPath: string;
const now = () => new Date('2026-11-01T23:30:00Z');
const iso = now().toISOString();
/** A fixture in the real map's shape: lane rows, family rows, effort rows,
 * plus keys the reader would drop — all invented names. */
const MODELS: Record<string, unknown> = {
  devin: 'fake-devin-default',
  'devin.work': 'fake-devin-work',
  'devin.fast': 'fake-devin-fast',
  codex: 'fake-codex-default',
  'codex.frontier': 'fake-codex-frontier',
  'codex-cmp': 'fake-codex-cmp',
  claude: 'fake-claude-default',
  'effort.codex.mid': 'high',
  'effort.devin.work': 'low',
  'odd key': 'preserved-anyway',
  count: 7,
};
const seed = async (models: unknown = MODELS) =>
  writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`);
const read = async () => readFile(modelsPath, 'utf8');
const keys = async () => Object.keys(JSON.parse(await read()) as Record<string, unknown>);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lane-models-write-'));
  modelsPath = join(dir, 'models.json');
  await seed();
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

it('parses <lane> and <lane>.<tier> keys and rejects everything else', () => {
  expect(parseLaneModelKey('devin')).toEqual({ lane: 'devin', tier: null });
  expect(parseLaneModelKey('devin.work')).toEqual({ lane: 'devin', tier: 'work' });
  expect(parseLaneModelKey('codex-cmp.x1')).toEqual({ lane: 'codex-cmp', tier: 'x1' });
  for (const bad of [
    'effort.devin.work', 'effort', 'effort.work', // effort.* is never a model key
    'Devin', 'DEVIN.work', 'devin.Work', // case
    'd', 'devin.', '.work', 'a.b.c', '', 'devin..work',
    'devin.work ', ' devin', 'devin work', '-devin', 'devin_bad',
    'x'.repeat(32), // lane longer than LANE_ID_RE
    `devin.${'t'.repeat(22)}`, // tier longer than the writer's tier cap
  ]) expect(parseLaneModelKey(bad), bad).toBeNull();
});

it('changes exactly one key and preserves every other key in order', async () => {
  const before = await read();
  const change = await setLaneModel({ key: 'devin.work', model: 'fake-lightning-2', reason: 'order 23:06' }, { runsDir: dir, now });
  expect(change).toMatchObject({ v: 1, applied: true, key: 'devin.work', before: 'fake-devin-work', after: 'fake-lightning-2', generatedAt: iso });
  const text = await read();
  expect(text.endsWith('\n')).toBe(true);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(Object.keys(MODELS)); // order unchanged
  for (const [key, value] of Object.entries(MODELS)) {
    if (key !== 'devin.work') expect(parsed[key], key).toEqual(value);
  }
  expect(parsed['devin.work']).toBe('fake-lightning-2');
  // effort.* and invalid keys survive byte-for-byte inside the 2-space file.
  expect(text).toContain('\n  "effort.codex.mid": "high"');
  expect(text).toContain('\n  "odd key": "preserved-anyway"');
  expect(text).toContain('\n  "count": 7');
  // and the diff really is one line
  expect(text.split('\n').filter((line, i) => line !== before.split('\n')[i]).length).toBe(1);
});

it('resolved reports the post-change outcome for the key\'s lane', async () => {
  const change = await setLaneModel({ key: 'devin.work', model: 'fake-lightning-2' }, { runsDir: dir, now });
  expect(change.resolved).toEqual([
    { tier: 'frontier', model: 'fake-devin-default', via: 'devin' },
    { tier: 'work', model: 'fake-lightning-2', via: 'devin.work' },
    { tier: 'mid', model: 'fake-devin-default', via: 'devin' },
    { tier: 'fast', model: 'fake-devin-fast', via: 'devin.fast' },
  ]);
  // a family key resolves through the family row for codex lanes
  const family = await setLaneModel({ key: 'codex.work', model: 'fake-codex-work' }, { runsDir: dir, now });
  expect(family.resolved.find(r => r.tier === 'work')).toEqual({ tier: 'work', model: 'fake-codex-work', via: 'codex.work' });
});

it('appends a new key at the end and keeps the file mode', async () => {
  await chmod(modelsPath, 0o640);
  const change = await setLaneModel({ key: 'devin.mid', model: 'fake-devin-mid' }, { runsDir: dir, now });
  expect(change.before).toBeNull();
  expect((await keys()).at(-1)).toBe('devin.mid');
  expect((await stat(modelsPath)).mode & 0o777).toBe(0o640);
});

it('unsets a key so the lane falls back to the next row', async () => {
  const change = await setLaneModel({ key: 'devin.work', model: null }, { runsDir: dir, now });
  expect(change).toMatchObject({ applied: true, before: 'fake-devin-work', after: null });
  expect(change.resolved.find(r => r.tier === 'work')).toEqual({ tier: 'work', model: 'fake-devin-default', via: 'devin' });
  expect(await keys()).toEqual(Object.keys(MODELS).filter(k => k !== 'devin.work'));
  await expect(setLaneModel({ key: 'devin.work', model: null }, { runsDir: dir }))
    .rejects.toMatchObject({ code: 'key-missing', status: 422 });
});

it('dry run writes nothing but still reports the resolved outcome', async () => {
  const before = await read();
  const change = await setLaneModel({ key: 'devin.work', model: 'fake-lightning-2', dryRun: true }, { runsDir: dir, now });
  expect(change.applied).toBe(false);
  expect(change.resolved.find(r => r.tier === 'work')).toEqual({ tier: 'work', model: 'fake-lightning-2', via: 'devin.work' });
  expect(await read()).toBe(before);
  await expect(readFile(join(dir, 'queue', 'lane-models.log'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects bad keys and bad model ids', async () => {
  const before = await read();
  for (const key of ['effort.devin.work', 'Devin', 'devin.w3rk extra', 'a.b.c']) {
    await expect(setLaneModel({ key, model: 'fake-x' }, { runsDir: dir }), key)
      .rejects.toMatchObject({ code: 'key-shape', status: 422 });
  }
  for (const model of ['swe 2', 'has space', 'tab\there', 'x'.repeat(65), '']) {
    await expect(setLaneModel({ key: 'devin.work', model }, { runsDir: dir }), model)
      .rejects.toMatchObject({ code: 'model-shape', status: 422 });
  }
  await expect(setLaneModel({ key: 'devin.work', model: 'fake-devin-work' }, { runsDir: dir }))
    .rejects.toMatchObject({ code: 'no-change', status: 422 });
  expect(await read()).toBe(before);
});

it('reports missing, non-object and symlinked models.json without touching it', async () => {
  await rm(modelsPath);
  await expect(setLaneModel({ key: 'devin.work', model: 'fake-x' }, { runsDir: dir }))
    .rejects.toMatchObject({ code: 'models-missing', status: 503 });
  await writeFile(modelsPath, '[1,2,3]');
  await expect(setLaneModel({ key: 'devin.work', model: 'fake-x' }, { runsDir: dir }))
    .rejects.toMatchObject({ code: 'models-invalid', status: 503 });
  await writeFile(modelsPath, '{ not json');
  await expect(setLaneModel({ key: 'devin.work', model: 'fake-x' }, { runsDir: dir }))
    .rejects.toMatchObject({ code: 'models-invalid' });
  await rm(modelsPath);
  const outside = join(dir, 'outside.json');
  await writeFile(outside, JSON.stringify(MODELS));
  await symlink(outside, modelsPath);
  await expect(setLaneModel({ key: 'devin.work', model: 'fake-x' }, { runsDir: dir }))
    .rejects.toMatchObject({ code: 'models-invalid' });
});

it('writes exactly one audit row per applied change and none for dry runs', async () => {
  const logPath = join(dir, 'queue', 'lane-models.log');
  await setLaneModel({ key: 'devin.work', model: 'fake-lightning-2', reason: 'first' }, { runsDir: dir, now, changedBy: 'tester' });
  await setLaneModel({ key: 'devin', model: 'fake-lightning-2', reason: 'second' }, { runsDir: dir, now });
  await setLaneModel({ key: 'devin.fast', model: 'fake-y', dryRun: true }, { runsDir: dir, now });
  const lines = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);
  expect(lines).toEqual([
    `${iso}\tdevin.work\tfake-devin-work\tfake-lightning-2\ttester\tfirst`,
    `${iso}\tdevin\tfake-devin-default\tfake-lightning-2\tphm fleet lane-model-set\tsecond`,
  ]);
});

it('strips control characters and caps the reason in the audit row', async () => {
  const logPath = join(dir, 'queue', 'lane-models.log');
  await setLaneModel({ key: 'devin.work', model: 'fake-z', reason: `two\ttabs\nand${'x'.repeat(300)}` }, { runsDir: dir, now });
  const line = (await readFile(logPath, 'utf8')).trim();
  const cols = line.split('\t');
  expect(cols).toHaveLength(6);
  expect(cols[2]).toBe('fake-devin-work');
  expect(cols[3]).toBe('fake-z');
  expect(cols[5]).toBe(`twotabsand${'x'.repeat(190)}`);
  expect(cols[5]).toHaveLength(200);
});

it('honours --models-style modelsPath overrides and creates queue beside it', async () => {
  const other = join(dir, 'elsewhere', 'models.json');
  await mkdir(join(dir, 'elsewhere'));
  await writeFile(other, JSON.stringify({ devin: 'fake-a', 'effort.devin.mid': 'high' }));
  const change = await setLaneModel({ key: 'devin', model: 'fake-b' }, { modelsPath: other, runsDir: join(dir, 'unused'), now });
  expect(change.applied).toBe(true);
  const log = await readFile(join(dir, 'elsewhere', 'queue', 'lane-models.log'), 'utf8');
  expect(log).toBe(`${iso}\tdevin\tfake-a\tfake-b\tphm fleet lane-model-set\t\n`);
  await expect(readFile(join(dir, 'unused', 'queue', 'lane-models.log'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('throws LaneModelWriteError instances', async () => {
  await expect(setLaneModel({ key: 'Devin', model: 'x' }, { runsDir: dir }))
    .rejects.toBeInstanceOf(LaneModelWriteError);
});
