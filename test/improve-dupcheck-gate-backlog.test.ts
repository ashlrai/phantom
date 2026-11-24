import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DUPCHECK_FALSE_SKIP_MIN,
  DUPCHECK_MAX_ITEMS,
  DUPCHECK_MISSED_MIN,
  DUPCHECK_MISSED_RATE,
  DUPCHECK_WINDOW_MS,
  dupcheckGateBacklogItems,
  foldDupcheckGate,
} from '../src/core/improve/dupcheck-gate-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';

vi.mock('../src/core/improve/dupcheck-gate-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/dupcheck-gate-backlog.js')>();
  return { ...actual, dupcheckGateBacklogItems: vi.fn(actual.dupcheckGateBacklogItems) };
});

const realFeed = (await vi.importActual<typeof import('../src/core/improve/dupcheck-gate-backlog.js')>(
  '../src/core/improve/dupcheck-gate-backlog.js',
)).dupcheckGateBacklogItems;
const feedMock = vi.mocked(dupcheckGateBacklogItems);

const REPO = 'ashlrai/phantom';
const NOW = Date.parse('2026-11-23T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** One queue.dupcheck-event.v1 row in the writer's shape. */
function ev(job: string, action: string, at: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 'queue.dupcheck-event.v1', at, job, action, ...extra });
}

/** `count` distinct jobs each recorded a launch decision then an already_done outcome, spread across the window. */
function missedRows(prefix: string, count: number, decisionHoursAgo = 96, outcomeHoursAgo = 72): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const job = `${prefix}-${i}`;
    out.push(ev(job, 'launch', hoursAgo(decisionHoursAgo - i * 6)));
    out.push(ev(job, 'outcome', hoursAgo(outcomeHoursAgo - i * 6), { tag: 'already_done' }));
  }
  return out;
}

/** `count` clean let-through jobs: launch decisions inside the window, no already_done outcome. */
function cleanLaunchRows(count: number, hoursStart = 90): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(ev(`clean-${i}`, 'launch', hoursAgo(hoursStart - i)));
  return out;
}

/** `count` distinct jobs each skipped then launched later — false skips. */
function falseSkipRows(count: number, skipHoursAgo = 80, relaunchHoursAgo = 60): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const job = `skipped-${i}`;
    out.push(ev(job, 'skip', hoursAgo(skipHoursAgo - i * 5)));
    out.push(ev(job, 'launch', hoursAgo(relaunchHoursAgo - i * 5)));
  }
  return out;
}

let previousAshlrHome: string | undefined;
let previousRunsDir: string | undefined;
let home: string;
let runsDir: string;

beforeEach(() => {
  feedMock.mockReset();
  feedMock.mockImplementation(realFeed);
  previousAshlrHome = process.env.ASHLR_HOME;
  previousRunsDir = process.env.ASHLR_RUNS_DIR;
  home = mkdtempSync(join(tmpdir(), 'ashlr-dupcheck-backlog-'));
  runsDir = join(home, 'runs');
  process.env.ASHLR_HOME = home;
  process.env.ASHLR_RUNS_DIR = runsDir;
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  if (previousRunsDir === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previousRunsDir;
  rmSync(home, { recursive: true, force: true });
});

describe('dupcheckGateBacklogItems', () => {
  it('emits one valid item per recurring precision cell', async () => {
    const text = [
      ...missedRows('dup-a', 3),
      ...falseSkipRows(2),
    ].join('\n');
    const items = await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: text });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.id).toMatch(/^fleet-dupcheck-[0-9a-f]{16}$/);
      expect(item.area).toBe('fleet-dupcheck');
      expect(item.priority).toBe(3);
      expect(item.repo).toBe(REPO);
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('dupcheck.jsonl');
      expect(item.prompt).toContain('phm queue dupcheck --stats');
      expect(item.prompt).toContain('no-change');
    }
    const titles = items.map((i) => i.title).join(' | ');
    expect(titles).toContain('missing duplicates');
    expect(titles).toContain('wrong-skipping');
    const missed = items.find((i) => i.title.includes('missing duplicates'))!;
    expect(missed.prompt).toContain('3 jobs');
    expect(missed.prompt).toContain('dup-a-0');
    const skips = items.find((i) => i.title.includes('wrong-skipping'))!;
    expect(skips.prompt).toContain('2 skipped jobs');
    expect(skips.prompt).toContain('skipped-0');
  });

  it('stays quiet below the recurring bars and under the missed-rate share', async () => {
    // Two missed jobs: under DUPCHECK_MISSED_MIN.
    const twoMissed = missedRows('dup-b', 2).join('\n');
    expect(await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: twoMissed })).toEqual([]);
    // One false skip: under DUPCHECK_FALSE_SKIP_MIN.
    const oneSkip = falseSkipRows(1).join('\n');
    expect(await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: oneSkip })).toEqual([]);
    // Three misses drowned by clean let-through launches: under DUPCHECK_MISSED_RATE.
    const drowned = [...missedRows('dup-c', 3), ...cleanLaunchRows(40)].join('\n');
    expect(await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: drowned })).toEqual([]);
    // Clean ledger emits nothing.
    const clean = [...cleanLaunchRows(10), ev('s-1', 'skip', hoursAgo(50)), ev('s-2', 'warn', hoursAgo(40))].join('\n');
    expect(await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: clean })).toEqual([]);
  });

  it('splits missed launches from warned launches and counts warn let-through', async () => {
    const text = [
      ev('w-0', 'warn', hoursAgo(90)), ev('w-0', 'outcome', hoursAgo(70), { tag: 'already_done' }),
      ev('w-1', 'warn', hoursAgo(88)), ev('w-1', 'outcome', hoursAgo(68), { tag: 'already_done' }),
      ev('l-0', 'launch', hoursAgo(86)), ev('l-0', 'outcome', hoursAgo(66), { tag: 'already_done' }),
    ].join('\n');
    const items = await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: text });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('missing duplicates');
    expect(items[0]!.prompt).toContain('2 warned launches');
    expect(items[0]!.prompt).toContain('1 unflagged launches');
  });

  it('ignores evidence outside the window, malformed lines and unknown actions', async () => {
    const stale = missedRows('old', 4, 24 * 30, 24 * 29);
    const fresh = missedRows('new', 3, 96, 72);
    const mixed = [
      ...stale,
      ...fresh,
      'not json at all',
      JSON.stringify({ schema: 'other.v9', at: hoursAgo(1), job: 'x', action: 'launch' }),
      ev('bad-action', 'bogus', hoursAgo(1)),
      ev('no-at', 'launch', 'not-a-date'),
      '',
    ].join('\n');
    const items = await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: mixed });
    const missed = items.filter((i) => i.title.includes('missing duplicates'));
    expect(missed).toHaveLength(1);
    expect(missed[0]!.prompt).toContain('3 jobs');
    expect(missed[0]!.prompt).not.toContain('old-0');
    // The unparseable-at launch never anchors a cell; the bogus action is
    // corrupt evidence the fold refuses to count as a decision.
    const fold = foldDupcheckGate(mixed, { nowMs: NOW });
    // 8 stale + 6 fresh decision/outcome rows + the no-at launch = 15;
    // torn, foreign-schema, blank and unknown-action lines contribute 0.
    expect(fold.events).toBe(15);
  });

  it('mirrors summarizeDupcheck per-job semantics over sequences', () => {
    const text = [
      // skip → launch → outcome: a false skip, never a missed duplicate.
      ev('seq-1', 'skip', hoursAgo(90)), ev('seq-1', 'launch', hoursAgo(80)), ev('seq-1', 'outcome', hoursAgo(70), { tag: 'already_done' }),
      // launch → skip → outcome: first decision launch, no relaunch — a missed duplicate.
      ev('seq-2', 'launch', hoursAgo(88)), ev('seq-2', 'skip', hoursAgo(78)), ev('seq-2', 'outcome', hoursAgo(68), { tag: 'already_done' }),
      // warn after skip counts as a relaunch too.
      ev('seq-3', 'skip', hoursAgo(86)), ev('seq-3', 'warn', hoursAgo(76)),
      // skip → skip → launch: still one false skip.
      ev('seq-4', 'skip', hoursAgo(84)), ev('seq-4', 'skip', hoursAgo(74)), ev('seq-4', 'launch', hoursAgo(64)),
      // launch → outcome → later skip: outcome already recorded; skip after does not relaunch.
      ev('seq-5', 'launch', hoursAgo(82)), ev('seq-5', 'outcome', hoursAgo(72), { tag: 'already_done' }), ev('seq-5', 'skip', hoursAgo(62)),
    ].join('\n');
    const fold = foldDupcheckGate(text, { nowMs: NOW });
    expect(fold.falseSkips).toBe(3); // seq-1, seq-3, seq-4
    // seq-2 and seq-5 both launched first and ended already_done; seq-5's
    // trailing skip never becomes a relaunch because nothing non-skip
    // follows it.
    expect(fold.missedLaunched).toBe(2);
    expect(fold.missedWarned).toBe(0);
    expect(fold.letThrough).toBe(2);
  });

  it('withholds on a null or empty ledger and on another repository', async () => {
    expect(await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: null })).toEqual([]);
    expect(await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: '' })).toEqual([]);
    expect(await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: '   \n  \n' })).toEqual([]);
    const text = [...missedRows('dup-d', 3), ...falseSkipRows(2)].join('\n');
    expect(await dupcheckGateBacklogItems({ repo: 'ashlrai/other-repo', now: NOW, eventsText: text })).toEqual([]);
    // A bare repository name still matches the fleet gate but carries no owner/repo field.
    const bare = await dupcheckGateBacklogItems({ repo: 'phantom', now: NOW, eventsText: text });
    expect(bare.length).toBe(2);
    expect(bare.every((item) => item.repo === undefined)).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const text = [...missedRows('dup-e', 3), ...falseSkipRows(2)].join('\n');
    const first = await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: text });
    const second = await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: text });
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    // Shifted tallies on the same cells keep the same ids — no twin items.
    const shifted = await dupcheckGateBacklogItems({
      repo: REPO, now: NOW, eventsText: [...missedRows('dup-e', 4), ...falseSkipRows(3)].join('\n'),
    });
    expect(shifted.map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('honors the item cap', async () => {
    const text = [...missedRows('dup-f', 3), ...falseSkipRows(2)].join('\n');
    const limited = await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: text, limit: 1 });
    expect(limited).toHaveLength(1);
    const all = await dupcheckGateBacklogItems({ repo: REPO, now: NOW, eventsText: text });
    expect(all.length).toBe(2);
    expect(all.length).toBeLessThanOrEqual(DUPCHECK_MAX_ITEMS);
    expect(all.every((item) => validBacklogItem(item) !== null)).toBe(true);
  });

  it('reads the real ledger under a runs dir', async () => {
    mkdirSync(join(runsDir, 'metrics'), { recursive: true });
    writeFileSync(join(runsDir, 'metrics', 'dupcheck.jsonl'), `${[...missedRows('dup-g', 3), ...falseSkipRows(2)].join('\n')}\n`);
    const items = await dupcheckGateBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(2);
    // A missing runs dir is unknown, never zero.
    expect(await dupcheckGateBacklogItems({ repo: REPO, runsDir: join(home, 'nope'), now: NOW })).toEqual([]);
  });
});

describe('foldDupcheckGate', () => {
  it('counts windowed tallies and exposes the documented bars', () => {
    const text = [...missedRows('dup-h', 3), ...falseSkipRows(2), 'garbage'].join('\n');
    const fold = foldDupcheckGate(text, { nowMs: NOW });
    expect(fold.events).toBe(10);
    expect(fold.jobs).toBe(5);
    expect(fold.missedLaunched).toBe(3);
    expect(fold.missedWarned).toBe(0);
    expect(fold.letThrough).toBe(3);
    expect(fold.falseSkips).toBe(2);
    expect(fold.cells.map((c) => c.key)).toEqual(['missed', 'false-skips']);
    expect(DUPCHECK_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DUPCHECK_MISSED_MIN).toBe(3);
    expect(DUPCHECK_MISSED_RATE).toBe(0.1);
    expect(DUPCHECK_FALSE_SKIP_MIN).toBe(2);
    expect(DUPCHECK_MAX_ITEMS).toBeGreaterThan(0);
  });

  it('keeps a decision before the window from anchling an in-window outcome', () => {
    // Launch decided 10 days ago, outcome recorded inside the window: still
    // let-through evidence — the waste landed inside the window.
    const text = [
      ev('edge-0', 'launch', hoursAgo(24 * 10)), ev('edge-0', 'outcome', hoursAgo(48), { tag: 'already_done' }),
      ev('edge-1', 'launch', hoursAgo(24 * 10 + 1)), ev('edge-1', 'outcome', hoursAgo(47), { tag: 'already_done' }),
      ev('edge-2', 'launch', hoursAgo(24 * 10 + 2)), ev('edge-2', 'outcome', hoursAgo(46), { tag: 'already_done' }),
    ].join('\n');
    const fold = foldDupcheckGate(text, { nowMs: NOW });
    expect(fold.missedLaunched).toBe(3);
    expect(fold.letThrough).toBe(3);
  });
});

describe('discoverBacklog wiring', () => {
  const greenGh = async (args: string[]) => {
    const path = args[4] ?? '';
    if (path === 'repos/ashlrai/phantom') {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
    }
    return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
  };

  it('appends feed items through discovery and dedupes on refresh', async () => {
    const sentinel = {
      id: 'fleet-dupcheck-deadbeefdeadbeef',
      title: 'Dupcheck gate keeps missing duplicates (3 let-through jobs ended already_done)',
      prompt: 'Sentinel prompt naming the dupcheck gate evidence.',
      area: 'fleet-dupcheck',
      priority: 3 as const,
      repo: REPO,
    };
    feedMock.mockResolvedValueOnce([sentinel]);
    const first = await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
    const feedItems = first.items.filter((item) => item.id === sentinel.id);
    expect(feedItems).toHaveLength(1);
    expect(first.items.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(appendUserBacklogItems(feedItems)).toBe(1);
    feedMock.mockResolvedValueOnce([sentinel]);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((item) => item.id === sentinel.id))).toBe(0);
    expect(readUserBacklogItems().filter((item) => item.id === sentinel.id)).toHaveLength(1);
  });
});
