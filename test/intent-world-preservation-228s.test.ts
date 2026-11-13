import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { writeLedger } from '../src/core/intent/store.js';
import { clearWorldCacheForTests, readWorldModel, worldCachePath } from '../src/core/world/read.js';

vi.mock('../src/core/observe/read.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/observe/read.js')>();
  return {
    ...original,
    loadMergedRoster: vi.fn(async () => undefined),
    loadSensorReport: vi.fn(async () => undefined),
  };
});
import { loadMergedRoster, loadSensorReport } from '../src/core/observe/read.js';

let root: string;
let savedHome: string | undefined;
let savedRuns: string | undefined;
let savedAshlr: string | undefined;
let savedExport: string | undefined;
const now = Date.now();

function item(id: string, status: IntentStatus): IntentItem {
  const date = new Date(now - 100_000).toISOString();
  return {
    id,
    title: 'private directive',
    source: '/private/source',
    owner: 'owner',
    rq: ['RQ-TEST-1'],
    prs: [],
    status,
    evidence: [],
    provenance: [],
    partial: false,
    closureProposal: null,
    lastTouchedAt: date,
    staleAfterMs: 1000,
    createdAt: date,
    updatedAt: date,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'world-intent-preservation-'));
  savedHome = process.env['HOME'];
  savedRuns = process.env['ASHLR_RUNS_DIR'];
  savedAshlr = process.env['ASHLR_HOME'];
  savedExport = process.env['ASHLR_WORLD_EXPORT'];
  process.env['HOME'] = root;
  process.env['ASHLR_RUNS_DIR'] = join(root, 'runs');
  process.env['ASHLR_HOME'] = join(root, 'ashlr');
  process.env['ASHLR_WORLD_EXPORT'] = join(root, 'export.json');
  clearWorldCacheForTests();
  vi.mocked(loadMergedRoster).mockClear();
  vi.mocked(loadSensorReport).mockClear();
});

afterEach(async () => {
  for (const [key, value] of Object.entries({
    HOME: savedHome,
    ASHLR_RUNS_DIR: savedRuns,
    ASHLR_HOME: savedAshlr,
    ASHLR_WORLD_EXPORT: savedExport,
  })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  clearWorldCacheForTests();
  await rm(root, { recursive: true, force: true });
});

describe('intent observations in the real world reader', () => {
  it('projects counts and bounded stale blind spots without private text', async () => {
    await writeLedger({
      ...emptyLedger(),
      items: [
        item('active', 'merged'),
        ...(['shipped', 'verified', 'superseded', 'closed'] as const).map((status) => item(status, status)),
      ],
    });
    const model = await readWorldModel({ nowMs: now });
    expect(Object.fromEntries(Object.entries(model.intents).map(([key, field]) => [key, field.value]))).toEqual({
      items: 5,
      tracked: 5,
      merged: 1,
      shipped: 1,
      verified: 1,
      stale: 1,
      partial: 0,
    });
    const staleSpots = model.blindSpots.filter((spot) => spot.path.startsWith('intents.stale.'));
    expect(staleSpots).toHaveLength(1);
    expect(staleSpots[0]).toMatchObject({ freshness: 'stale', need: expect.any(String) });
    expect(staleSpots[0]?.path).toMatch(/^intents\.stale\.i-[0-9a-f]{10}$/);
    const exported = await readFile(join(root, 'export.json'), 'utf8');
    expect(exported).not.toContain('private directive');
    expect(exported).not.toContain('/private/source');
    expect(exported).not.toContain('intents.stale.active');
  });

  it('treats readable empty as zero and missing or corrupt as unknown', async () => {
    const missing = await readWorldModel({ nowMs: now, force: true });
    expect(missing.intents.items).toMatchObject({ value: null, freshness: 'unknown' });

    await writeLedger(emptyLedger());
    const empty = await readWorldModel({ nowMs: now, force: true });
    expect(empty.intents.items).toMatchObject({ value: 0, freshness: 'fresh' });

    await writeFile(join(root, 'runs', 'intent', 'ledger.json'), '{');
    const corrupt = await readWorldModel({ nowMs: now, force: true });
    expect(corrupt.intents.items).toMatchObject({ value: null, freshness: 'unknown' });
    expect(corrupt.blindSpots.some((spot) => spot.path === 'intents.items')).toBe(true);

    await rm(join(root, 'runs', 'intent', 'ledger.json'));
    await symlink(join(root, 'missing'), join(root, 'runs', 'intent', 'ledger.json'));
    const unavailable = await readWorldModel({ nowMs: now, force: true });
    expect(unavailable.intents.items).toMatchObject({ value: null, freshness: 'unknown' });
  });

  it('bounds stale identifiers while retaining the full count', async () => {
    await writeLedger({
      ...emptyLedger(),
      items: Array.from({ length: 55 }, (_, index) => item(`id${index}`, 'queued')),
    });
    const model = await readWorldModel({ nowMs: now, force: true });
    expect(model.intents.stale.value).toBe(55);
    expect(model.blindSpots.filter((spot) => spot.path.startsWith('intents.stale.'))).toHaveLength(50);
  });

  it('reuses a warm cache without re-probing or rereading the ledger', async () => {
    await writeLedger(emptyLedger());
    const first = await readWorldModel({ nowMs: now });
    await writeFile(join(root, 'runs', 'intent', 'ledger.json'), '{');
    const second = await readWorldModel({ nowMs: now + 1 });
    expect(first.cache.hit).toBe(false);
    expect(second.cache.hit).toBe(true);
    expect(second.intents.items.value).toBe(0);
    expect(loadMergedRoster).toHaveBeenCalledTimes(1);
    expect(loadSensorReport).toHaveBeenCalledTimes(1);
  });

  it('rejects an older disk cache lacking intent fields', async () => {
    await writeLedger(emptyLedger());
    const first = await readWorldModel({ nowMs: now });
    const old = JSON.parse(JSON.stringify(first)) as Record<string, unknown>;
    delete old['intents'];
    await mkdir(join(worldCachePath(), '..'), { recursive: true });
    await writeFile(worldCachePath(), JSON.stringify(old));
    clearWorldCacheForTests();

    const next = await readWorldModel({ nowMs: Date.now() });
    expect(next.cache.hit).toBe(false);
    expect(next.intents.items.value).toBe(0);
    expect(loadMergedRoster).toHaveBeenCalledTimes(2);
    expect(loadSensorReport).toHaveBeenCalledTimes(2);
  });
});
