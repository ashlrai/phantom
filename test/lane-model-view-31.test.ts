/** lane-model-view-31.test.ts — fixtures for `phm fleet lane-models`: models.json
 * resolution, newest jobs.jsonl launch per lane, mismatch flag. Real temp dirs. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLaneModelSnapshot, parseModelsJson, resolveLaneModel } from '../src/core/fleet/lane-models.js';
import { cmdFleetLaneModels, formatLaneModels } from '../src/cli/fleet-lane-models.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lane-models-'));
  await mkdir(join(dir, 'metrics'));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const MODELS = {
  codex: 'gpt-5.2-codex', 'codex.frontier': 'gpt-5.4-codex',
  'codex-cmp': 'gpt-5.3-codex', 'codex-cmp.work': 'gpt-5.3-codex-work',
  claude: 'claude-opus-4-8', 'devin.work': 'devin-max', '': 'bad-key', 'claude.bad tier': 'bad-tier',
};
const launch = (lane: string, model: string, tier?: string) =>
  JSON.stringify({ event: 'launch', job: `RQ-${lane}-1`, lane, model, ...(tier ? { tier } : {}), ts: '2026-11-01T10:00:00Z' });
async function seed(models: unknown, jobs: string[] = []): Promise<void> {
  await writeFile(join(dir, 'models.json'), JSON.stringify(models));
  await writeFile(join(dir, 'metrics', 'jobs.jsonl'), jobs.map(j => j + '\n').join(''));
}

it('resolves lane.tier → lane → family.tier → family and drops invalid entries', () => {
  const { map, dropped } = parseModelsJson(JSON.stringify({ ...MODELS, 'a.t': '', 'a.b.c': 'm2' }));
  expect(dropped).toBe(4); // '' key, 'claude.bad tier', empty 'a.t', over-deep 'a.b.c'
  expect(resolveLaneModel(map, 'codex-cmp', 'work')).toEqual({ model: 'gpt-5.3-codex-work', via: 'codex-cmp.work' });
  expect(resolveLaneModel(map, 'codex-cmp', 'mid')).toEqual({ model: 'gpt-5.3-codex', via: 'codex-cmp' });
  expect(resolveLaneModel(map, 'codex-local', 'frontier')).toEqual({ model: 'gpt-5.4-codex', via: 'codex.frontier' });
  expect(resolveLaneModel(map, 'codex-local', 'low')).toEqual({ model: 'gpt-5.2-codex', via: 'codex' });
  expect(resolveLaneModel(map, 'claude', 'frontier')).toEqual({ model: 'claude-opus-4-8', via: 'claude' });
  expect(resolveLaneModel(map, 'devin', 'work')).toEqual({ model: 'devin-max', via: 'devin.work' });
  expect([resolveLaneModel(map, 'devin', 'mid'), resolveLaneModel(map, 'hermes', 'frontier')]).toEqual([null, null]);
});

it('flags a lane whose newest launch ran another model, and clears when it matches', async () => {
  await seed(MODELS, [
    launch('codex-local', 'gpt-5.3-codex', 'frontier'), // stale: map resolves gpt-5.4-codex
    launch('claude', 'claude-opus-4-8', 'work'),
    launch('devin', 'devin-max'), // untiered: inside the resolved set
    launch('hermes', 'other-model'), // untiered: lane unmapped entirely
    JSON.stringify({ event: 'finish', lane: 'devin', ts: '2026-11-01T11:00:00Z' }), // not a launch
    'not json',
  ]);
  const files = [join(dir, 'models.json'), join(dir, 'metrics', 'jobs.jsonl')];
  const before = await Promise.all(files.map(f => readFile(f, 'utf8')));
  const snap = await getLaneModelSnapshot({ runsDir: dir });
  const codexLocal = snap.lanes.find(l => l.lane === 'codex-local')!;
  expect(snap.schema).toBe('fleet.lane-models.v1');
  expect(codexLocal.family).toBe('codex');
  expect(codexLocal.mismatch).toBe(true);
  expect(codexLocal.lastLaunch).toMatchObject({ model: 'gpt-5.3-codex', tier: 'frontier' });
  expect(codexLocal.tiers.find(t => t.tier === 'frontier')).toMatchObject({ model: 'gpt-5.4-codex', via: 'codex.frontier' });
  expect(snap.lanes.filter(l => l.mismatch).map(l => l.lane).sort()).toEqual(['codex-local', 'hermes']);
  expect(snap.sources).toMatchObject({ models: { state: 'degraded' }, launches: { launches: 4, dropped: 1 } });
  expect(await Promise.all(files.map(f => readFile(f, 'utf8')))).toEqual(before); // read-only proof
  expect(formatLaneModels(snap, Date.parse('2026-11-01T12:00:00Z'))).toContain('MISMATCH');
});
it('degrades each source independently and never throws on missing files', async () => {
  const snap = await getLaneModelSnapshot({ runsDir: dir });
  expect([snap.sources.models.state, snap.sources.launches.state, snap.lanes]).toEqual(['missing', 'missing', []]);
  await writeFile(join(dir, 'models.json'), '{ broken');
  expect((await getLaneModelSnapshot({ runsDir: dir })).sources.models.state).toBe('degraded');
});

it('cli emits --json and a table through --runs-dir, refusing bad options', async () => {
  await seed(MODELS, [launch('codex-local', 'gpt-5.3-codex', 'frontier')]);
  const logs: string[] = [];
  const [log, err] = [console.log, process.stderr.write];
  console.log = (msg?: unknown) => { logs.push(String(msg)); };
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    expect(await cmdFleetLaneModels(['--json', '--runs-dir', dir])).toBe(0);
    expect(JSON.parse(logs.pop()!).lanes.find((l: { lane: string }) => l.lane === 'codex-local').mismatch).toBe(true);
    logs.length = 0;
    expect(await cmdFleetLaneModels(['--runs-dir', dir])).toBe(0);
    expect(logs[0]).toContain('gpt-5.4-codex');
    expect(logs[0]).toContain('MISMATCH');
    expect(await Promise.all([cmdFleetLaneModels(['--bogus']), cmdFleetLaneModels(['--runs-dir', 'relative/path'])])).toEqual([2, 2]);
  } finally { console.log = log; process.stderr.write = err; }
});
