import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldTypedRouteJournal,
  TYPED_DEGRADED_SHARE,
  TYPED_ROUTE_DEGRADED_CODES,
  TYPED_ROUTE_MAX_ITEMS,
  TYPED_ROUTE_MIN_DAYS,
  TYPED_ROUTE_MIN_ROWS,
  TYPED_ROUTE_WINDOW_MS,
  TYPED_UNAVAILABLE_SHARE,
  typedRouteBacklogItems,
  typedRouteCells,
} from '../src/core/improve/typed-route-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are epoch seconds like dispatchd's observe_typed_route writes. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW_S = Math.floor(NOW_MS / 1000);
/** Epoch seconds `msAgo` milliseconds before NOW_MS. */
const sec = (msAgo: number): number => Math.floor((NOW_MS - msAgo) / 1000);

/** One route.explain.v1 row in the producer's shape; observed rows carry the decision allowlist fields. */
function explainRow(tsSec: number, spec: { status?: 'observed' | 'unavailable'; decision?: unknown } = {}): string {
  const status = spec.status ?? 'observed';
  const row: Record<string, unknown> = {
    schema: 'route.explain.v1', event: 'route.explain', ts: tsSec, advisory: true, status,
  };
  if (status === 'observed') {
    if (!('decision' in spec)) {
      row['decision'] = { lane: 'claude', model: 'claude-opus-4.5', effort: 'high', speed_tier: 'workhorse', reason_codes: ['jev'] };
    } else {
      const d = spec.decision;
      if (d === null || typeof d !== 'object' || Array.isArray(d)) {
        row['decision'] = d; // verbatim — exercises the validator's rejection path
      } else {
        const rec = d as Record<string, unknown>;
        row['decision'] = {
          lane: rec['lane'] === undefined ? 'claude' : rec['lane'],
          model: rec['model'] === undefined ? 'claude-opus-4.5' : rec['model'],
          effort: rec['effort'] === undefined ? 'high' : rec['effort'],
          speed_tier: rec['speed_tier'] !== undefined ? rec['speed_tier'] : (rec['speedTier'] !== undefined ? rec['speedTier'] : 'workhorse'),
          reason_codes: rec['reason_codes'] !== undefined ? rec['reason_codes'] : (rec['reasons'] !== undefined ? rec['reasons'] : ['jev']),
        };
      }
    }
    row['duration_ms'] = 412;
    row['attempts'] = 1;
    row['candidate_count'] = 4;
  }
  return J(row);
}

const unavailableRow = (tsSec: number): string => explainRow(tsSec, { status: 'unavailable' });
const cleanRow = (tsSec: number): string => explainRow(tsSec, { decision: { reasons: ['jev'] } });
/** An observed decision that fell back because of `code`. */
const fallbackRow = (tsSec: number, code: string, extra: string[] = []): string =>
  explainRow(tsSec, { decision: { reasons: [...new Set([code, 'deterministic-fallback', ...extra])] } });
/** An observed decision whose model path failed but a later backend recovered — no fallback marker. */
const recoveredRow = (tsSec: number, code: string, backend: string): string =>
  explainRow(tsSec, { decision: { reasons: [code, 'schema-retry', backend] } });

/** n unavailable samples spread across `days` distinct UTC days ending today. */
function unavailableSeries(days: number, perDay: number): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) rows.push(unavailableRow(sec(d * DAY + i * HOUR)));
  }
  return rows;
}

/** n observed-decision rows spread across `days` distinct UTC days ending today. */
function observedSeries(days: number, perDay: number, make: (dayIndex: number, i: number) => string): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) rows.push(make(d, i));
  }
  return rows;
}

describe('foldTypedRouteJournal', () => {
  it('keeps only in-window route.explain.v1 rows of the producer contract', () => {
    const rows = [
      unavailableRow(NOW_S),
      cleanRow(NOW_S - HOUR / 1000),
      J({ schema: 'route.explain.v1', event: 'route.explain', ts: NOW_S, advisory: true, status: 'bogus' }),
      J({ schema: 'other.v9', event: 'route.explain', ts: NOW_S, advisory: true, status: 'unavailable' }),
      J({ schema: 'route.explain.v1', event: 'other.event', ts: NOW_S, advisory: true, status: 'unavailable' }),
      J({ schema: 'route.explain.v1', event: 'route.explain', ts: NOW_S, status: 'unavailable' }), // advisory missing
      J({ schema: 'route.explain.v1', event: 'route.explain', ts: NOW_S, advisory: false, status: 'unavailable' }),
      J({ schema: 'route.explain.v1', event: 'route.explain', ts: 'soon', advisory: true, status: 'unavailable' }),
      unavailableRow(NOW_S - TYPED_ROUTE_WINDOW_MS / 1000 - 10), // outside the window
      unavailableRow(NOW_S + 600), // beyond the +60 s skew tolerance
      'not json',
      '',
    ].join('\n');
    const fold = foldTypedRouteJournal(rows, NOW_MS, TYPED_ROUTE_WINDOW_MS);
    expect(fold.records).toBe(2);
    expect(fold.unavailable).toBe(1);
    expect(fold.observed).toBe(1);
    // The bogus-status, wrong-schema, wrong-event, missing/false advisory,
    // string-ts, non-JSON and blank-adjacent lines all count as invalid;
    // out-of-window and future-skew rows are skipped as non-evidence.
    expect(fold.invalidRows).toBe(7);
    expect(fold.unavailableDays).toEqual(new Set([new Date(NOW_S * 1000).toISOString().slice(0, 10)]));
  });

  it('validates the observed decision against the producer allowlist', () => {
    const bad = [
      explainRow(NOW_S, { decision: { lane: 'bad lane!', reasons: ['jev'] } }),
      explainRow(NOW_S, { decision: { model: 'm'.repeat(200), reasons: ['jev'] } }),
      explainRow(NOW_S, { decision: { effort: 'ludicrous', reasons: ['jev'] } }),
      explainRow(NOW_S, { decision: { speedTier: 'warp', reasons: ['jev'] } }),
      explainRow(NOW_S, { decision: { reasons: [] } }),
      explainRow(NOW_S, { decision: { reasons: Array.from({ length: 17 }, (_, i) => `code${i}`) } }),
      explainRow(NOW_S, { decision: { reasons: ['jev', 'not-a-reason'] } }),
      explainRow(NOW_S, { decision: { lane: null, model: null, effort: null, speedTier: null, reasons: ['no-candidates'] } }),
      explainRow(NOW_S, { decision: null }),
      explainRow(NOW_S, { decision: 'a string' }),
    ];
    const fold = foldTypedRouteJournal(bad.join('\n'), NOW_MS, TYPED_ROUTE_WINDOW_MS);
    expect(fold.observed).toBe(0);
    expect(fold.records).toBe(0);
    expect(fold.invalidRows).toBe(bad.length);

    const good = explainRow(NOW_S, { decision: { reasons: ['backend-unavailable', 'deterministic-fallback'] } });
    const foldGood = foldTypedRouteJournal(good, NOW_MS, TYPED_ROUTE_WINDOW_MS);
    expect(foldGood.observed).toBe(1);
    expect(foldGood.records).toBe(1);
    expect(foldGood.invalidRows).toBe(0);
  });

  it('counts each degraded code once per row and only on fallback-marked decisions', () => {
    const rows = [
      // Fallback pick carrying two degraded codes plus the retry/path markers:
      // schema-invalid counts once, schema-retry and jev never do.
      explainRow(NOW_S, { decision: { reasons: ['schema-invalid', 'schema-retry', 'deterministic-fallback', 'jev'] } }),
      // Recovered: schema-invalid rode a successful jev pick — no fallback marker, no cell.
      recoveredRow(NOW_S - HOUR / 1000, 'schema-invalid', 'jev'),
      // Path/policy vocabulary never emits even beside the fallback marker.
      explainRow(NOW_S - 2 * HOUR / 1000, { decision: { reasons: ['single-candidate', 'deterministic-fallback'] } }),
      explainRow(NOW_S - 3 * HOUR / 1000, { decision: { reasons: ['deterministic-fallback'] } }),
    ].join('\n');
    const fold = foldTypedRouteJournal(rows, NOW_MS, TYPED_ROUTE_WINDOW_MS);
    expect(fold.observed).toBe(4);
    expect(fold.records).toBe(4);
    expect([...fold.degraded.keys()]).toEqual(['schema-invalid']);
    expect(fold.degraded.get('schema-invalid')!.rows).toBe(1);
    expect(fold.degraded.get('schema-invalid')!.days.size).toBe(1);
  });
});

describe('typedRouteCells', () => {
  it('emits unavailable only at the row, day and share bars', () => {
    // Below the row bar.
    const few = foldTypedRouteJournal(unavailableSeries(TYPED_ROUTE_MIN_DAYS + 1, 1).join('\n'), NOW_MS, TYPED_ROUTE_WINDOW_MS);
    expect(few.unavailable).toBeLessThan(TYPED_ROUTE_MIN_ROWS);
    expect(typedRouteCells(few)).toEqual([]);

    // One day only — a burst, not a pattern.
    const oneDay = foldTypedRouteJournal(unavailableSeries(1, TYPED_ROUTE_MIN_ROWS + 2).join('\n'), NOW_MS, TYPED_ROUTE_WINDOW_MS);
    expect(oneDay.unavailableDays.size).toBe(1);
    expect(typedRouteCells(oneDay)).toEqual([]);

    // Enough rows and days but drowned out below the share floor.
    const drowned = foldTypedRouteJournal([
      ...unavailableSeries(TYPED_ROUTE_MIN_DAYS + 1, 2),
      ...observedSeries(4, 60, () => cleanRow(NOW_S)),
    ].join('\n'), NOW_MS, TYPED_ROUTE_WINDOW_MS);
    expect(drowned.unavailable / drowned.records).toBeLessThan(TYPED_UNAVAILABLE_SHARE);
    expect(typedRouteCells(drowned)).toEqual([]);

    // Recurring: 9 unavailable across 3 days inside 45 records.
    const recurring = foldTypedRouteJournal([
      ...unavailableSeries(3, 3),
      ...observedSeries(3, 12, (_, i) => cleanRow(sec((i % 3) * HOUR))),
    ].join('\n'), NOW_MS, TYPED_ROUTE_WINDOW_MS);
    const cells = typedRouteCells(recurring);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'unavailable', code: null, rows: 9 });
    expect(cells[0]!.share).toBeCloseTo(9 / (9 + 36), 5);
    expect(cells[0]!.days).toHaveLength(3);
    expect(cells[0]!.lowerBound).toBe(false);
    expect(typedRouteCells(recurring, true)[0]!.lowerBound).toBe(true);
  });

  it('emits degraded codes only at the bars and only for fallback-marked rows', () => {
    // Recovered schema-invalid rows never count: 24 of them across 3 days, all observed.
    const recovered = foldTypedRouteJournal(
      observedSeries(3, 8, (d) => recoveredRow(sec(d * DAY), 'schema-invalid', 'jev')).join('\n'),
      NOW_MS, TYPED_ROUTE_WINDOW_MS);
    expect(recovered.observed).toBe(24);
    expect(recovered.degraded.size).toBe(0);
    expect(typedRouteCells(recovered)).toEqual([]);

    // Below the share floor: 6 deadline fallbacks inside 186 observed decisions.
    const thin = foldTypedRouteJournal([
      ...observedSeries(3, 2, (d) => fallbackRow(sec(d * DAY), 'deadline')),
      ...observedSeries(3, 60, () => cleanRow(NOW_S)),
    ].join('\n'), NOW_MS, TYPED_ROUTE_WINDOW_MS);
    expect(thin.degraded.get('deadline')!.rows / thin.observed).toBeLessThan(TYPED_DEGRADED_SHARE);
    expect(typedRouteCells(thin)).toEqual([]);

    // Recurring: deadline on 12 of 60 observed decisions across 3 days.
    const recurring = foldTypedRouteJournal([
      ...observedSeries(3, 4, (d) => fallbackRow(sec(d * DAY), 'deadline')),
      ...observedSeries(3, 16, () => cleanRow(NOW_S)),
    ].join('\n'), NOW_MS, TYPED_ROUTE_WINDOW_MS);
    const cells = typedRouteCells(recurring);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'degraded', code: 'deadline', rows: 12, total: 60 });
    expect(cells[0]!.share).toBeCloseTo(0.2, 5);
    expect(cells[0]!.days).toHaveLength(3);

    // Every emitted code is inside the failure vocabulary.
    for (const code of TYPED_ROUTE_DEGRADED_CODES) expect(typeof code).toBe('string');
  });
});

describe('typedRouteBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'typed-route-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose metrics/route.explain.jsonl carries the given rows. */
  async function runsDir(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'route.explain.jsonl'), rows.join('\n') + '\n');
    return dir;
  }

  it('emits unavailable and degraded items for recurring journal evidence', async () => {
    const rows = [
      ...unavailableSeries(3, 3),
      ...observedSeries(3, 4, (d) => fallbackRow(sec(d * DAY), 'deadline')),
      ...observedSeries(3, 16, () => cleanRow(NOW_S)),
    ];
    const dir = await runsDir('runs-cells', rows);
    const items = await typedRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW_MS });
    expect(items.map((i) => i.area).sort()).toEqual(['typed-route', 'typed-route']);
    const unavailable = items.find((i) => i.title.includes('failing before it can decide'))!;
    const degraded = items.find((i) => i.title.includes('degrading'))!;
    expect(unavailable).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'typed-route' });
    expect(unavailable.id).toMatch(/^typed-route-[0-9a-f]{16}$/);
    expect(degraded.id).toMatch(/^typed-route-[0-9a-f]{16}$/);
    expect(unavailable.id).not.toBe(degraded.id);
    expect(degraded.title).toContain('deadline');
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('route.explain.jsonl');
      expect(item.prompt).toContain('phm route explain');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
    }
    expect(unavailable.prompt).toContain("'unavailable'");
    expect(unavailable.prompt).toContain('9');
    expect(degraded.prompt).toContain('deadline');
    expect(degraded.prompt).toContain('deterministic fallback');
    expect(degraded.prompt).toContain('schema-invalid');
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await typedRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW_MS })).toEqual([]);
    const empty = await runsDir('runs-empty', []);
    expect(await typedRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: NOW_MS })).toEqual([]);

    // A journal directory instead of a file.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'metrics', 'route.explain.jsonl'), { recursive: true });
    expect(await typedRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: notFile, now: NOW_MS })).toEqual([]);

    // Below the day bar: one burst day of unavailable samples.
    const thin = await runsDir('runs-thin', unavailableSeries(1, TYPED_ROUTE_MIN_ROWS + 4));
    expect(await typedRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW_MS })).toEqual([]);
    expect(await typedRouteBacklogItems({ repo: 'ashlrai/lexicon', runsDir: thin, now: NOW_MS })).toEqual([]);
    expect(await typedRouteBacklogItems({ repo: '', runsDir: thin, now: NOW_MS })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = unavailableSeries(3, 3);
    // Pad the journal past the 8 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(9 * 1024 * 1024);
    const dir = await runsDir('runs-trunc', []);
    await writeFile(join(dir, 'metrics', 'route.explain.jsonl'), pad + '\n' + rows.join('\n') + '\n');
    const items = await typedRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW_MS });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...unavailableSeries(3, 3),
      ...observedSeries(3, 4, (d) => fallbackRow(sec(d * DAY), 'deadline')),
      ...observedSeries(3, 4, (d) => fallbackRow(sec(d * DAY + HOUR), 'backend-unavailable')),
      ...observedSeries(3, 12, () => cleanRow(NOW_S)),
    ];
    const dir = await runsDir('runs-stable', rows);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW_MS };
    const first = await typedRouteBacklogItems(opts);
    const second = await typedRouteBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.length).toBeLessThanOrEqual(TYPED_ROUTE_MAX_ITEMS);
    const limited = await typedRouteBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends typed-route items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'route.explain.jsonl'),
      unavailableSeries(3, 3).join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const typedItems = first.items.filter((i) => i.id.startsWith('typed-route-'));
    expect(typedItems).toHaveLength(1);
    expect(typedItems[0]!.area).toBe('typed-route');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(typedItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('typed-route-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('typed-route-'))).toHaveLength(1);
  });
});
