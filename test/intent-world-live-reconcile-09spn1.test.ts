import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearWorldCacheForTests, readWorldModel, worldCachePath } from '../src/core/world/read.js';
import { INTENT_LEDGER_SCHEMA } from '../src/core/intent/schema.js';
import type { AgentRoster } from '../src/core/fleet/agent-roster.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const DAY = 86_400_000;
const FAKE_TITLE = 'fake directive title for tests only';

let runs: string;
let saved: string | undefined;

function item(id: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date(NOW - 1000).toISOString();
  return {
    id, title: `${FAKE_TITLE} ${id}`, source: 'fake-source', owner: 'fake-owner', rq: ['RQ-FAKE-1'], prs: [], status,
    evidence: [], provenance: [], partial: false, closureProposal: null,
    lastTouchedAt: at, staleAfterMs: DAY, createdAt: at, updatedAt: at, ...over,
  };
}

function writeIntentFile(body: string): void {
  mkdirSync(join(runs, 'intent'), { recursive: true });
  writeFileSync(join(runs, 'intent', 'ledger.json'), body);
}

function writeItems(items: unknown[]): void {
  writeIntentFile(JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items }));
}

function roster(): AgentRoster {
  const observedAt = new Date(NOW).toISOString();
  return {
    schema: 'agent-roster.v1', observedAt, latencyMs: 1,
    sources: [{ source: 'claude', ok: true, availability: 'known', sessions: [], error: null, observedAt, truncated: false }],
    sessions: [], claims: { source: 'missing', items: [] },
  };
}

// loadRoster/readClaims keep the build off the machine; they also make the read uncacheable.
const seams = { loadRoster: async () => roster(), readClaims: () => ({ source: 'available' as const, claims: [] }) };

beforeEach(() => {
  saved = process.env['ASHLR_RUNS_DIR'];
  runs = mkdtempSync(join(tmpdir(), 'intent-world-'));
  process.env['ASHLR_RUNS_DIR'] = runs;
  clearWorldCacheForTests();
});

afterEach(() => {
  if (saved === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = saved;
  rmSync(runs, { recursive: true, force: true });
  clearWorldCacheForTests();
});

describe('world model intents', () => {
  it('counts a populated ledger without promoting merged to shipped', async () => {
    writeItems([
      item('a-merged', 'merged'), item('b-shipped', 'shipped'), item('c-verified', 'verified'),
      item('d-open', 'queued', { rq: [], partial: true }),
    ]);
    const world = await readWorldModel({ nowMs: NOW, ...seams });
    const v = (f: { value: number | null }) => f.value;
    expect(world.intents.items).toMatchObject({ value: 4, freshness: 'fresh', source: INTENT_LEDGER_SCHEMA });
    expect([world.intents.tracked, world.intents.merged, world.intents.shipped, world.intents.verified, world.intents.stale, world.intents.partial].map(v))
      .toEqual([3, 1, 1, 1, 0, 1]);
    expect(world.growth.mergesPerHour).toBeDefined();
    expect(world.queue.ready.freshness).toBe('unknown');
    expect(world.claims.live.freshness).toBeDefined();
  });

  it('reports an empty readable ledger as observed zeros', async () => {
    writeItems([]);
    const world = await readWorldModel({ nowMs: NOW, ...seams });
    for (const field of Object.values(world.intents)) expect(field).toMatchObject({ value: 0, freshness: 'fresh' });
    expect(world.blindSpots.filter((s) => s.path.startsWith('intents.'))).toEqual([]);
  });

  it.each([
    ['missing', () => undefined],
    ['malformed JSON', () => writeIntentFile('{ not json')],
    ['wrong schema', () => writeIntentFile(JSON.stringify({ schema: 'something.else/v9', items: [] }))],
    ['symlink', () => {
      mkdirSync(join(runs, 'intent'), { recursive: true });
      writeFileSync(join(runs, 'target.json'), JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items: [] }));
      symlinkSync(join(runs, 'target.json'), join(runs, 'intent', 'ledger.json'));
    }],
  ])('keeps a %s ledger unknown and unrelated fields intact', async (_name, setup) => {
    setup();
    const world = await readWorldModel({ nowMs: NOW, ...seams });
    for (const field of Object.values(world.intents)) {
      expect(field).toMatchObject({ value: null, freshness: 'unknown' });
    }
    expect(world.intents.items.value).not.toBe(0);
    expect(world.roster.sessions.value).toBe(0);
    expect(world.blindSpots.some((s) => s.path === 'intents.items')).toBe(true);
    expect(JSON.stringify(world)).not.toContain('not json');
  });

  it('flags stale directives with opaque ids and an intent-sweep hint, not terminal ones', async () => {
    const old = new Date(NOW - 3 * DAY).toISOString();
    writeItems([
      item('stale-one', 'in-progress', { lastTouchedAt: old }),
      item('stale-two', 'merged', { lastTouchedAt: old }),
      item('old-shipped', 'shipped', { lastTouchedAt: old }),
      item('old-closed', 'closed', { lastTouchedAt: old }),
    ]);
    const world = await readWorldModel({ nowMs: NOW, ...seams });
    expect(world.intents.stale.value).toBe(2);
    expect(world.intents.shipped.value).toBe(1);
    expect(world.intents.merged.value).toBe(1);
    const spots = world.blindSpots.filter((s) => s.path.startsWith('intents.stale.'));
    expect(spots).toHaveLength(2);
    for (const spot of spots) {
      expect(spot.freshness).toBe('stale');
      expect(spot.need).toContain('phm fleet intent-sweep');
      expect(spot.path).toMatch(/^intents\.stale\.i-[0-9a-f]{10}$/);
    }
    const text = JSON.stringify(world);
    expect(text).not.toContain(FAKE_TITLE);
    expect(text).not.toContain('stale-one');
    expect(world.views.observe.coverage.unknownFields.some((f) => f.path.startsWith('intents.stale.'))).toBe(true);
  });

  it('bounds stale blind spots while the count stays exact', async () => {
    const old = new Date(NOW - 3 * DAY).toISOString();
    writeItems(Array.from({ length: 30 }, (_, n) => item(`s-${n}`, 'queued', { lastTouchedAt: old })));
    const world = await readWorldModel({ nowMs: NOW, ...seams });
    expect(world.intents.stale.value).toBe(30);
    expect(world.blindSpots.filter((s) => s.path.startsWith('intents.stale.'))).toHaveLength(20);
  });

  it('rebuilds from a pre-integration cached shape and then serves the warm cache', async () => {
    writeItems([item('a-merged', 'merged')]);
    const first = await readWorldModel({ nowMs: NOW });
    expect(first.cache.hit).toBe(false);
    expect(first.intents.items.value).toBe(1);

    // Strip intents from the cached file as an older build would have written it.
    const { readFileSync, writeFileSync: write, utimesSync } = await import('node:fs');
    const path = worldCachePath();
    expect(path.startsWith(homedir())).toBe(true);
    const old = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete old['intents'];
    write(path, JSON.stringify(old));
    utimesSync(path, new Date(NOW), new Date(NOW));
    clearWorldCacheForTests();
    writeItems([item('a-merged', 'merged'), item('b-merged', 'merged')]);

    const rebuilt = await readWorldModel({ nowMs: NOW + 1000 });
    expect(rebuilt.cache.hit).toBe(false);
    expect(rebuilt.intents.items.value).toBe(2);
    expect(rebuilt.growth.mergesPerHour).toBeDefined();

    writeItems([]);
    const warm = await readWorldModel({ nowMs: NOW + 2000 });
    expect(warm.cache.hit).toBe(true);
    expect(warm.intents.items.value).toBe(2);
    utimesSync(path, new Date(NOW + 2000), new Date(NOW + 2000));
    clearWorldCacheForTests();
    const disk = await readWorldModel({ nowMs: NOW + 3000 });
    expect(disk.cache.hit).toBe(true);
    expect(disk.intents.items.value).toBe(2);
  });
});
