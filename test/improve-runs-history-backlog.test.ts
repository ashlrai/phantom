import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldRunsHistorySamples,
  parseRunsHistoryJournal,
  parseRunsHistorySample,
  RUNS_HISTORY_MIN_ADVERSE,
  RUNS_HISTORY_MIN_DAYS,
  runsHistoryBacklogItems,
} from '../src/core/improve/runs-history-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string; ASHLR_RUNS_HISTORY_FILE?: string };
beforeEach(() => {
  saved = {
    HOME: process.env.HOME,
    ASHLR_HOME: process.env.ASHLR_HOME,
    ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR,
    ASHLR_RUNS_HISTORY_FILE: process.env.ASHLR_RUNS_HISTORY_FILE,
  };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  delete process.env.ASHLR_RUNS_HISTORY_FILE;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-runshist-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
/** ISO timestamp `days` days and `hours` hours before NOW (each integral day is a distinct UTC day). */
const ts = (days: number, hours = 0): string =>
  new Date(NOW.getTime() - days * 86400_000 - hours * 3600_000).toISOString();

const REPO = 'ashlrai/phantom';

interface LaneRow { lane: string; running: number; target: number; queued: number; held?: boolean }
interface Sample {
  at: string;
  lanes: LaneRow[];
  workers: number | null;
  leaders: number | null;
  paused: boolean | null;
}

const lane = (name: string, running: number, target: number, queued: number, held = false): LaneRow =>
  ({ lane: name, running, target, queued, held });
const sample = (days: number, hours: number, lanes: LaneRow[], extra: Partial<Sample> = {}): Sample => ({
  at: ts(days, hours), lanes, workers: 2, leaders: 1, paused: false, ...extra,
});

const journal = (rows: Array<Sample | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<Sample | string> | string): string => {
  const dir = path.join(home, '.ashlr', 'fleet');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'runs-history.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

/**
 * Lane 'fast' starved (queued 5, running 1 of target 4) on four samples
 * each of the two most recent UTC days — eight adverse records across
 * two days, past every recurring bar.
 */
const starvedRows = (): Sample[] => [
  ...[0, 1, 2, 3].map((h) => sample(1, h, [lane('fast', 1, 4, 5)])),
  ...[0, 1, 2, 3].map((h) => sample(0, h, [lane('fast', 1, 4, 5)])),
];

describe('parseRunsHistorySample', () => {
  it('validates rows against the writer contract', () => {
    const good = parseRunsHistorySample(JSON.parse(JSON.stringify(sample(0, 0, [lane('fast', 1, 4, 5, true)], { paused: true }))));
    expect(good).toMatchObject({ workers: 2, leaders: 1, paused: true });
    expect(good!.lanes[0]).toMatchObject({ lane: 'fast', running: 1, target: 4, queued: 5, held: true });
    // workers/leaders may be null (unhealthy read); paused may be null.
    expect(parseRunsHistorySample({ at: ts(0), lanes: [], workers: null, leaders: null, paused: null })).not.toBeNull();
  });

  it('rejects off-contract shapes the writer never emits', () => {
    const base = sample(0, 0, [lane('fast', 1, 4, 5)]);
    const bad: unknown[] = [
      'not json',
      { ...base, at: 'soon' },
      { ...base, at: 'x'.repeat(65) },
      { ...base, lanes: 'fast' },
      { ...base, lanes: [{ lane: 'fast', running: -1, target: 4, queued: 5, held: false }] },
      { ...base, lanes: [{ lane: 'fast', running: 1.5, target: 4, queued: 5, held: false }] },
      { ...base, lanes: [{ lane: 'f'.repeat(81), running: 1, target: 4, queued: 5, held: false }] },
      { ...base, lanes: [{ lane: 'fast', running: 1, target: 4, queued: 5, held: 'yes' }] },
      { ...base, workers: 'two' },
      { ...base, leaders: -1 },
      { ...base, paused: 'yes' },
      { ...base, lanes: Array.from({ length: 65 }, (_, i) => lane(`l${i}`, 0, 1, 0)) },
      42,
      null,
    ];
    for (const value of bad) expect(parseRunsHistorySample(value)).toBeNull();
  });
});

describe('parseRunsHistoryJournal', () => {
  it('validates rows against the store contract and counts contract failures', () => {
    const parsed = parseRunsHistoryJournal(journal([
      'not json',
      JSON.stringify({ at: 'soon', lanes: [], workers: 1, leaders: 1, paused: false }),
      JSON.stringify({ at: ts(1), lanes: [{ lane: '', running: 1, target: 4, queued: 5, held: false }], workers: 1, leaders: 1, paused: false }),
      sample(1, 0, [lane('fast', 1, 4, 5)]),
      sample(0, 0, [lane('mid', 2, 2, 0)], { workers: null, leaders: null, paused: null }),
    ]), NOW.getTime());
    expect(parsed.corrupt).toBe(3);
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.samples[0]!.lanes[0]!.lane).toBe('fast');
    expect(parsed.samples[1]!.workers).toBeNull();
  });

  it('drops rows outside the keep window and past the future skew without counting them corrupt', () => {
    const parsed = parseRunsHistoryJournal(journal([
      sample(8, 0, [lane('fast', 1, 4, 5)]),
      sample(0, -1, [lane('fast', 1, 4, 5)]), // one hour in the future: past skew
      sample(0, 0, [lane('fast', 1, 4, 5)]),
    ]), NOW.getTime());
    expect(parsed.corrupt).toBe(0);
    expect(parsed.samples).toHaveLength(1);
    expect(parsed.samples[0]!.utcDay).toBe('2026-11-23');
  });
});

describe('foldRunsHistorySamples', () => {
  it('folds per-lane starved, held and fleet paused evidence', () => {
    const parsed = parseRunsHistoryJournal(journal([
      ...starvedRows(),
      // A healthy sample for another lane, plus one held-with-queue lane.
      sample(1, 5, [lane('fast', 4, 4, 0), lane('held-lane', 0, 2, 3, true)]),
      sample(0, 4, [lane('fast', 4, 4, 0), lane('held-lane', 0, 2, 3, true)]),
      // Paused samples: two with queued work on their own lane.
      sample(1, 6, [lane('waiter', 0, 4, 2)], { paused: true }),
      sample(0, 5, [lane('waiter', 0, 4, 2)], { paused: true }),
      // Duplicate lane names in one sample fold the first row only.
      sample(0, 3, [lane('dup', 0, 2, 9), lane('dup', 2, 2, 0)]),
    ]), NOW.getTime());
    const fold = foldRunsHistorySamples(parsed.samples, parsed.corrupt);
    expect(fold.samples).toBe(parsed.samples.length);
    expect(fold.newestMs).toBe(Date.parse(ts(0, 0)));

    const fast = fold.lanes.get('fast')!;
    expect(fast.starved).toBe(RUNS_HISTORY_MIN_ADVERSE);
    expect(fast.starvedDays.size).toBe(RUNS_HISTORY_MIN_DAYS);
    expect(fast.underTarget).toBe(RUNS_HISTORY_MIN_ADVERSE);
    expect(fast.zeroTarget).toBe(0);
    expect(fast.maxQueued).toBe(5);

    const heldLane = fold.lanes.get('held-lane')!;
    expect(heldLane.held).toBe(2);
    expect(heldLane.heldDays.size).toBe(2);

    expect(fold.pausedSamples).toBe(2);
    expect(fold.pausedDays.size).toBe(2);
    expect(fold.pausedWithQueue).toBe(2);

    const dup = fold.lanes.get('dup')!;
    expect(dup.samples).toBe(1);
    expect(dup.starved).toBe(1); // first row (queued 9, running 0 < target 2) won
    expect(dup.maxQueued).toBe(9);
  });
});

describe('runsHistoryBacklogItems', () => {
  it('emits a lane-starved item at the recurring bar and stays quiet below', async () => {
    const items = await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(starvedRows()), now: NOW });
    const starved = items.filter((i) => i.id.includes('lane-starved'));
    expect(starved).toHaveLength(1);
    expect(starved[0]!.id).toMatch(/^runs-history-lane-starved-/);
    expect(starved[0]!.title).toContain('fast');
    expect(starved[0]!.prompt).toContain('under-target');
    expect(starved[0]!.prompt).toContain('8');
    expect(starved[0]!.area).toBe('runs-history');

    // Seven adverse samples → below the bar.
    const seven = starvedRows().slice(0, RUNS_HISTORY_MIN_ADVERSE - 1);
    const quiet = await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(seven), now: NOW });
    expect(quiet.filter((i) => i.id.includes('lane-starved'))).toEqual([]);

    // Eight adverse samples all on one UTC day → no recurrence.
    const oneDay = [0, 1, 2, 3, 4, 5, 6, 7].map((h) => sample(0, h, [lane('fast', 1, 4, 5)]));
    const flat = await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(oneDay), now: NOW });
    expect(flat.filter((i) => i.id.includes('lane-starved'))).toEqual([]);
  });

  it('splits zero-target starvation in the prompt', async () => {
    const rows = [
      ...[0, 1, 2, 3].map((h) => sample(1, h, [lane('cold', 0, 0, 3)])),
      ...[0, 1, 2, 3].map((h) => sample(0, h, [lane('cold', 0, 0, 3)])),
    ];
    const items = await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    const starved = items.filter((i) => i.id.includes('lane-starved'));
    expect(starved).toHaveLength(1);
    expect(starved[0]!.prompt).toContain('zero-target');
  });

  it('does not count a lane at target with queued work as starved', async () => {
    const rows = [
      ...[0, 1, 2, 3].map((h) => sample(1, h, [lane('busy', 4, 4, 9)])),
      ...[0, 1, 2, 3].map((h) => sample(0, h, [lane('busy', 4, 4, 9)])),
    ];
    const items = await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items.filter((i) => i.id.includes('lane-starved'))).toEqual([]);
  });

  it('emits lane-held for a hold standing while work waits', async () => {
    const rows = [
      ...[0, 1, 2, 3].map((h) => sample(1, h, [lane('fast', 0, 4, 5, true)])),
      ...[0, 1, 2, 3].map((h) => sample(0, h, [lane('fast', 0, 4, 5, true)])),
    ];
    const items = await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    const held = items.filter((i) => i.id.includes('lane-held'));
    expect(held).toHaveLength(1);
    expect(held[0]!.title).toContain('fast');
    expect(held[0]!.prompt).toContain('held === true');

    // Held with an empty queue blocks nothing.
    const idle = rows.map((r) => ({ ...r, lanes: r.lanes.map((l) => ({ ...l, queued: 0 })) }));
    const quiet = await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(idle), now: NOW });
    expect(quiet.filter((i) => i.id.includes('lane-held'))).toEqual([]);
  });

  it('emits fleet-paused only when paused samples recorded queued work', async () => {
    const pausedRows = (queued: number): Sample[] => [
      ...[0, 1, 2, 3].map((h) => sample(1, h, [lane('fast', 0, 4, queued)], { paused: true })),
      ...[0, 1, 2, 3].map((h) => sample(0, h, [lane('fast', 0, 4, queued)], { paused: true })),
    ];
    const items = await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(pausedRows(3)), now: NOW });
    const paused = items.filter((i) => i.id.includes('fleet-paused'));
    expect(paused).toHaveLength(1);
    expect(paused[0]!.prompt).toContain('paused === true');

    const empty = await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(pausedRows(0)), now: NOW });
    expect(empty).toEqual([]);
  });

  it('emits corrupt-lines at three contract failures and stays quiet below', async () => {
    const twoBad = await runsHistoryBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([sample(0, 0, [lane('fast', 1, 4, 5)]), 'not json', '{"at":"bad"}']),
    });
    expect(twoBad.filter((i) => i.id.includes('corrupt-lines'))).toEqual([]);

    const items = await runsHistoryBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        sample(0, 0, [lane('fast', 1, 4, 5)]),
        'not json',
        '{"at":"bad"}',
        '   ',
        JSON.stringify({ at: ts(0), lanes: [{ lane: 'x', running: 'high', target: 4, queued: 5, held: false }], workers: 1, leaders: 1, paused: false }),
      ]),
    });
    const corrupt = items.filter((i) => i.id.includes('corrupt-lines'));
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]!.prompt).toContain('3 non-blank line(s)');
  });

  it('stays quiet on healthy, missing and empty journals', async () => {
    const healthy = [
      ...[0, 1, 2, 3].map((h) => sample(1, h, [lane('fast', 4, 4, 0)])),
      ...[0, 1, 2, 3].map((h) => sample(0, h, [lane('fast', 4, 4, 0)])),
    ];
    expect(await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(healthy), now: NOW })).toEqual([]);
    expect(await runsHistoryBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    expect(await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(''), now: NOW })).toEqual([]);
  });

  it('emits only for the fleet repository', async () => {
    const file = writeJournal(starvedRows());
    expect(await runsHistoryBacklogItems({ repo: 'ashlrai/lexicon', journalPath: file, now: NOW })).toEqual([]);
    expect(await runsHistoryBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await runsHistoryBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
    const items = await runsHistoryBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal(starvedRows());
    const first = await runsHistoryBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await runsHistoryBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // A lane that fills its target stops re-adding: all samples healthy now.
    const grown = writeJournal([
      ...[0, 1, 2, 3].map((h) => sample(0, h, [lane('fast', 4, 4, 0)])),
    ]);
    const third = await runsHistoryBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third).toEqual([]);
  });

  it('honours the item limit and sorts strongest evidence first', async () => {
    const rows: Sample[] = [
      ...starvedRows(),
      // A second starved lane with more adverse samples outranks 'fast'.
      ...[0, 1, 2, 3, 4, 5].map((h) => sample(1, h, [lane('slow', 0, 2, 7)])),
      ...[0, 1, 2, 3, 4, 5].map((h) => sample(0, h, [lane('slow', 0, 2, 7)])),
    ];
    const items = await runsHistoryBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 1 });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('slow');
  });

  it('reads the default journal path under the Phantom home fleet dir', async () => {
    writeJournal(starvedRows());
    const items = await runsHistoryBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^runs-history-lane-starved-/);
  });

  it('appends runs-history items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      writeJournal(starvedRows());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const folded = first.items.filter((i) => i.id.startsWith('runs-history-'));
      expect(folded).toHaveLength(1);
      expect(folded[0]!.id).toMatch(/^runs-history-lane-starved-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(folded)).toBe(folded.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('runs-history-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('runs-history-'))).toHaveLength(folded.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
