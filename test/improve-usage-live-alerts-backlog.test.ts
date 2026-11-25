import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldUsageLiveAlerts,
  USAGE_LIVE_ALERTS_MIN_DAYS,
  USAGE_LIVE_ALERTS_MIN_ROWS,
  USAGE_LIVE_ALERTS_MIN_WINDOWS,
  USAGE_LIVE_ALERTS_WINDOW_HOURS,
  usageLiveAlertCells,
  usageLiveAlertsBacklogItems,
} from '../src/core/improve/usage-live-alerts-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the journal writer's ts. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One UsageAlert row in the writer's journaled shape. */
function alertRow(spec: {
  atMs?: number;
  level?: string;
  subject?: string;
  /** Pass undefined for the writer's default per level; null writes an explicit null. */
  pct?: number | null;
  resetAt?: string | null;
  ts?: string | null;
  extra?: Record<string, unknown>;
}): string {
  const level = spec.level ?? 'cap-95';
  const pct = spec.pct === undefined
    ? (level === 'needs-signin' ? null : 96)
    : spec.pct;
  const resetAt = spec.resetAt === undefined
    ? (level === 'needs-signin' ? null : iso(NOW_MS + 2 * DAY))
    : spec.resetAt;
  const ts = spec.ts === undefined ? iso(spec.atMs ?? NOW_MS) : spec.ts;
  return J({
    ts,
    level,
    subject: spec.subject ?? 'claude-max',
    message: `${spec.subject ?? 'claude-max'} is at ${pct ?? 'unknown'}% of its cap`,
    pct,
    resetAt,
    ...spec.extra,
  });
}

/**
 * Recurring rows on one (level, subject) cell. resetAtMs defaults to a
 * distinct instant per day so a d-day series spans d distinct allowance
 * windows; pass fixedResetAtMs to pin a single window.
 */
function alertSeries(opts: {
  level?: string;
  subject?: string;
  days: number;
  perDay?: number;
  pct?: number;
  fixedResetAtMs?: number;
}): string[] {
  const rows: string[] = [];
  const perDay = opts.perDay ?? 1;
  for (let d = 0; d < opts.days; d++) {
    for (let i = 0; i < perDay; i++) {
      const atMs = NOW_MS - d * DAY - i * HOUR - HOUR;
      // Rows on the same UTC day share one reset instant — the writer's
      // snapReset keeps a window's identity stable — while each day is a
      // different allowance window.
      const resetAtMs = opts.fixedResetAtMs ?? (Math.floor(atMs / DAY) * DAY + 3 * DAY);
      rows.push(alertRow({
        atMs,
        level: opts.level,
        subject: opts.subject,
        pct: opts.pct,
        resetAt: opts.level === 'needs-signin' ? null : iso(resetAtMs),
      }));
    }
  }
  return rows;
}

/** The production fold: one journal text (the single append-only file). */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldUsageLiveAlerts([rows.join('\n')], nowMs, USAGE_LIVE_ALERTS_WINDOW_HOURS);
}

describe('foldUsageLiveAlerts', () => {
  it('counts in-window alerts and skips foreign shapes without guessing', () => {
    const rows = [
      alertRow({ atMs: NOW_MS - HOUR }),
      alertRow({ atMs: NOW_MS - 2 * HOUR, level: 'cap-80', pct: 82 }),
      // Outside the window — too old and too far in the future.
      alertRow({ atMs: NOW_MS - USAGE_LIVE_ALERTS_WINDOW_HOURS * 3_600_000 - DAY }),
      alertRow({ atMs: NOW_MS + 600_000 }),
      // Malformed JSON and non-object rows.
      'not json at all',
      '[1,2,3]',
      'null',
      // Foreign shapes — the writer's contract rejects them all.
      J({ level: 'cap-95', subject: 'x', pct: 1, resetAt: null }),                          // no ts
      J({ ts: 'not-a-date', level: 'cap-95', subject: 'x', pct: 1, resetAt: null }),
      J({ ts: iso(NOW_MS), level: 'cap-99', subject: 'x', pct: 1, resetAt: null }),          // level outside the closed vocabulary
      J({ ts: iso(NOW_MS), level: 'cap-95', subject: '', pct: 1, resetAt: null }),           // empty subject
      J({ ts: iso(NOW_MS), level: 'cap-95', subject: 'x'.repeat(200), pct: 1, resetAt: null }), // oversized subject
      J({ ts: iso(NOW_MS), level: 'cap-95', subject: 'x', pct: 'high', resetAt: null }),     // pct not numeric
      J({ ts: iso(NOW_MS), level: 'cap-95', subject: 'x', pct: 140, resetAt: null }),        // pct above 100
      J({ ts: iso(NOW_MS), level: 'cap-95', subject: 'x', pct: -2, resetAt: null }),         // pct below 0
      J({ ts: iso(NOW_MS), level: 'cap-95', subject: 'x', pct: 96, resetAt: 'soon' }),        // resetAt unparseable
      // Level pairing violations: the writer never emits these.
      J({ ts: iso(NOW_MS), level: 'needs-signin', subject: 'claude', message: 'm', pct: 5, resetAt: null }),
      J({ ts: iso(NOW_MS), level: 'needs-signin', subject: 'claude', message: 'm', pct: null, resetAt: iso(NOW_MS + DAY) }),
      J({ ts: iso(NOW_MS), level: 'cap-95', subject: 'x', message: 'm', pct: null, resetAt: null }),
      '{"ts":"2026',
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.alerts).toBe(2);
    expect(fold.malformed).toBe(16);
    expect(fold.outsideWindow).toBe(2);
    expect([...fold.cells.keys()].sort()).toEqual(['cap-80|claude-max', 'cap-95|claude-max']);
  });

  it('folds alert cells per (level, subject) and tracks days, windows and peak pct', () => {
    const rows = [
      // cap-95 on claude-max across two days and two reset windows.
      ...alertSeries({ level: 'cap-95', subject: 'claude-max', days: 2, perDay: 2, pct: 97 }),
      // cap-80 on the same subject — a different level, a different cell.
      ...alertSeries({ level: 'cap-80', subject: 'claude-max', days: 1, perDay: 2, pct: 81 }),
      // expire-unspent on a budget lane.
      ...alertSeries({ level: 'expire-unspent', subject: 'zai', days: 2, perDay: 1 }),
      // needs-signin on a site across two days (resetAt always null).
      alertRow({ atMs: NOW_MS - DAY, level: 'needs-signin', subject: 'chatgpt-codex', pct: null, resetAt: null }),
      alertRow({ atMs: NOW_MS - 2 * DAY, level: 'needs-signin', subject: 'chatgpt-codex', pct: null, resetAt: null }),
      alertRow({ atMs: NOW_MS - 3 * DAY, level: 'needs-signin', subject: 'chatgpt-codex', pct: null, resetAt: null }),
    ];
    const fold = foldRows(rows);
    expect(fold.alerts).toBe(11);
    const keys = [...fold.cells.keys()].sort();
    expect(keys).toEqual([
      'cap-80|claude-max',
      'cap-95|claude-max',
      'expire-unspent|zai',
      'needs-signin|chatgpt-codex',
    ]);
    const cap95 = fold.cells.get('cap-95|claude-max')!;
    expect(cap95.rows).toBe(4);
    expect(cap95.days.size).toBe(2);
    expect(cap95.windows.size).toBe(2);
    expect(cap95.maxPct).toBe(97);
    const signin = fold.cells.get('needs-signin|chatgpt-codex')!;
    expect(signin.rows).toBe(3);
    expect(signin.days.size).toBe(3);
    expect(signin.windows.size).toBe(0);
    expect(signin.maxPct).toBeNull();
  });
});

describe('usageLiveAlertCells', () => {
  it('emits cap and expire cells only at the row/day/window bars', () => {
    // Below bars: rows span days but all point at one reset window.
    const oneWindow = foldRows(alertSeries({ days: 4, perDay: 2, fixedResetAtMs: NOW_MS + DAY }));
    expect(oneWindow.cells.get('cap-95|claude-max')!.rows).toBe(8);
    expect(oneWindow.cells.get('cap-95|claude-max')!.windows.size).toBe(1);
    expect(usageLiveAlertCells(oneWindow)).toEqual([]);

    // Below bars: rows on a single UTC day even with distinct windows —
    // short allowance windows can reset several times inside one day.
    const sameDay = [
      alertRow({ atMs: NOW_MS - HOUR, resetAt: iso(NOW_MS + DAY) }),
      alertRow({ atMs: NOW_MS - 2 * HOUR, resetAt: iso(NOW_MS + 2 * DAY) }),
      alertRow({ atMs: NOW_MS - 3 * HOUR, resetAt: iso(NOW_MS + DAY) }),
      alertRow({ atMs: NOW_MS - 4 * HOUR, resetAt: iso(NOW_MS + 2 * DAY) }),
    ];
    const thin = foldRows(sameDay);
    expect(thin.cells.get('cap-95|claude-max')!.days.size).toBe(1);
    expect(thin.cells.get('cap-95|claude-max')!.windows.size).toBe(2);
    expect(usageLiveAlertCells(thin)).toEqual([]);

    // Below bars: too few rows across enough days and windows.
    const twoRows = [
      alertRow({ atMs: NOW_MS - DAY, resetAt: iso(NOW_MS + DAY) }),
      alertRow({ atMs: NOW_MS - 2 * DAY, resetAt: iso(NOW_MS + 2 * DAY) }),
    ];
    expect(usageLiveAlertCells(foldRows(twoRows))).toEqual([]);

    // At the bars: rows + days + windows → emits, cap-95 before cap-80
    // before expire-unspent before needs-signin.
    const good = foldRows([
      ...alertSeries({ level: 'cap-95', subject: 'claude-max', days: USAGE_LIVE_ALERTS_MIN_DAYS, perDay: USAGE_LIVE_ALERTS_MIN_ROWS, pct: 97 }),
      ...alertSeries({ level: 'cap-80', subject: 'codex-personal', days: USAGE_LIVE_ALERTS_MIN_DAYS, perDay: USAGE_LIVE_ALERTS_MIN_ROWS, pct: 81 }),
      ...alertSeries({ level: 'expire-unspent', subject: 'zai', days: USAGE_LIVE_ALERTS_MIN_DAYS, perDay: USAGE_LIVE_ALERTS_MIN_ROWS }),
      ...alertSeries({ level: 'needs-signin', subject: 'gemini', days: USAGE_LIVE_ALERTS_MIN_ROWS, perDay: 1 }),
    ]);
    const cells = usageLiveAlertCells(good);
    expect(cells.map((c) => `${c.level}|${c.subject}`)).toEqual([
      'cap-95|claude-max',
      'expire-unspent|zai',
      'cap-80|codex-personal',
      'needs-signin|gemini',
    ]);
    const [cap95, expire, cap80, signin] = cells;
    expect(cap95).toMatchObject({ kind: 'usage-live-alert', level: 'cap-95', subject: 'claude-max', maxPct: 97 });
    expect(cap95!.rows).toBeGreaterThanOrEqual(USAGE_LIVE_ALERTS_MIN_ROWS);
    expect(cap95!.days.length).toBeGreaterThanOrEqual(USAGE_LIVE_ALERTS_MIN_DAYS);
    expect(cap95!.windows).toBeGreaterThanOrEqual(USAGE_LIVE_ALERTS_MIN_WINDOWS);
    expect(expire).toMatchObject({ level: 'expire-unspent', subject: 'zai' });
    expect(cap80).toMatchObject({ level: 'cap-80', subject: 'codex-personal', maxPct: 81 });
    expect(signin).toMatchObject({ level: 'needs-signin', subject: 'gemini', windows: 0, maxPct: null });
  });

  it('marks truncation as a lower bound on every cell', () => {
    const fold = foldUsageLiveAlerts(
      [alertSeries({ days: 3, perDay: 2 }).join('\n')],
      NOW_MS,
      USAGE_LIVE_ALERTS_WINDOW_HOURS,
    );
    const cells = usageLiveAlertCells(fold, true);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lowerBound).toBe(true);
    expect(usageLiveAlertCells(fold, false)[0]!.lowerBound).toBe(false);
  });
});

describe('usageLiveAlertsBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'usage-live-alerts-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under the temp home carrying the given rows. */
  async function journal(name: string, rows: string[]): Promise<string> {
    const dir = join(home, 'runs', 'bus');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }

  it('emits one item per recurring cell with grounded prompts', async () => {
    const rows = [
      ...alertSeries({ level: 'cap-95', subject: 'claude-max', days: 2, perDay: 2, pct: 97 }),
      ...alertSeries({ level: 'expire-unspent', subject: 'zai', days: 2, perDay: 2 }),
      ...alertSeries({ level: 'needs-signin', subject: 'gemini', days: 3, perDay: 1 }),
    ];
    const path = await journal('usage-live-alerts', rows);
    const items = await usageLiveAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.area)).toEqual(['usage-live-cap', 'usage-live-expire', 'usage-live-signin']);
    for (const item of items) {
      expect(item.id).toMatch(/^usage-live-[0-9a-f]{16}$/);
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('usage-live-alerts.jsonl');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
      // The writer's free-text message field — which embeds sign-in URLs — never reaches a prompt.
      expect(item.prompt).not.toContain(' is at ');
    }
    const [cap, expire, signin] = items;
    expect(cap!.title).toContain('claude-max');
    expect(cap!.title).toContain('cap');
    expect(cap!.prompt).toContain('95%');
    expect(cap!.prompt).toContain('owner-only');
    expect(expire!.title).toContain('zai');
    expect(expire!.title).toContain('unspent');
    expect(expire!.prompt).toContain('expire');
    expect(signin!.title).toContain('gemini');
    expect(signin!.title).toContain('sign-in');
    expect(signin!.prompt).toContain('sign-in');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await usageLiveAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'usage-live-alerts.jsonl'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'runs', 'bus', 'usage-live-alerts.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await usageLiveAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Another repository never inherits this install's usage journal.
    const thin = alertSeries({ days: 3, perDay: 3 });
    const thinPath = await journal('alerts-thin', thin);
    expect(await usageLiveAlertsBacklogItems({ repo: 'ashlrai/lexicon', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await usageLiveAlertsBacklogItems({ repo: '', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await usageLiveAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPath, now: NOW })).not.toEqual([]);

    // Rows below the recurring bars emit nothing.
    const sparse = [
      alertRow({ atMs: NOW_MS - DAY, resetAt: iso(NOW_MS + DAY) }),
      alertRow({ atMs: NOW_MS - 2 * DAY, resetAt: iso(NOW_MS + 2 * DAY) }),
      'not json at all',
    ];
    const sparsePath = await journal('alerts-sparse', sparse);
    expect(await usageLiveAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: sparsePath, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = alertSeries({ days: 3, perDay: 2 });
    // Pad past the 512 KiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(600 * 1024);
    const path = await journal('alerts-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await usageLiveAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...alertSeries({ level: 'cap-95', subject: 'claude-max', days: 2, perDay: 2 }),
      ...alertSeries({ level: 'cap-95', subject: 'devin', days: 3, perDay: 2 }),
      ...alertSeries({ level: 'cap-80', subject: 'zai', days: 2, perDay: 3, pct: 82 }),
    ];
    const path = await journal('alerts-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await usageLiveAlertsBacklogItems(opts);
    const second = await usageLiveAlertsBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(3);
    const limited = await usageLiveAlertsBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends usage-live alert items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The journal's writer path is <runs>/bus — ASHLR_RUNS_DIR wins when
    // absolute, else ~/.ashlr-runs under the relocated HOME.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const busDir = join(home, '.ashlr-runs', 'bus');
    await mkdir(busDir, { recursive: true });
    const liveRows = [
      // cap-95 on claude-max: 3 rows, 2 days, 2 reset windows.
      alertRow({ atMs: at(0), level: 'cap-95', subject: 'claude-max', pct: 97, resetAt: iso(realNow + DAY) }),
      alertRow({ atMs: at(1), level: 'cap-95', subject: 'claude-max', pct: 96, resetAt: iso(realNow + 2 * DAY) }),
      alertRow({ atMs: at(2), level: 'cap-95', subject: 'claude-max', pct: 98, resetAt: iso(realNow + DAY) }),
      // needs-signin on gemini: 3 rows on 3 distinct days.
      alertRow({ atMs: at(0, 1), level: 'needs-signin', subject: 'gemini', pct: null, resetAt: null }),
      alertRow({ atMs: at(1, 1), level: 'needs-signin', subject: 'gemini', pct: null, resetAt: null }),
      alertRow({ atMs: at(2, 1), level: 'needs-signin', subject: 'gemini', pct: null, resetAt: null }),
      // A sparse cell that stays below the bars.
      alertRow({ atMs: at(0, 2), level: 'cap-80', subject: 'zai', pct: 81, resetAt: iso(realNow + DAY) }),
      alertRow({ atMs: at(1, 2), level: 'cap-80', subject: 'zai', pct: 80, resetAt: iso(realNow + 2 * DAY) }),
    ];
    await writeFile(join(busDir, 'usage-live-alerts.jsonl'), liveRows.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const journalItems = first.items.filter((i) => i.id.startsWith('usage-live-'));
    expect(journalItems).toHaveLength(2);
    expect(journalItems.map((i) => i.area)).toEqual(['usage-live-cap', 'usage-live-signin']);
    expect(journalItems[0]!.title).toContain('claude-max');
    expect(journalItems[1]!.title).toContain('gemini');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(journalItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('usage-live-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('usage-live-'))).toHaveLength(2);
  });
});
