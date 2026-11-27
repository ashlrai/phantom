import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldResetReleaseRows,
  parseResetReleaseJournal,
  resetReleaseBacklogItems,
} from '../src/core/improve/reset-release-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-resetrel-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
/** ISO timestamp `days` before NOW (fractional hours allowed via `hours`). */
const at = (days: number, hours = 0): string =>
  new Date(NOW.getTime() - days * 86400_000 + hours * 3600_000).toISOString();
/** readingAsOf `hoursAgo` hours before the row's own `at`. */
const readingAt = (days: number, hoursAgo: number): string =>
  new Date(NOW.getTime() - days * 86400_000 - hoursAgo * 3600_000).toISOString();

const REPO = 'ashlrai/phantom';

type State = 'reset-detected' | 'reset-time-passed' | 'hold-expired';
interface Row {
  at?: string;
  lane?: string;
  state?: string;
  usedPct?: number | null;
  readingAsOf?: string | null;
  by?: string;
  v?: number;
}

const row = (lane: string, state: State, days: number, extra: Omit<Row, 'at' | 'lane' | 'state'> = {}): Row => ({
  v: 1, at: at(days), by: 'reset-detect', reason: 'audit', lane, state, ...extra,
});

const journal = (rows: Array<Row | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<Row | string> | string): string => {
  const dir = path.join(home, 'runs', 'queue');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'reset-releases.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

/** Three 'hold-expired' releases on lane 'work' across two UTC days. */
const expiredRows = (lane = 'work'): Row[] => [
  row(lane, 'hold-expired', 1, { usedPct: 80, readingAsOf: readingAt(1, 1) }),
  row(lane, 'hold-expired', 2, { usedPct: null, readingAsOf: null }),
  row(lane, 'hold-expired', 4, { usedPct: 12, readingAsOf: readingAt(4, 2) }),
];

/** Three 'reset-time-passed' releases on lane 'fast' across two UTC days. */
const timePassedRows = (lane = 'fast'): Row[] => [
  row(lane, 'reset-time-passed', 1),
  row(lane, 'reset-time-passed', 3),
  row(lane, 'reset-time-passed', 5),
];

describe('parseResetReleaseJournal', () => {
  it('validates rows against the writer contract and skips malformed lines', () => {
    const rows = parseResetReleaseJournal(journal([
      'not json',
      '{"v":1,"at":"soon","by":"reset-detect","lane":"work","state":"hold-expired"}',
      '{"v":2,"at":"' + at(1) + '","by":"reset-detect","lane":"work","state":"hold-expired"}',
      '{"v":1,"at":"' + at(1) + '","by":"someone-else","lane":"work","state":"hold-expired"}',
      '{"v":1,"at":"' + at(1) + '","by":"reset-detect","lane":"bad lane!","state":"hold-expired"}',
      '{"v":1,"at":"' + at(1) + '","by":"reset-detect","lane":"work","state":"bogus"}',
      row('work', 'hold-expired', 1, { usedPct: 42.5, readingAsOf: readingAt(1, 0.5) }),
      { v: 1, at: at(1), by: 'reset-detect', lane: 'mid', state: 'reset-detected', usedPct: 'high' },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ lane: 'work', state: 'hold-expired', usedPct: 42.5 });
    expect(rows[0]!.readingMs).not.toBeNull();
    expect(rows[1]).toMatchObject({ lane: 'mid', state: 'reset-detected', usedPct: null, readingMs: null });
  });
});

describe('foldResetReleaseRows', () => {
  it('classifies states per lane and never folds detected rows as adverse', () => {
    const fold = foldResetReleaseRows(parseResetReleaseJournal(journal([
      row('work', 'reset-detected', 1),
      row('work', 'hold-expired', 1),
      row('work', 'reset-time-passed', 2),
      row('fast', 'hold-expired', 3),
    ])), NOW.getTime());
    const work = fold.get('work')!;
    expect(work.total).toBe(3);
    expect(work.detected).toBe(1);
    expect(work.expired.rows).toBe(1);
    expect(work.timePassed.rows).toBe(1);
    expect(fold.get('fast')!.expired.rows).toBe(1);
    expect(fold.get('fast')!.detected).toBe(0);
  });

  it('buckets expiry rows by recorded-reading freshness', () => {
    const fold = foldResetReleaseRows(parseResetReleaseJournal(journal([
      // fresh (1h before release) and still above the 25% bar
      row('work', 'hold-expired', 1, { usedPct: 80, readingAsOf: readingAt(1, 1) }),
      // fresh (30m) and at/below the bar
      row('work', 'hold-expired', 2, { usedPct: 12, readingAsOf: readingAt(2, 0.5) }),
      // stale (5h) — outside the 3h runway bound
      row('work', 'hold-expired', 3, { usedPct: 90, readingAsOf: readingAt(3, 5) }),
      // no reading at all
      row('work', 'hold-expired', 4, { usedPct: null, readingAsOf: null }),
      // fresh reading but unusable usedPct
      row('work', 'hold-expired', 5, { usedPct: null, readingAsOf: readingAt(5, 1) }),
    ])), NOW.getTime());
    const e = fold.get('work')!.expired;
    expect(e.rows).toBe(5);
    expect(e.freshExhausted).toBe(1);
    expect(e.freshBelow).toBe(1);
    expect(e.blind).toBe(3);
  });

  it('drops rows outside the window and past the future skew', () => {
    const fold = foldResetReleaseRows(parseResetReleaseJournal(journal([
      row('work', 'hold-expired', 10),
      row('work', 'hold-expired', -1),
      row('work', 'hold-expired', -3),
      row('work', 'hold-expired', 1),
    ])), NOW.getTime());
    expect(fold.get('work')!.expired.rows).toBe(1);
  });
});

describe('resetReleaseBacklogItems', () => {
  it('turns recurring hold-expired releases into a valid priority-3 backlog item', async () => {
    const items = await resetReleaseBacklogItems({ repo: REPO, journalPath: writeJournal(expiredRows()), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^reset-release-hold-expired-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'reset-release' });
    expect(item.title).toContain("'work'");
    expect(item.prompt).toContain("'hold-expired' release(s) for lane 'work' across 3 distinct UTC day(s)");
    expect(item.prompt).toContain("still above the detector's 25% reset bar");
    expect(item.prompt).toContain('1 carried a fresh recorded reading');
    expect(item.prompt).toContain('1 had no fresh usable reading');
    expect(item.prompt).toContain('reset-releases.jsonl');
    expect(item.prompt).toContain('usage-reset-release.ts');
    expect(item.prompt).toContain('no-change');
  });

  it('keeps hold-expired quiet below the row or day bar', async () => {
    const few = await resetReleaseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row('work', 'hold-expired', 1), row('work', 'hold-expired', 3)]),
    });
    expect(few).toEqual([]);
    const oneDay = await resetReleaseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row('work', 'hold-expired', 1), row('work', 'hold-expired', 1), row('work', 'hold-expired', 1),
      ]),
    });
    expect(oneDay).toEqual([]);
  });

  it('turns recurring reset-time-passed releases into a reset-time-passed item', async () => {
    const items = await resetReleaseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([...timePassedRows(), row('fast', 'reset-detected', 2)]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^reset-release-reset-time-passed-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain("'reset-time-passed' release(s) for lane 'fast'");
    expect(item.prompt).toContain("1 'reset-detected'");
    expect(item.prompt).toContain('resetAt');
  });

  it('emits both cell kinds and orders by recorded rows then lane', async () => {
    const rows: Row[] = [
      ...expiredRows('work'),
      ...timePassedRows('fast'),
      ...timePassedRows('mid'),
    ];
    const items = await resetReleaseBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items).toHaveLength(3);
    // Equal row counts: lane name breaks the tie — fast, mid, work.
    const lanes = items.map((i) => (i.prompt.match(/lane '([^']+)'/) ?? [])[1]);
    expect(lanes).toEqual(['fast', 'mid', 'work']);
    expect(items[0]!.id).toMatch(/^reset-release-reset-time-passed-/);
    expect(items[2]!.id).toMatch(/^reset-release-hold-expired-/);
    const again = await resetReleaseBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('honours the item limit', async () => {
    const rows: Row[] = [
      ...expiredRows('aaa'),
      ...expiredRows('bbb'),
      ...timePassedRows('ccc'),
    ];
    const items = await resetReleaseBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 2 });
    expect(items).toHaveLength(2);
  });

  it('stays quiet on detected-only, out-of-window and malformed journals', async () => {
    expect(await resetReleaseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row('work', 'reset-detected', 1), row('work', 'reset-detected', 2), row('work', 'reset-detected', 4)]),
    })).toEqual([]);
    const stale = expiredRows().map((r) => ({ ...r, at: at(10) }));
    expect(await resetReleaseBacklogItems({ repo: REPO, journalPath: writeJournal(stale), now: NOW })).toEqual([]);
    expect(await resetReleaseBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    expect(await resetReleaseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal(['not json', '{"v":1,"at":"bad"}', row('work', 'hold-expired', 1)]),
    })).toEqual([]);
  });

  it('drops rows stamped past the evaluation-time future skew', async () => {
    const future = await resetReleaseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row('work', 'hold-expired', -1), row('work', 'hold-expired', -2), row('work', 'hold-expired', -4),
      ]),
    });
    expect(future).toEqual([]);
    // Two in-window rows plus one beyond the skew stays below the bar.
    const stretched = await resetReleaseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row('work', 'hold-expired', 1), row('work', 'hold-expired', 2), row('work', 'hold-expired', -1),
      ]),
    });
    expect(stretched).toEqual([]);
    // A stamp inside the skew still counts: 1/120 h = 30 s ahead of NOW.
    const drift = await resetReleaseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row('work', 'hold-expired', 1), row('work', 'hold-expired', 2),
        { ...row('work', 'hold-expired', 0), at: at(0, 1 / 120) },
      ]),
    });
    expect(drift).toHaveLength(1);
  });

  it('emits only for the fleet repository', async () => {
    const file = writeJournal(expiredRows());
    expect(await resetReleaseBacklogItems({ repo: 'ashlrai/lexicon', journalPath: file, now: NOW })).toEqual([]);
    expect(await resetReleaseBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await resetReleaseBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
    const items = await resetReleaseBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal(expiredRows());
    const first = await resetReleaseBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await resetReleaseBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = writeJournal([...expiredRows(), row('work', 'hold-expired', 5)]);
    const third = await resetReleaseBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('reads the default journal path under the runs dir', async () => {
    process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
    writeJournal(expiredRows());
    const items = await resetReleaseBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^reset-release-hold-expired-/);
  });

  it('appends reset-release items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
      writeJournal(expiredRows());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const folded = first.items.filter((i) => i.id.startsWith('reset-release-'));
      expect(folded).toHaveLength(1);
      expect(folded[0]!.id).toMatch(/^reset-release-hold-expired-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(folded)).toBe(folded.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('reset-release-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('reset-release-'))).toHaveLength(folded.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
