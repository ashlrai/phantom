import { mkdtemp, mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { foldRouterOutcomes } from '../src/core/router/outcomes.js';
import { applyRouterWeights, proposeRouterWeights, readRouterWeights } from '../src/core/router/tune.js';
import { cmdRoute } from '../src/cli/route.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const outcomes = (n: number, merged: boolean | null) => foldRouterOutcomes(Array.from({ length: n }, (_, i) => JSON.stringify({ job: `job${i}`, lane: 'opaque', work_class: 'code', merged })).join('\n'));

it('refuses 19 known samples, accepts 20, bounds shifts both ways and excludes unknowns', () => {
  expect(proposeRouterWeights(outcomes(19, true))[0]).toMatchObject({ refused: true, reason: 'insufficient-evidence', weight: 0.5, evidence_n: 19 });
  expect(proposeRouterWeights(outcomes(20, true))[0]).toMatchObject({ refused: false, weight: 0.6, evidence_n: 20 });
  expect(proposeRouterWeights(outcomes(20, false))[0]).toMatchObject({ weight: 0.4 });
  expect(proposeRouterWeights(outcomes(20, null))[0]).toMatchObject({ refused: true, weight: 0.5, evidence_n: 0 });
  expect(proposeRouterWeights([])).toEqual([]);
  for (const maxShift of [0, -1, 2, NaN]) expect(() => proposeRouterWeights([], [], { maxShift })).toThrow();
  expect(() => proposeRouterWeights([], [], { minSamples: 0 })).toThrow();
});

it('starts from persisted weights and preserves groups with refused or absent evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-weights-'));
  const current = [{ schema: 'router.weights.v1' as const, lane: 'opaque', work_class: 'code', weight: 0.9, evidence_n: 20, updated_at: new Date().toISOString() }];
  try {
    expect(await readRouterWeights(root)).toEqual([]);
    const proposals = proposeRouterWeights(outcomes(20, false), current);
    expect(proposals[0].weight).toBe(0.8);
    await applyRouterWeights(proposals, current, root);
    expect((await readRouterWeights(root))[0].weight).toBe(0.8);
    await applyRouterWeights(proposeRouterWeights(outcomes(19, true), current), current, root);
    expect(await readRouterWeights(root)).toEqual(current);
    await applyRouterWeights([], current, root);
    expect(await readRouterWeights(root)).toEqual(current);
    await writeFile(join(root, 'router/weights.json'), JSON.stringify([{ ...current[0], weight: 2 }]));
    expect(await readRouterWeights(root)).toEqual([]);
    await writeFile(join(root, 'router/weights.json'), 'malformed');
    expect(await readRouterWeights(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('CLI dry-run writes nothing; apply writes only private local weights', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-tune-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, 'home')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await mkdir(join(root, 'runs/metrics'), { recursive: true });
    await writeFile(join(root, 'runs/metrics/jobs.jsonl'), outcomes(20, true).map(r => JSON.stringify(r)).join('\n'));
    expect(await cmdRoute(['tune', '--json'])).toBe(0);
    expect(await readdir(root)).toEqual(['runs']);
    expect(await cmdRoute(['tune', '--apply', '--json'])).toBe(0);
    expect(await readdir(join(root, 'home'))).toEqual(['router']);
    expect(await readdir(join(root, 'home/router'))).toEqual(['weights.json']);
    expect((await stat(join(root, 'home/router/weights.json'))).mode & 0o777).toBe(0o600);
    expect((await readRouterWeights())[0]).toMatchObject({ weight: 0.6 });
    expect(await cmdRoute(['tune', '--max-shift', '0', '--json'])).toBe(2);
    expect(await cmdRoute(['tune', '--apply', '--dry-run'])).toBe(2);
    expect(await cmdRoute(['outcomes', '--lane', 'opaque', '--json'])).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
