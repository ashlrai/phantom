import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDay } from '../src/core/decide/ledger.js';
import {
  foldJevDecisions,
  JEV_KIND_MIN_DECISIONS,
  JEV_KIND_MIN_DAYS,
  JEV_KIND_MIN_FALLBACK,
  JEV_WINDOW_MS,
  jevBacklogItems,
  jevCells,
  type JevDayRead,
} from '../src/core/improve/jev-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 10 * 60_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 like record() writes. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
/** The producer names each file by localDay(record.ts); tests name files the same way. */
const fileDay = (ms: number): string => localDay(new Date(ms));

/** One DecisionRecord in the writer's shape; valid unless a spec field breaks the contract. */
function rec(spec: {
  kind?: string;
  path?: string;
  reason?: string | null;
  atMs?: number;
  ts?: string;
  called?: boolean;
  cached?: boolean;
  confidence?: number;
  durationMs?: number;
  estCostUsd?: number;
  extra?: Record<string, unknown>;
} = {}): string {
  const path = spec.path ?? 'fallback';
  const row: Record<string, unknown> = {
    ts: spec.ts ?? iso(spec.atMs ?? NOW_MS),
    kind: spec.kind ?? 'engine-error',
    path,
    confidence: spec.confidence ?? 1,
    cached: spec.cached ?? false,
    called: spec.called ?? true,
    model: 'jev-1.13.0',
    inputTokens: 120,
    outputTokens: 24,
    durationMs: spec.durationMs ?? 140,
    ...spec.extra,
  };
  if (path === 'fallback') {
    if (spec.reason !== null) row['reason'] = spec.reason ?? 'below-threshold';
    if (typeof spec.estCostUsd === 'number') row['estCostUsd'] = spec.estCostUsd;
  } else {
    row['jevLabel'] = 'rate-limit';
    row['jevConfidence'] = 0.91;
    row['label'] = 'rate-limit';
  }
  return J(row);
}

/** Each line's recorded ts, for producer-accurate per-day file placement. */
function placed(line: string): { line: string; atMs: number } {
  return { line, atMs: Date.parse((JSON.parse(line) as { ts: string }).ts) };
}

/** Group lines into the per-local-day files the producer would write. */
function dayFiles(rows: { line: string; atMs: number }[]): Map<string, string> {
  const byDay = new Map<string, string[]>();
  for (const { line, atMs } of rows) {
    const day = fileDay(atMs);
    const list = byDay.get(day) ?? [];
    list.push(line);
    byDay.set(day, list);
  }
  return new Map([...byDay.entries()].map(([day, lines]) => [day, lines.join('\n') + '\n']));
}

/** Fold helper: every row lands in one file named for NOW_MS — the fold buckets by record ts, not file name. */
function foldRows(rows: string[], nowMs = NOW_MS) {
  const days: JevDayRead[] = [{ day: fileDay(nowMs), text: rows.join('\n') + '\n', truncated: false }];
  return foldJevDecisions(days, nowMs, JEV_WINDOW_MS);
}

/**
 * n records for one kind spread across `days` distinct UTC days ending
 * today. Records inside one day-group sit ten minutes apart, so every
 * row of group d lands on the same UTC date as NOW_MS - d days.
 */
function kindSeries(
  kind: string,
  days: number,
  fallbackPerDay: number,
  jevPerDay: number,
  opts: { reason?: string } = {},
): string[] {
  const rows: string[] = [];
  let seq = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < fallbackPerDay; i++) {
      rows.push(rec({ kind, reason: opts.reason, atMs: NOW_MS - d * DAY - seq++ * MIN }));
    }
    for (let i = 0; i < jevPerDay; i++) {
      rows.push(rec({ kind, path: 'jev', atMs: NOW_MS - d * DAY - seq++ * MIN }));
    }
  }
  return rows;
}

describe('foldJevDecisions', () => {
  it('folds valid in-window records per kind and skips out-of-contract rows', () => {
    const rows = [
      // A healthy mix: jev wins and recorded fallbacks for two kinds.
      rec({ kind: 'engine-error', path: 'jev', atMs: NOW_MS - HOUR }),
      rec({ kind: 'engine-error', reason: 'below-threshold', atMs: NOW_MS - 2 * HOUR, estCostUsd: 0.001 }),
      rec({ kind: 'engine-error', reason: 'timeout', atMs: NOW_MS - DAY - HOUR, estCostUsd: 0.002 }),
      rec({ kind: 'engine-error', reason: 'timeout', atMs: NOW_MS - DAY - 2 * HOUR, called: false, estCostUsd: 0.002 }),
      rec({ kind: 'task-class', path: 'jev', atMs: NOW_MS - HOUR }),
      rec({ kind: 'task-class', path: 'jev', atMs: NOW_MS - DAY }),
      // Out-of-window and future-dated records contribute nothing.
      rec({ kind: 'engine-error', reason: 'network', atMs: NOW_MS - JEV_WINDOW_MS - DAY }),
      rec({ kind: 'engine-error', reason: 'network', atMs: NOW_MS + 600_000 }),
      // Malformed lines and contract violations are counted, never guessed.
      'not json',
      '{"ts":',
      J({ ts: iso(NOW_MS), kind: 'bogus-kind', path: 'fallback', reason: 'timeout', confidence: 1, cached: false, called: true, durationMs: 1 }),
      J({ ts: iso(NOW_MS), kind: 'engine-error', path: 'maybe', confidence: 1, cached: false, called: true, durationMs: 1 }),
      // Never-recorded deliberate-off reasons are outside the producer contract.
      rec({ kind: 'engine-error', reason: 'killed' }),
      rec({ kind: 'engine-error', reason: 'no-key' }),
      rec({ kind: 'engine-error', reason: 'some-future-reason' }),
      // A reason on a jev-path row is off-contract.
      J({ ts: iso(NOW_MS), kind: 'engine-error', path: 'jev', reason: 'timeout', confidence: 0.9, cached: false, called: true, durationMs: 1 }),
      // Missing or mistyped required fields.
      J({ ts: 'not-a-date', kind: 'engine-error', path: 'fallback', confidence: 1, cached: false, called: true, durationMs: 1 }),
      J({ ts: iso(NOW_MS), kind: 'engine-error', path: 'fallback', confidence: 'high', cached: false, called: true, durationMs: 1 }),
      J({ ts: iso(NOW_MS), kind: 'engine-error', path: 'fallback', confidence: 1, cached: 'no', called: true, durationMs: 1 }),
      J({ ts: iso(NOW_MS), kind: 'engine-error', path: 'fallback', confidence: 1, cached: false, called: true, durationMs: 'slow' }),
      '42',
      '"a string"',
      '[1,2]',
      '',
    ];
    const fold = foldRows(rows);
    // Valid in-window: engine-error 1 jev + 3 fallback, task-class 2 jev = 6.
    expect(fold.records).toBe(6);
    // Invalid: 2 torn lines + bogus kind + bad path + 3 bad reasons +
    // reason-on-jev + bad ts + bad confidence + bad cached + bad
    // durationMs + 3 non-object lines = 15.
    expect(fold.invalid).toBe(15);
    const eng = fold.kinds.get('engine-error')!;
    expect(eng.decisions).toBe(4);
    expect(eng.fallback).toBe(3);
    expect(eng.days.size).toBe(2);
    expect(eng.reasons.get('below-threshold')).toBe(1);
    expect(eng.reasons.get('timeout')).toBe(2);
    // Only called+priced fallback rows sum: 0.001 + 0.002 = 0.003;
    // the called:false row's 0.002 estimate never counts.
    expect(eng.estCostUsd).toBeCloseTo(0.003, 10);
    expect(eng.pricedCalls).toBe(2);
    const task = fold.kinds.get('task-class')!;
    expect(task.decisions).toBe(2);
    expect(task.fallback).toBe(0);
    expect(task.estCostUsd).toBeNull();
    expect(task.pricedCalls).toBe(0);
  });

  it('accepts a fallback row without a reason and ignores foreign extra fields', () => {
    const rows = [
      J({
        ts: iso(NOW_MS - HOUR), kind: 'engine-error', path: 'fallback',
        confidence: 1, cached: true, called: false, durationMs: 0,
        jevLabel: 'model-failure', jevConfidence: 0.2,
        answers: { q: { type: 'choice', choice: 'x', confidence: 0.2 } },
        foreignField: { nested: [1, 2, 3] },
      }),
      rec({ kind: 'engine-error', reason: 'network', atMs: NOW_MS - DAY }),
    ];
    const fold = foldRows(rows);
    expect(fold.invalid).toBe(0);
    const eng = fold.kinds.get('engine-error')!;
    expect(eng.fallback).toBe(2);
    expect(eng.reasons.get('network')).toBe(1);
    expect(eng.reasons.size).toBe(1);
  });
});

describe('jevCells', () => {
  it('emits a kind cell only at the decision, fallback, day and share bars', () => {
    // Below the day bar: enough fallbacks but all on one UTC day.
    const oneDay = foldRows(kindSeries('engine-error', 1, JEV_KIND_MIN_FALLBACK + 1, 1));
    expect(oneDay.kinds.get('engine-error')!.fallback).toBe(JEV_KIND_MIN_FALLBACK + 1);
    expect(oneDay.kinds.get('engine-error')!.days.size).toBe(1);
    expect(jevCells(oneDay)).toEqual([]);

    // Below the share bar: fallbacks recur but Jev still wins most decisions.
    const healthy = foldRows(kindSeries('engine-error', JEV_KIND_MIN_DAYS + 1, JEV_KIND_MIN_FALLBACK, 8));
    const healthyKind = healthy.kinds.get('engine-error')!;
    expect(healthyKind.fallback).toBe(JEV_KIND_MIN_FALLBACK * (JEV_KIND_MIN_DAYS + 1));
    expect(healthyKind.fallback / healthyKind.decisions).toBeLessThan(0.5);
    expect(jevCells(healthy)).toEqual([]);

    // Below the decision bar: a rare kind cannot clear the volume floor.
    const rare = foldRows(kindSeries('judge-verdict', JEV_KIND_MIN_DAYS, 2, 0));
    expect(rare.kinds.get('judge-verdict')!.decisions).toBeLessThan(JEV_KIND_MIN_DECISIONS);
    expect(jevCells(rare)).toEqual([]);

    // At the bars: fallbacks dominate across two days.
    const fold = foldRows(kindSeries('engine-error', 2, 3, 1, { reason: 'below-threshold' }));
    const eng = fold.kinds.get('engine-error')!;
    // 2 days × (3 fallback + 1 jev) = 8 decisions, 6 fallback → share 0.75.
    expect(eng.decisions).toBe(8);
    expect(eng.fallback).toBe(6);
    const cells = jevCells(fold);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.kind).toBe('engine-error');
    expect(cell.decisions).toBe(8);
    expect(cell.fallback).toBe(6);
    expect(cell.share).toBeCloseTo(0.75, 5);
    expect(cell.days).toHaveLength(JEV_KIND_MIN_DAYS);
    expect(cell.reasons).toEqual([{ reason: 'below-threshold', count: 6 }]);
    expect(cell.firstSeen).not.toBeNull();
    expect(cell.lastSeen).not.toBeNull();
    // kindSeries rows carry no estCostUsd — unpriced calls stay unknown, never zero.
    expect(cell.estCostUsd).toBeNull();
    expect(cell.pricedCalls).toBe(0);
    expect(cell.lowerBound).toBe(false);
    expect(jevCells(fold, true)[0]!.lowerBound).toBe(true);
  });

  it('sorts cells worst-first and never emits healthy kinds', () => {
    const rows = [
      // engine-error: heavy fallback dominance — 9 fallback / 12 decisions.
      ...kindSeries('engine-error', 3, 3, 1),
      // task-class: exactly at the 0.5 share boundary — 4 fallback / 8 decisions.
      ...kindSeries('task-class', 2, 2, 2, { reason: 'timeout' }),
      // completion-claim: all jev — silent.
      ...kindSeries('completion-claim', 3, 0, 3),
    ];
    const cells = jevCells(foldRows(rows));
    expect(cells.map((c) => c.kind)).toEqual(['engine-error', 'task-class']);
    expect(cells[0]!.fallback).toBe(9);
    expect(cells[1]!.fallback).toBe(4);
    expect(cells[1]!.share).toBeCloseTo(0.5, 5);
    expect(cells[1]!.reasons[0]!.reason).toBe('timeout');
    expect(JEV_KIND_MIN_DECISIONS).toBeLessThanOrEqual(cells[1]!.decisions);
  });
});

describe('jevBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = NOW_MS;

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    home = await mkdtemp(join(tmpdir(), 'jev-backlog-'));
    process.env.HOME = home;
    process.env.ASHLR_HOME = join(home, '.ashlr');
    delete process.env.ASHLR_RUNS_DIR;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** Write day files under a ledger dir, placed by each record's own ts. */
  async function ledgerDir(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(dir, { recursive: true });
    for (const [day, body] of dayFiles(rows.map(placed))) {
      await writeFile(join(dir, `${day}.jsonl`), body);
    }
    return dir;
  }

  it('emits a jev-fallback item for a recurring fallback-dominant kind', async () => {
    const rows = [
      ...kindSeries('engine-error', 3, 3, 1, { reason: 'below-threshold' }),
      rec({ kind: 'engine-error', reason: 'timeout', atMs: NOW_MS - 5 * HOUR, estCostUsd: 0.001 }),
      rec({ kind: 'engine-error', reason: 'timeout', atMs: NOW_MS - 6 * HOUR, estCostUsd: 0.001 }),
    ];
    const dir = await ledgerDir('jev-live', rows);
    const items = await jevBacklogItems({ repo: 'ashlrai/phantom', ledgerDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'jev-decisions' });
    expect(item!.id).toMatch(/^jev-fallback-[0-9a-f]{16}$/);
    expect(item!.title).toContain('engine-error');
    expect(item!.title).toContain('falling back');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('engine-error');
    expect(item!.prompt).toContain('below-threshold');
    expect(item!.prompt).toContain('timeout');
    expect(item!.prompt).toContain('phm jev status');
    expect(item!.prompt).toContain('jev/decisions');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain('lower bound');
    expect(item!.prompt).toContain('$0.002000');
  });

  it('emits nothing for missing evidence, another repository, or below-bar kinds', async () => {
    expect(await jevBacklogItems({ repo: 'ashlrai/phantom', ledgerDir: join(home, 'nope'), now: NOW })).toEqual([]);

    // An empty ledger dir.
    const empty = join(home, 'jev-empty');
    await mkdir(empty, { recursive: true });
    expect(await jevBacklogItems({ repo: 'ashlrai/phantom', ledgerDir: empty, now: NOW })).toEqual([]);

    // A directory where a day file should be — unreadable evidence fails closed.
    const notFile = join(home, 'jev-notfile');
    await mkdir(join(notFile, `${fileDay(NOW_MS)}.jsonl`), { recursive: true });
    expect(await jevBacklogItems({ repo: 'ashlrai/phantom', ledgerDir: notFile, now: NOW })).toEqual([]);

    // Below the day bar: one burst day of fallbacks.
    const thin = await ledgerDir('jev-thin', kindSeries('engine-error', 1, 6, 0));
    expect(await jevBacklogItems({ repo: 'ashlrai/phantom', ledgerDir: thin, now: NOW })).toEqual([]);
    expect(await jevBacklogItems({ repo: 'ashlrai/lexicon', ledgerDir: thin, now: NOW })).toEqual([]);
    expect(await jevBacklogItems({ repo: '', ledgerDir: thin, now: NOW })).toEqual([]);

    // A healthy ledger: jev wins emit nothing.
    const healthy = await ledgerDir('jev-healthy', kindSeries('engine-error', 3, 0, 4));
    expect(await jevBacklogItems({ repo: 'ashlrai/phantom', ledgerDir: healthy, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = kindSeries('engine-error', 3, 3, 1);
    const dir = join(home, 'jev-trunc');
    await mkdir(dir, { recursive: true });
    const files = dayFiles(rows.map(placed));
    const newest = [...files.keys()].sort().at(-1)!;
    for (const [day, body] of files) {
      // Pad the newest day file past the 512 KiB tail bound.
      await writeFile(join(dir, `${day}.jsonl`), day === newest ? 'x'.repeat(513 * 1024) + '\n' + body : body);
    }
    const items = await jevBacklogItems({ repo: 'ashlrai/phantom', ledgerDir: dir, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await ledgerDir('jev-stable', kindSeries('engine-error', 3, 3, 1));
    const opts = { repo: 'ashlrai/phantom', ledgerDir: dir, now: NOW };
    const first = await jevBacklogItems(opts);
    const second = await jevBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(1);
    const limited = await jevBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends jev items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock and resolves
    // the ledger through ASHLR_HOME, so fixtures stamp relative to now.
    const realNow = Date.now();
    const dir = join(process.env.ASHLR_HOME!, 'jev', 'decisions');
    await mkdir(dir, { recursive: true });
    const rows: string[] = [];
    for (let d = 0; d < 3; d++) {
      for (let i = 0; i < 3; i++) {
        rows.push(rec({ kind: 'engine-error', reason: 'below-threshold', atMs: realNow - d * DAY - i * HOUR }));
      }
      rows.push(rec({ kind: 'engine-error', path: 'jev', atMs: realNow - d * DAY - 5 * HOUR }));
    }
    for (const [day, body] of dayFiles(rows.map(placed))) {
      await writeFile(join(dir, `${day}.jsonl`), body);
    }
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const jevItems = first.items.filter((i) => i.id.startsWith('jev-fallback-'));
    expect(jevItems).toHaveLength(1);
    expect(jevItems[0]!.area).toBe('jev-decisions');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(jevItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('jev-fallback-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('jev-fallback-'))).toHaveLength(1);
  });
});
