import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  capacityHistoryBacklogItems,
  foldCapacityHistoryRows,
  parseCapacityHistoryJournal,
} from '../src/core/improve/capacity-history-backlog.js';
import { HISTORY_MAX_SERIES } from '../src/core/routing/capacity-history.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-caphist-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
/** ISO timestamp `days` before NOW (each integral value is a distinct UTC day). */
const at = (days: number): string => new Date(NOW.getTime() - days * 86400_000).toISOString();

const REPO = 'ashlrai/phantom';

type Window = 'session' | 'weekly';
interface Row {
  ts?: string;
  seat?: string;
  window?: string;
  usedPct?: number;
  resetsAt?: string | null;
  source?: string;
}

const row = (seat: string, window: Window, days: number, extra: Omit<Row, 'ts' | 'seat' | 'window'> = {}): Row => ({
  ts: at(days), seat, window, usedPct: 42.5, source: 'daemon', ...extra,
});

const journal = (rows: Array<Row | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<Row | string> | string): string => {
  const dir = path.join(home, '.ashlr', 'routing');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'capacity-history.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

/**
 * 'claude:pro'/'weekly' records on the three oldest days then stops while
 * 'codex:team'/'session' keeps every file-active day through yesterday —
 * two missed days for the dark series, none for the live one.
 */
const darkRows = (): Row[] => [
  row('claude:pro', 'weekly', 5), row('claude:pro', 'weekly', 4), row('claude:pro', 'weekly', 3),
  row('codex:team', 'session', 5), row('codex:team', 'session', 4), row('codex:team', 'session', 3),
  row('codex:team', 'session', 2), row('codex:team', 'session', 1),
];

describe('parseCapacityHistoryJournal', () => {
  it('validates rows against the store contract and counts contract failures', () => {
    const parsed = parseCapacityHistoryJournal(journal([
      'not json',
      '{"ts":"soon","seat":"claude:pro","window":"weekly","usedPct":10,"source":"daemon"}',
      '{"ts":"' + at(1) + '","seat":"bad seat!","window":"weekly","usedPct":10,"source":"daemon"}',
      '{"ts":"' + at(1) + '","seat":"claude:pro","window":"monthly","usedPct":10,"source":"daemon"}',
      '{"ts":"' + at(1) + '","seat":"claude:pro","window":"weekly","usedPct":140,"source":"daemon"}',
      '{"ts":"' + at(1) + '","seat":"claude:pro","window":"weekly","usedPct":10,"source":"browser"}',
      row('claude:pro', 'weekly', 1, { resetsAt: at(0) }),
      row('devin', 'session', 1, { source: 'verse' }),
    ]), NOW.getTime());
    expect(parsed.corrupt).toBe(6);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ seat: 'claude:pro', window: 'weekly' });
    expect(parsed.rows[1]).toMatchObject({ seat: 'devin', window: 'session' });
  });

  it('drops rows outside the keep window and past the future skew without counting them corrupt', () => {
    const parsed = parseCapacityHistoryJournal(journal([
      row('claude:pro', 'weekly', 9),
      { ts: new Date(NOW.getTime() + 30 * 60_000).toISOString(), seat: 'claude:pro', window: 'weekly', usedPct: 10, source: 'daemon' },
      row('claude:pro', 'weekly', 1),
    ]), NOW.getTime());
    expect(parsed.corrupt).toBe(0);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.seat).toBe('claude:pro');
  });
});

describe('foldCapacityHistoryRows', () => {
  it('marks file-active days and counts each series\' missed days after its first row', () => {
    const parsed = parseCapacityHistoryJournal(journal(darkRows()), NOW.getTime());
    const fold = foldCapacityHistoryRows(parsed.rows, parsed.corrupt);
    expect(fold.fileActiveDays.size).toBe(5);
    expect(fold.series.size).toBe(2);
    const dark = fold.series.get('claude:pro#weekly');
    expect(dark).toBeDefined();
    expect(dark!.days.size).toBe(3);
    expect(dark!.missedDays).toBe(2);
    const live = fold.series.get('codex:team#session');
    expect(live!.missedDays).toBe(0);
    expect(fold.newestMs).toBe(Date.parse(at(1)));
  });
});

describe('capacityHistoryBacklogItems', () => {
  it('emits a series-dark item at two missed file-active days and stays quiet at one', async () => {
    const items = await capacityHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(darkRows()), now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^capacity-history-series-dark-/);
    expect(items[0]!.title).toContain('claude:pro');
    expect(items[0]!.prompt).toContain('2 file-active UTC day(s)');
    expect(items[0]!.area).toBe('capacity-history');

    // Same shape but the dark series misses only one file-active day → below the bar.
    const oneMissRows: Row[] = [
      row('claude:pro', 'weekly', 4), row('claude:pro', 'weekly', 3), row('claude:pro', 'weekly', 2),
      row('codex:team', 'session', 4), row('codex:team', 'session', 3), row('codex:team', 'session', 2),
      row('codex:team', 'session', 1),
    ];
    const quiet = await capacityHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(oneMissRows), now: NOW });
    expect(quiet).toEqual([]);
  });

  it('emits recorder-stale only when the newest valid row is over a day old', async () => {
    const stale = await capacityHistoryBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row('claude:pro', 'weekly', 3), row('claude:pro', 'weekly', 2)]),
    });
    expect(stale.map((i) => i.id)).toEqual([expect.stringMatching(/^capacity-history-recorder-stale-/)]);
    expect(stale[0]!.prompt).toContain('over a day old');

    // A fresh row anywhere in the tail keeps the recorder healthy.
    const fresh = await capacityHistoryBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row('claude:pro', 'weekly', 3), row('codex:team', 'session', 0)]),
    });
    expect(fresh.filter((i) => i.id.includes('recorder-stale'))).toEqual([]);
  });

  it('emits corrupt-lines at three contract failures and stays quiet below', async () => {
    const twoBad = await capacityHistoryBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row('claude:pro', 'weekly', 1), 'not json', '{"ts":"bad"}']),
    });
    expect(twoBad.filter((i) => i.id.includes('corrupt-lines'))).toEqual([]);

    const items = await capacityHistoryBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row('claude:pro', 'weekly', 1),
        'not json',
        '{"ts":"bad"}',
        '   ',
        '{"ts":"' + at(1) + '","seat":"claude:pro","window":"weekly","usedPct":"high","source":"daemon"}',
      ]),
    });
    const corrupt = items.filter((i) => i.id.includes('corrupt-lines'));
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]!.prompt).toContain('3 line(s)');
  });

  it('emits series-overflow past the API series bound', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < HISTORY_MAX_SERIES + 1; i += 1) {
      rows.push(row(`seat${String(i).padStart(2, '0')}`, 'session', 0));
    }
    const items = await capacityHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    const overflow = items.filter((i) => i.id.includes('series-overflow'));
    expect(overflow).toHaveLength(1);
    expect(overflow[0]!.prompt).toContain(`${HISTORY_MAX_SERIES + 1} distinct seat-window series`);

    const under = rows.slice(0, HISTORY_MAX_SERIES);
    const quiet = await capacityHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(under), now: NOW });
    expect(quiet.filter((i) => i.id.includes('series-overflow'))).toEqual([]);
  });

  it('stays quiet on healthy, missing and empty journals', async () => {
    const healthy = darkRows().concat([row('claude:pro', 'weekly', 2), row('claude:pro', 'weekly', 1)]);
    expect(await capacityHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(healthy), now: NOW })).toEqual([]);
    expect(await capacityHistoryBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    expect(await capacityHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(''), now: NOW })).toEqual([]);
  });

  it('emits only for the fleet repository', async () => {
    const file = writeJournal(darkRows());
    expect(await capacityHistoryBacklogItems({ repo: 'ashlrai/lexicon', journalPath: file, now: NOW })).toEqual([]);
    expect(await capacityHistoryBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await capacityHistoryBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
    const items = await capacityHistoryBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal(darkRows());
    const first = await capacityHistoryBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await capacityHistoryBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = writeJournal([...darkRows(), row('claude:pro', 'weekly', 1)]);
    const third = await capacityHistoryBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    // claude:pro/weekly now records day 1 too → missed drops to 1 → item gone.
    expect(third).toEqual([]);
  });

  it('honours the item limit and sorts strongest evidence first', async () => {
    const rows: Row[] = [
      ...darkRows(),
      // A second dark series missing three days outranks the two-day one.
      row('extra:seat', 'session', 5), row('extra:seat', 'session', 4),
    ];
    const items = await capacityHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 1 });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('extra:seat');
  });

  it('reads the default journal path under the Phantom home', async () => {
    writeJournal(darkRows());
    const items = await capacityHistoryBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^capacity-history-series-dark-/);
  });

  it('appends capacity-history items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      writeJournal(darkRows());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const folded = first.items.filter((i) => i.id.startsWith('capacity-history-'));
      expect(folded).toHaveLength(1);
      expect(folded[0]!.id).toMatch(/^capacity-history-series-dark-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(folded)).toBe(folded.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('capacity-history-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('capacity-history-'))).toHaveLength(folded.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
