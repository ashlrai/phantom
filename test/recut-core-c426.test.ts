import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTENT_LEDGER_SCHEMA, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { clearWorldCacheForTests, readWorldModel, worldCachePath, type CachedWorld } from '../src/core/world/read.js';

const DAY = 24 * 60 * 60 * 1000;
const SECRET_TITLE = 'PRIVATE-DIRECTIVE-TITLE-DO-NOT-EXPORT';

/**
 * Recut of RQ-PHX-RECONCILEINTENTWORLD09SPK1 (#4395) for the C426 pass: the
 * intent-ledger counts in the world model exercised through the public
 * `readWorldModel` entry — including the disk-cache guard that rebuilds
 * snapshots written before intents joined the model.
 */

const saved: Record<string, string | undefined> = {};
let dir: string;

function item(id: string, status: IntentStatus, ageMs: number, extra: Partial<IntentItem> = {}): IntentItem {
  const touched = new Date(Date.now() - ageMs).toISOString();
  return {
    id, title: `${SECRET_TITLE} ${id}`, source: 'test', owner: 'test', rq: [], prs: [], status,
    evidence: [], provenance: [], partial: false, closureProposal: null,
    lastTouchedAt: touched, staleAfterMs: DAY, createdAt: touched, updatedAt: touched, ...extra,
  };
}

function writeLedger(items: IntentItem[]): string {
  const folder = join(dir, 'runs', 'intent');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'ledger.json');
  writeFileSync(path, JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items }));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recut-core-c426-'));
  for (const key of ['ASHLR_RUNS_DIR', 'ASHLR_WORLD_EXPORT']) saved[key] = process.env[key];
  process.env['ASHLR_RUNS_DIR'] = join(dir, 'runs');
  process.env['ASHLR_WORLD_EXPORT'] = join(dir, 'export', 'world.json');
  clearWorldCacheForTests();
  rmSync(worldCachePath(), { force: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearWorldCacheForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('readWorldModel intent fields (recut C426)', () => {
  it('serves intent-ledger counts with the ledger source through the public entry', async () => {
    writeLedger([
      item('open-new', 'queued', 0, { rq: ['RQ-X-1'] }),
      item('merged-old', 'merged', 30 * DAY),
      item('shipped-old', 'shipped', 30 * DAY),
    ]);
    const model = await readWorldModel({ nowMs: Date.now() });
    expect(model.intents.items).toMatchObject({ value: 3, freshness: 'fresh', source: 'ashlr.intent-ledger/v1' });
    expect(model.intents.tracked.value).toBe(1);
    expect(model.intents.merged.value).toBe(1);
    expect(model.intents.shipped.value).toBe(1);
    expect(model.intents.stale.value).toBe(1);
    expect(model.blindSpots.filter((spot) => spot.path.startsWith('intents.stale.')))
      .toHaveLength(1);
    expect(JSON.stringify(model)).not.toContain(SECRET_TITLE);
  });

  it('rebuilds a disk snapshot written before intents joined the model', async () => {
    writeLedger([item('a', 'queued', 0)]);
    const first = await readWorldModel({ nowMs: Date.now() });
    expect(first.intents.items.value).toBe(1);
    // Forge a pre-intents cached snapshot: valid everywhere except the intents block.
    const { intents: _dropped, ...preIntents } = first;
    const cacheFile = worldCachePath();
    mkdirSync(join(cacheFile, '..'), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ ...preIntents, schema: 'ashlr.world-model/v1' } satisfies Partial<CachedWorld>));
    clearWorldCacheForTests();
    const rebuilt = await readWorldModel({ nowMs: Date.now() });
    expect(rebuilt.cache.hit).toBe(false);
    expect(rebuilt.intents.items.value).toBe(1);
    expect(rebuilt.intents.items.source).toBe('ashlr.intent-ledger/v1');
  });

  it('serves the warm memory cache inside the TTL without rereading the ledger', async () => {
    writeLedger([item('a', 'queued', 0)]);
    const first = await readWorldModel({ nowMs: Date.now() });
    expect(first.cache.hit).toBe(false);
    const second = await readWorldModel({ nowMs: Date.now() });
    expect(second.cache.hit).toBe(true);
    expect(second.intents.items.value).toBe(1);
  });
});
