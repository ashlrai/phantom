import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTENT_LEDGER_SCHEMA, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { summarize, type IntentSummary } from '../src/core/intent/summary.js';
import { projectWorldModel, type WorldProjectInput } from '../src/core/world/project.js';
import { buildWorldModel, clearWorldCacheForTests } from '../src/core/world/read.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
/** Stubs the roster and usage probes so the builder never touches real providers. */
const offline = { nowMs: NOW, loadRoster: async () => undefined, loadSensors: async () => undefined };
const SECRET_TITLE = 'PRIVATE-DIRECTIVE-TITLE-DO-NOT-EXPORT';

function item(id: string, status: IntentStatus, ageMs: number, extra: Partial<IntentItem> = {}): IntentItem {
  const touched = new Date(NOW - ageMs).toISOString();
  return {
    id, title: `${SECRET_TITLE} ${id}`, source: 'test', owner: 'test', rq: [], prs: [], status,
    evidence: [], provenance: [], partial: false, closureProposal: null,
    lastTouchedAt: touched, staleAfterMs: DAY, createdAt: touched, updatedAt: touched, ...extra,
  };
}

function ledger(items: IntentItem[]): { schema: typeof INTENT_LEDGER_SCHEMA; items: IntentItem[] } {
  return { schema: INTENT_LEDGER_SCHEMA, items };
}

function base(intents: IntentSummary | null | undefined): WorldProjectInput {
  return {
    nowMs: NOW, sensors: null, roster: null, claims: null, busReadable: null, queue: null, ci: null,
    updatePhase: null, bottlenecks: null, bottlenecksObservedAt: null, stepsRemaining: null,
    stepsObservedAt: null, outcomes: null, intents,
  };
}

describe('world model intent projection (pure)', () => {
  it('projects counts without inferring shipped from merged', () => {
    const summary = summarize(ledger([
      item('a', 'merged', 0, { rq: ['RQ-A-1'] }),
      item('b', 'merged', 0),
      item('c', 'verified', 0, { partial: true }),
    ]), NOW);
    const { intents } = projectWorldModel(base(summary));
    expect(intents.items).toMatchObject({ value: 3, freshness: 'fresh', source: 'ashlr.intent-ledger/v1' });
    expect(intents.tracked.value).toBe(1);
    expect(intents.merged.value).toBe(2);
    expect(intents.shipped.value).toBe(0);
    expect(intents.verified.value).toBe(1);
    expect(intents.partial.value).toBe(1);
    expect(intents.stale.value).toBe(0);
  });

  it('keeps absent input and a not-present summary unknown, and an observed empty ledger at zero', () => {
    for (const input of [undefined, null, summarize(ledger([]), NOW, false)]) {
      const { intents, blindSpots } = projectWorldModel(base(input));
      for (const field of Object.values(intents)) expect(field).toMatchObject({ value: null, freshness: 'unknown' });
      expect(blindSpots.some((spot) => spot.path === 'intents.items')).toBe(true);
    }
    const empty = projectWorldModel(base(summarize(ledger([]), NOW)));
    for (const field of Object.values(empty.intents)) expect(field).toMatchObject({ value: 0, freshness: 'fresh' });
    expect(empty.blindSpots.some((spot) => spot.path.startsWith('intents.'))).toBe(false);
  });

  it('emits stable, deduplicated, sorted stale blind spots with no titles', () => {
    const summary = summarize(ledger([
      item('z.1', 'queued', 3 * DAY), item('a-1', 'queued', 3 * DAY), item('a.1', 'queued', 3 * DAY),
      item('done', 'shipped', 30 * DAY), item('fresh', 'queued', 0),
    ]), NOW);
    const first = projectWorldModel(base(summary));
    const second = projectWorldModel(base(summary));
    const stale = first.blindSpots.filter((spot) => spot.path.startsWith('intents.stale.'));
    expect(stale.map((spot) => spot.id)).toEqual(['intents-stale-a-1', 'intents-stale-z-1']);
    expect(stale.every((spot) => spot.freshness === 'stale')).toBe(true);
    expect(stale[0]!.need).toContain('ashlr fleet intent-sweep');
    expect(stale[0]!.need).not.toMatch(/phm intent/);
    expect(first.blindSpots).toEqual(second.blindSpots);
    const ids = first.blindSpots.map((spot) => spot.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(first)).not.toContain(SECRET_TITLE);
  });
});

describe('world model intent projection (real builder)', () => {
  const saved: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intent-world-09spk1-'));
    for (const key of ['ASHLR_RUNS_DIR', 'ASHLR_WORLD_EXPORT']) saved[key] = process.env[key];
    process.env['ASHLR_RUNS_DIR'] = join(dir, 'runs');
    process.env['ASHLR_WORLD_EXPORT'] = join(dir, 'export', 'world.json');
    clearWorldCacheForTests();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearWorldCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRaw(body: string): string {
    const folder = join(dir, 'runs', 'intent');
    mkdirSync(folder, { recursive: true });
    const path = join(folder, 'ledger.json');
    writeFileSync(path, body);
    return path;
  }

  it('reads a populated ledger, flags stale records only, and never writes it', async () => {
    const path = writeRaw(JSON.stringify(ledger([
      item('open-old', 'queued', 3 * DAY, { rq: ['RQ-X-1'] }),
      item('merged-old', 'merged', 3 * DAY),
      item('shipped-old', 'shipped', 30 * DAY),
      item('closed-old', 'closed', 30 * DAY),
      item('open-new', 'queued', 0),
    ])));
    const before = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const model = await buildWorldModel(offline);
    expect(model.intents.items.value).toBe(5);
    expect(model.intents.tracked.value).toBe(1);
    expect(model.intents.merged.value).toBe(1);
    expect(model.intents.shipped.value).toBe(1);
    expect(model.intents.stale.value).toBe(2);
    expect(model.blindSpots.filter((spot) => spot.path.startsWith('intents.stale.')).map((spot) => spot.id))
      .toEqual(['intents-stale-merged-old', 'intents-stale-open-old']);
    expect(model.views.observe.coverage.unknownFields.map((field) => field.id)).toContain('intents-stale-open-old');
    const exported = readFileSync(join(dir, 'export', 'world.json'), 'utf8');
    expect(exported).not.toContain(SECRET_TITLE);
    expect(JSON.stringify(model)).not.toContain(SECRET_TITLE);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });

  it('reports an observed empty ledger as zero', async () => {
    writeRaw(JSON.stringify(ledger([])));
    const model = await buildWorldModel(offline);
    expect(model.intents.items).toMatchObject({ value: 0, freshness: 'fresh' });
    expect(model.intents.stale.value).toBe(0);
  });

  it('keeps an absent ledger unknown and does not create one', async () => {
    const model = await buildWorldModel(offline);
    expect(model.intents.items).toMatchObject({ value: null, freshness: 'unknown' });
    expect(model.blindSpots.some((spot) => spot.id === 'intents-items')).toBe(true);
    expect(() => statSync(join(dir, 'runs', 'intent', 'ledger.json'))).toThrow();
  });

  it('keeps a malformed ledger unknown while other facts survive', async () => {
    writeRaw('{ not json');
    const model = await buildWorldModel(offline);
    expect(model.intents.items).toMatchObject({ value: null, freshness: 'unknown' });
    writeRaw(JSON.stringify({ schema: 'wrong', items: [] }));
    const wrong = await buildWorldModel(offline);
    expect(wrong.intents.stale.value).toBeNull();
    expect(wrong.growth.mergesPerHour).toBeDefined();
    expect(wrong.claims.live).toBeDefined();
  });

  it('preserves growth and claim facts next to the intent fields', async () => {
    writeRaw(JSON.stringify(ledger([item('a', 'queued', 0)])));
    const model = await buildWorldModel(offline);
    expect(Object.keys(model.growth).sort()).toEqual([
      'bottleneckTrends', 'costPerMergedPr', 'laneUtilization', 'mergesPerHour', 'pullsMerged', 'pullsOpened', 'releases',
    ]);
    expect(model.claims.live.source).toBe('claim-store');
    expect(model.intents.items.value).toBe(1);
  });
});
