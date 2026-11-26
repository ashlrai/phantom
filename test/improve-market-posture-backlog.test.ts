import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldPostureJournal,
  MARKET_POSTURE_MAX_ITEMS,
  MARKET_POSTURE_WINDOW_HOURS,
  marketPostureBacklogItems,
  POSTURE_EVIDENCE_REASONS,
  POSTURE_MIN_DAYS,
  POSTURE_MIN_ROWS,
  POSTURE_WASTE_REASONS,
  postureCells,
} from '../src/core/improve/market-posture-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are epoch seconds like dispatchd's market_metric writes. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW_S = Math.floor(NOW_MS / 1000);
/** Epoch seconds `msAgo` milliseconds before NOW_MS. */
const sec = (msAgo: number): number => Math.floor((NOW_MS - msAgo) / 1000);

/** One lane entry in the producer's posture-event shape; spec keys are posture/reason/costReason. */
function laneEntry(spec: Record<string, unknown> = {}): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    lane: 'claude',
    posture: typeof spec['posture'] === 'string' ? spec['posture'] : 'balanced',
    posture_reason: typeof spec['reason'] === 'string' ? spec['reason'] : 'spend_down_on_pace',
    projected_unused_pct: 12.5,
    hours_to_reset: 80,
    cost_class: 'included',
  };
  if (typeof spec['costReason'] === 'string') entry['cost_class_reason'] = spec['costReason'];
  return entry;
}

/** One work-market.v1 posture event; lanes defaults to a single healthy claude entry. */
function postureRow(tsSec: number, lanes?: Record<string, unknown>): string {
  return J({
    schema: 'work-market.v1',
    event: 'posture',
    lanes: lanes ?? { claude: laneEntry() },
    ts: tsSec,
  });
}

/** An event whose named lanes carry the given per-lane specs. */
function eventWith(tsSec: number, specs: Record<string, Record<string, unknown>>): string {
  const lanes: Record<string, unknown> = {};
  for (const [lane, spec] of Object.entries(specs)) {
    const entry = laneEntry(spec);
    entry['lane'] = lane;
    lanes[lane] = entry;
  }
  return postureRow(tsSec, lanes);
}

/** n posture events spread across `days` distinct UTC days ending today, each carrying `spec` on `lane`. */
function reasonSeries(lane: string, reason: string, days: number, perDay: number, spec: Record<string, unknown> = {}): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(eventWith(sec(d * DAY + i * HOUR), { [lane]: { reason, ...spec } }));
    }
  }
  return rows;
}

describe('foldPostureJournal', () => {
  it('keeps only in-window work-market.v1 posture events of the producer contract', () => {
    const rows = [
      postureRow(NOW_S),
      postureRow(NOW_S - HOUR / 1000),
      // Wrong schema, wrong event name (spelled out so the prefilter still sees it), bad ts, non-JSON.
      J({ schema: 'other.v9', event: 'posture', lanes: {}, ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'route_decision', lanes: {}, ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'posture', lanes: {}, ts: 'soon' }),
      J({ schema: 'work-market.v1', event: 'posture', lanes: {}, ts: -5 }),
      'not json {"event":"posture"',
      '',
      // Out-of-window and beyond the +300 s skew: skipped as non-evidence, not invalid.
      postureRow(NOW_S - MARKET_POSTURE_WINDOW_HOURS * 3600 - 10),
      postureRow(NOW_S + 600),
      // Route-decision-flavored rows never reach the parse: no '"event":"posture"' substring.
      J({ schema: 'work-market.v1', event: 'route_decision', job: 'j1', lanes: { claude: { posture: 'burn' } }, ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'unfed_capacity', lanes: {}, ts: NOW_S }),
    ].join('\n');
    const fold = foldPostureJournal(rows, NOW_MS, MARKET_POSTURE_WINDOW_HOURS);
    expect(fold.records).toBe(2);
    expect(fold.laneEntries.get('claude')).toBe(2);
    // bad-schema posture, string-ts, negative-ts and the non-JSON line all count
    // as invalid; out-of-window/future rows and the other-event rows are skipped
    // before parsing.
    expect(fold.invalidRows).toBe(4);
  });

  it('skips malformed lane entries without invalidating the event', () => {
    const badLanes: Record<string, unknown> = {
      'bad lane!': laneEntry({ reason: 'spend_down_unknown' }),
      claude: { posture: 'burn', posture_reason: 'spend_down_unknown' }, // no lane field needed — key rules
      devin: { lane: 'devin', posture: 'sideways', posture_reason: 'devin_usage_stale' },
      zai: { lane: 'zai', posture: 'balanced' }, // posture_reason missing
      gemini: { lane: 'gemini', posture: 'balanced', posture_reason: 'Not A Code' },
      'codex-personal': laneEntry({ reason: 'spend_down_unknown' }),
    };
    const fold = foldPostureJournal(postureRow(NOW_S, badLanes), NOW_MS, MARKET_POSTURE_WINDOW_HOURS);
    expect(fold.records).toBe(1);
    // claude and codex-personal entries are fully valid (the map key is the lane id —
    // the writer's redundant inner lane field is not required); each spend_down_unknown cell exists.
    expect(fold.laneEntries.get('codex-personal')).toBe(1);
    expect(fold.laneEntries.get('claude')).toBe(1); // valid posture+reason despite missing 'lane' field inside
    expect(fold.laneEntries.get('devin')).toBeUndefined();
    expect(fold.laneEntries.get('zai')).toBeUndefined();
    expect(fold.laneEntries.get('gemini')).toBeUndefined();
    expect(fold.cells.get('codex-personal:spend_down_unknown')?.rows).toBe(1);
    expect(fold.cells.get('claude:spend_down_unknown')?.rows).toBe(1);
  });

  it('classifies evidence and waste reasons and dedupes posture/cost_class pairs', () => {
    const rows = [
      // Devin metered: posture_reason === cost_class_reason — one contribution, not two.
      eventWith(NOW_S, { devin: { posture: 'balanced', reason: 'devin_usage_stale', costReason: 'devin_usage_stale' } }),
      // Devin included with a broken spend-down reading plus a healthy cost class.
      eventWith(NOW_S - HOUR / 1000, { devin: { reason: 'spend_down_unknown', costReason: 'devin_within_allowance' } }),
      // Included lane under the use-it-all override.
      eventWith(NOW_S - 2 * HOUR / 1000, { claude: { posture: 'burn', reason: 'use_it_all_waste_risk' } }),
      // Designed reasons never create cells.
      eventWith(NOW_S - 3 * HOUR / 1000, {
        claude: { reason: 'spend_down_on_pace' },
        'codex-personal': { reason: 'spend_down_not_subscription', posture: 'preserve' },
        zai: { reason: 'host_declared', posture: 'burn' },
        gemini: { reason: 'free_until', posture: 'burn' },
        omlx: { reason: 'spend_down_projected_exhaustion', posture: 'preserve' },
      }),
      // A devin free-preview healthy row.
      eventWith(NOW_S - 4 * HOUR / 1000, { devin: { posture: 'burn', reason: 'devin_free_preview', costReason: 'devin_free_preview' } }),
    ].join('\n');
    const fold = foldPostureJournal(rows, NOW_MS, MARKET_POSTURE_WINDOW_HOURS);
    expect(fold.records).toBe(5);
    const kinds = new Map<string, string>();
    for (const cell of fold.cells.values()) kinds.set(`${cell.lane}:${cell.reason}`, cell.kind);
    expect(kinds.get('devin:devin_usage_stale')).toBe('evidence');
    expect(kinds.get('devin:spend_down_unknown')).toBe('evidence');
    expect(kinds.get('claude:use_it_all_waste_risk')).toBe('waste');
    expect(fold.cells.size).toBe(3);
    // devin_usage_stale counted once despite appearing in both reason fields.
    expect(fold.cells.get('devin:devin_usage_stale')?.rows).toBe(1);
  });
});

describe('postureCells', () => {
  it('emits only at the row and day bars', () => {
    // Below the row bar: one reason on too few ticks.
    const few = foldPostureJournal(reasonSeries('claude', 'spend_down_unknown', POSTURE_MIN_DAYS + 1, 1).join('\n'), NOW_MS, MARKET_POSTURE_WINDOW_HOURS);
    expect(few.cells.get('claude:spend_down_unknown')!.rows).toBeLessThan(POSTURE_MIN_ROWS);
    expect(postureCells(few)).toEqual([]);

    // One day only — a burst, not a pattern.
    const oneDay = foldPostureJournal(reasonSeries('claude', 'spend_down_unknown', 1, POSTURE_MIN_ROWS + 2).join('\n'), NOW_MS, MARKET_POSTURE_WINDOW_HOURS);
    expect(oneDay.cells.get('claude:spend_down_unknown')!.days.size).toBe(1);
    expect(postureCells(oneDay)).toEqual([]);

    // Recurring: 11 entries across 3 distinct UTC days.
    const recurring = foldPostureJournal(reasonSeries('claude', 'spend_down_unknown', 3, 3).join('\n')
      + '\n' + reasonSeries('claude', 'spend_down_unknown', 1, 2).join('\n'),
      NOW_MS, MARKET_POSTURE_WINDOW_HOURS);
    const cells = postureCells(recurring);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'evidence', lane: 'claude', reason: 'spend_down_unknown', rows: 11, laneEntries: 11 });
    expect(cells[0]!.days).toHaveLength(3);
    expect(cells[0]!.lowerBound).toBe(false);
    expect(postureCells(recurring, true)[0]!.lowerBound).toBe(true);
  });
});

describe('marketPostureBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'market-posture-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose metrics/work-market.jsonl carries the given rows. */
  async function runsDir(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'work-market.jsonl'), rows.join('\n') + '\n');
    return dir;
  }

  it('emits evidence and waste items for recurring posture evidence', async () => {
    const rows = [
      ...reasonSeries('claude', 'spend_down_unknown', 3, 3),
      ...reasonSeries('devin', 'devin_usage_stale', 3, 3, { posture: 'balanced', costReason: 'devin_usage_stale' }),
      ...reasonSeries('codex-personal', 'use_it_all_behind', 3, 3, { posture: 'burn' }),
    ];
    const dir = await runsDir('runs-cells', rows);
    const items = await marketPostureBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(3);
    const evidence = items.filter((i) => i.area === 'posture-evidence');
    const waste = items.filter((i) => i.area === 'posture-waste');
    expect(evidence).toHaveLength(2);
    expect(waste).toHaveLength(1);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(item.id).toMatch(/^market-posture-[0-9a-f]{16}$/);
      expect(item.prompt).toContain('work-market.jsonl');
      expect(item.prompt).toContain('posture');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
    }
    const spend = items.find((i) => i.title.includes('spend_down_unknown'))!;
    expect(spend.title).toContain('claude');
    expect(spend.prompt).toContain('spend_down_unknown');
    expect(spend.prompt).toContain('lane-usage-self');
    const devin = items.find((i) => i.title.includes('devin_usage_stale'))!;
    expect(devin.prompt).toContain('weekly-capacity');
    const behind = items.find((i) => i.title.includes('use_it_all_behind'))!;
    expect(behind.prompt).toContain('use-it-all');
    expect(behind.prompt).toContain('waste');
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await marketPostureBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: new Date(NOW_MS) })).toEqual([]);
    const empty = await runsDir('runs-empty', []);
    expect(await marketPostureBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);

    // A journal directory instead of a file.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'metrics', 'work-market.jsonl'), { recursive: true });
    expect(await marketPostureBacklogItems({ repo: 'ashlrai/phantom', runsDir: notFile, now: new Date(NOW_MS) })).toEqual([]);

    // Below the day bar: one burst day of adverse readings.
    const thin = await runsDir('runs-thin', reasonSeries('claude', 'spend_down_unknown', 1, POSTURE_MIN_ROWS + 4));
    expect(await marketPostureBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: new Date(NOW_MS) })).toEqual([]);
    expect(await marketPostureBacklogItems({ repo: 'ashlrai/lexicon', runsDir: thin, now: new Date(NOW_MS) })).toEqual([]);
    expect(await marketPostureBacklogItems({ repo: '', runsDir: thin, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = reasonSeries('claude', 'spend_down_unknown', 3, 3);
    // Pad the journal past the 32 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(33 * 1024 * 1024);
    const dir = await runsDir('runs-trunc', []);
    await writeFile(join(dir, 'metrics', 'work-market.jsonl'), pad + '\n' + rows.join('\n') + '\n');
    const items = await marketPostureBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...reasonSeries('claude', 'spend_down_unknown', 3, 3),
      ...reasonSeries('devin', 'devin_usage_stale', 3, 3, { posture: 'balanced', costReason: 'devin_usage_stale' }),
      ...reasonSeries('devin', 'devin_allowance_unknown', 2, 4, { posture: 'balanced', costReason: 'devin_allowance_unknown' }),
      ...reasonSeries('codex-personal', 'use_it_all_waste_risk', 3, 3, { posture: 'burn' }),
    ];
    const dir = await runsDir('runs-stable', rows);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await marketPostureBacklogItems(opts);
    const second = await marketPostureBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.length).toBeLessThanOrEqual(MARKET_POSTURE_MAX_ITEMS);
    const limited = await marketPostureBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends market-posture items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const runs = join(home, '.ashlr-runs');
      await mkdir(join(runs, 'metrics'), { recursive: true });
      await writeFile(join(runs, 'metrics', 'work-market.jsonl'),
        reasonSeries('claude', 'spend_down_unknown', 3, 3).join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const postureItems = first.items.filter((i) => i.id.startsWith('market-posture-'));
      expect(postureItems).toHaveLength(1);
      expect(postureItems[0]!.area).toBe('posture-evidence');
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(postureItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('market-posture-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('market-posture-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('closed vocabularies', () => {
  it('keeps the emitted reason sets inside the writer\'s vocabulary', () => {
    for (const reason of POSTURE_EVIDENCE_REASONS) {
      expect(reason).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
    for (const reason of POSTURE_WASTE_REASONS) {
      expect(reason).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
    // The two sets never overlap and cover exactly the adverse vocabulary.
    expect(POSTURE_EVIDENCE_REASONS.length + POSTURE_WASTE_REASONS.length).toBe(11);
    expect(new Set([...POSTURE_EVIDENCE_REASONS, ...POSTURE_WASTE_REASONS]).size).toBe(11);
  });
});
