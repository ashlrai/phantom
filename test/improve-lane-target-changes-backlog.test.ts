import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LANE_TARGET_MIN_DAYS,
  LANE_TARGET_MIN_ROWS,
  LANE_TARGET_WINDOW_MS,
  foldLaneTargetRows,
  laneTargetCells,
  laneTargetChangesBacklogItems,
  parseLaneTargetChangesJournal,
  parseLaneTargetLine,
} from '../src/core/improve/lane-target-changes-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the writers' `at`. */
const NOW_MS = Date.parse('2026-11-26T12:00:00.000Z');
const NOW = new Date(NOW_MS);
const iso = (ms: number): string => new Date(ms).toISOString();
const REPO = 'ashlrai/phantom';
const LANE = 'codex-personal';
const OTHER_LANE = 'jobs-lane';

let home: string;
let savedHome: string | undefined;
let savedRuns: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lane-target-changes-backlog-'));
  savedHome = process.env['HOME'];
  savedRuns = process.env['ASHLR_RUNS_DIR'];
  process.env['HOME'] = home;
  delete process.env['ASHLR_RUNS_DIR'];
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  if (savedRuns === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = savedRuns;
  await rm(home, { recursive: true, force: true });
});

/** One audit line in the writers' exact shape — four tab-separated fields. */
function retarget(atMs: number, lane: string, from: number, to: number, by = 'Phantom desktop'): string {
  return `${iso(atMs)}\t${lane}\t${from}->${to}\t${by}`;
}
function hold(atMs: number, lane: string, minutes: number, tail: string): string {
  return `${iso(atMs)}\t${lane}\thold ${minutes}m\t${tail}`;
}
function release(atMs: number, lane: string, by = 'Phantom desktop'): string {
  return `${iso(atMs)}\t${lane}\theld->released\t${by}`;
}

/** Write journal text to <home>/<runsDirName>/queue/lane-target-changes.log and return the runs dir. */
function writeJournal(lines: string[], runsDirName = '.ashlr-runs'): string {
  const dir = join(home, runsDirName, 'queue');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lane-target-changes.log'), lines.join('\n') + '\n');
  return join(home, runsDirName);
}

/** Three hold audit lines across two days — the emit bar for hold cells. */
function recurringHolds(lane = LANE): string[] {
  return [
    hold(NOW_MS - 2 * DAY, lane, 30, 'lane-autohold: empty streak 4 launches'),
    hold(NOW_MS - DAY - HOUR, lane, 30, 'lane-autohold: empty streak 5 launches'),
    hold(NOW_MS - HOUR, lane, 60, 'telegram: quota wall'),
  ];
}

/** Three retarget transitions across two days running in both directions — the churn bar. */
function churnedRetargets(lane = LANE): string[] {
  return [
    retarget(NOW_MS - 2 * DAY, lane, 3, 5, 'phm autofix'),
    retarget(NOW_MS - DAY - HOUR, lane, 5, 3, 'Phantom desktop'),
    retarget(NOW_MS - HOUR, lane, 3, 4, 'phm autofix'),
  ];
}

describe('parseLaneTargetLine', () => {
  it('accepts the three writer shapes', () => {
    const r = parseLaneTargetLine(retarget(NOW_MS, LANE, 3, 5));
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('retarget');
    expect(r!.from).toBe(3);
    expect(r!.to).toBe(5);
    expect(r!.actor).toBe('Phantom desktop');
    expect(r!.utcDay).toBe('2026-11-26');

    const h = parseLaneTargetLine(hold(NOW_MS, LANE, 30, 'lane-autohold: empty streak'));
    expect(h).not.toBeNull();
    expect(h!.kind).toBe('hold');
    expect(h!.minutes).toBe(30);
    expect(h!.actor).toBe('lane-autohold');

    const x = parseLaneTargetLine(release(NOW_MS, LANE, 'reset-detect'));
    expect(x).not.toBeNull();
    expect(x!.kind).toBe('release');
    expect(x!.actor).toBe('reset-detect');
  });

  it('rejects off-contract lines: field count, timestamp, lane, change and tail', () => {
    expect(parseLaneTargetLine(`${iso(NOW_MS)}\t${LANE}\t3->5`)).toBeNull(); // 3 fields
    expect(parseLaneTargetLine(`${iso(NOW_MS)}\t${LANE}\t3->5\tby\textra`)).toBeNull(); // 5 fields
    expect(parseLaneTargetLine(`not-a-date\t${LANE}\t3->5\tby`)).toBeNull();
    expect(parseLaneTargetLine(`2026-11-26 12:00:00\t${LANE}\t3->5\tby`)).toBeNull(); // not canonical ISO
    expect(parseLaneTargetLine(`${iso(NOW_MS)}\tBAD_LANE\t3->5\tby`)).toBeNull();
    expect(parseLaneTargetLine(`${iso(NOW_MS)}\t9lane\t3->5\tby`)).toBeNull();
    expect(parseLaneTargetLine(`${iso(NOW_MS)}\t${LANE}\t3=>5\tby`)).toBeNull();
    expect(parseLaneTargetLine(`${iso(NOW_MS)}\t${LANE}\tpause\tby`)).toBeNull();
    expect(parseLaneTargetLine(`${iso(NOW_MS)}\t${LANE}\thold 0m\tby: x`)).toBeNull();
    expect(parseLaneTargetLine(`${iso(NOW_MS)}\t${LANE}\thold 1441m\tby: x`)).toBeNull();
    expect(parseLaneTargetLine(`${iso(NOW_MS)}\t${LANE}\thold 30\tby: x`)).toBeNull(); // missing m
    expect(parseLaneTargetLine(`${iso(NOW_MS)}\t${LANE}\t3->5\t`)).toBeNull(); // empty tail
    expect(parseLaneTargetLine('')).toBeNull();
  });
});

describe('parseLaneTargetChangesJournal + foldLaneTargetRows + laneTargetCells', () => {
  it('counts malformed lines and never guesses them', () => {
    const parsed = parseLaneTargetChangesJournal([
      retarget(NOW_MS - HOUR, LANE, 3, 5),
      'garbage line',
      `${iso(NOW_MS - 2 * HOUR)}\t${LANE}\tbogus\tby`,
      '',
    ].join('\n'));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.invalidRows).toBe(2);
  });

  it('emits a hold cell at the row/day bars and quotes actors and tails', () => {
    const parsed = parseLaneTargetChangesJournal(recurringHolds().join('\n'));
    const fold = foldLaneTargetRows(parsed.rows, { nowMs: NOW_MS });
    const cells = laneTargetCells(fold);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.kind).toBe('lane-hold');
    expect(cell.lane).toBe(LANE);
    expect(cell.rows).toBe(LANE_TARGET_MIN_ROWS);
    expect(cell.days.length).toBeGreaterThanOrEqual(LANE_TARGET_MIN_DAYS);
    expect(cell.actors.map(([a]) => a)).toContain('lane-autohold');
    expect(cell.actors.map(([a]) => a)).toContain('telegram');
    expect(cell.tails.length).toBeGreaterThan(0);
    expect(cell.reversals).toBeNull();
    expect(cell.transitions).toBeNull();
  });

  it('suppresses hold cells below the bars: one day or too few rows', () => {
    // Three rows, all on one UTC day.
    const sameDay = [
      hold(NOW_MS - 3 * HOUR, LANE, 30, 'lane-autohold: a'),
      hold(NOW_MS - 2 * HOUR, LANE, 30, 'lane-autohold: b'),
      hold(NOW_MS - HOUR, LANE, 30, 'lane-autohold: c'),
    ].join('\n');
    const fold = foldLaneTargetRows(parseLaneTargetChangesJournal(sameDay).rows, { nowMs: NOW_MS });
    expect(laneTargetCells(fold)).toHaveLength(0);
    // Two rows across two days.
    const two = [
      hold(NOW_MS - 2 * DAY, LANE, 30, 'lane-autohold: a'),
      hold(NOW_MS - HOUR, LANE, 30, 'lane-autohold: b'),
    ].join('\n');
    expect(laneTargetCells(foldLaneTargetRows(parseLaneTargetChangesJournal(two).rows, { nowMs: NOW_MS }))).toHaveLength(0);
  });

  it('emits a churn cell only when transitions ran in both directions', () => {
    const churn = foldLaneTargetRows(parseLaneTargetChangesJournal(churnedRetargets().join('\n')).rows, { nowMs: NOW_MS });
    const cells = laneTargetCells(churn);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.kind).toBe('lane-target-churn');
    expect(cells[0]!.lane).toBe(LANE);
    expect(cells[0]!.rows).toBe(LANE_TARGET_MIN_ROWS);
    expect(cells[0]!.reversals).not.toBeNull();
    expect(cells[0]!.transitions).toEqual(['3->5', '5->3', '3->4']);
    expect(cells[0]!.actors.map(([a]) => a)).toContain('phm autofix');

    // Monotone scale-up across the same bars is deliberate tuning — context, no cell.
    const scale = [
      retarget(NOW_MS - 2 * DAY, LANE, 1, 3),
      retarget(NOW_MS - DAY - HOUR, LANE, 3, 5),
      retarget(NOW_MS - HOUR, LANE, 5, 8),
    ].join('\n');
    const scaleFold = foldLaneTargetRows(parseLaneTargetChangesJournal(scale).rows, { nowMs: NOW_MS });
    expect(laneTargetCells(scaleFold)).toHaveLength(0);
    // Pause/resume flapping counts: 0 is a real target (the lane's pause).
    const flap = [
      retarget(NOW_MS - 2 * DAY, LANE, 4, 0),
      retarget(NOW_MS - DAY, LANE, 0, 4),
      retarget(NOW_MS - HOUR, LANE, 4, 0),
    ].join('\n');
    const flapCells = laneTargetCells(foldLaneTargetRows(parseLaneTargetChangesJournal(flap).rows, { nowMs: NOW_MS }));
    expect(flapCells).toHaveLength(1);
    expect(flapCells[0]!.kind).toBe('lane-target-churn');
  });

  it('counts releases and single-direction retargets as context', () => {
    const lines = [
      ...recurringHolds(OTHER_LANE),
      release(NOW_MS - 2 * DAY, LANE),
      release(NOW_MS - DAY, LANE),
      release(NOW_MS - HOUR, LANE, 'reset-detect'),
      retarget(NOW_MS - 2 * DAY, OTHER_LANE, 2, 4),
      retarget(NOW_MS - DAY - HOUR, OTHER_LANE, 4, 6),
    ];
    const fold = foldLaneTargetRows(parseLaneTargetChangesJournal(lines.join('\n')).rows, { nowMs: NOW_MS });
    expect(fold.releases).toBe(3);
    const cells = laneTargetCells(fold);
    // Only the OTHER_LANE hold cell emits; the two monotone retargets are context.
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lane).toBe(OTHER_LANE);
    expect(cells[0]!.kind).toBe('lane-hold');
    expect(cells[0]!.context).toBe(5); // 3 releases + 2 monotone retargets
  });

  it('drops rows outside the window and marks truncated tails', () => {
    const old = hold(NOW_MS - LANE_TARGET_WINDOW_MS - DAY, LANE, 30, 'lane-autohold: old');
    const lines = [...recurringHolds(), old].join('\n');
    const fold = foldLaneTargetRows(parseLaneTargetChangesJournal(lines).rows, { nowMs: NOW_MS, truncated: true });
    expect(fold.outsideWindow).toBe(1);
    const cells = laneTargetCells(fold);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.truncated).toBe(true);
    // Without the truncation flag the cell reports a complete read.
    const full = laneTargetCells(foldLaneTargetRows(parseLaneTargetChangesJournal(recurringHolds().join('\n')).rows, { nowMs: NOW_MS }));
    expect(full[0]!.truncated).toBe(false);
  });
});

describe('laneTargetChangesBacklogItems', () => {
  it('emits items for recurring hold and churn cells with stable ids', async () => {
    const runsDir = writeJournal([...recurringHolds(), ...churnedRetargets(OTHER_LANE)]);
    const items = await laneTargetChangesBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(items).toHaveLength(2);
    const byKind = new Map(items.map((i) => [i.area, i]));
    const holdItem = byKind.get('lane-target-changes-lane-hold')!;
    const churnItem = byKind.get('lane-target-changes-lane-target-churn')!;
    for (const item of items) {
      expect(item.priority).toBe(3);
      expect(item.repo).toBe(REPO);
      expect(validBacklogItem(item)).not.toBeNull();
    }
    expect(holdItem.title).toContain(LANE);
    expect(holdItem.prompt).toContain('lane-autohold');
    expect(holdItem.prompt).toContain('3 audit line(s)');
    expect(churnItem.title).toContain(OTHER_LANE);
    expect(churnItem.prompt).toContain('3->5');
    expect(churnItem.prompt).toContain('Direction reversals');

    // A refresh re-derives the same ids — appendUserBacklogItems adds nothing new.
    const again = await laneTargetChangesBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(again.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
  });

  it('stays quiet on missing, empty and below-bar journals', async () => {
    expect(await laneTargetChangesBacklogItems({ repo: REPO, runsDir: join(home, 'nope'), now: NOW })).toEqual([]);
    const empty = writeJournal([], 'empty-runs');
    expect(await laneTargetChangesBacklogItems({ repo: REPO, runsDir: empty, now: NOW })).toEqual([]);
    // Healthy traffic only: monotone retunes and releases.
    const healthy = writeJournal([
      retarget(NOW_MS - 3 * DAY, LANE, 1, 2),
      retarget(NOW_MS - 2 * DAY, LANE, 2, 3),
      retarget(NOW_MS - DAY, LANE, 3, 4),
      release(NOW_MS - HOUR, LANE, 'reset-detect'),
    ], 'healthy-runs');
    expect(await laneTargetChangesBacklogItems({ repo: REPO, runsDir: healthy, now: NOW })).toEqual([]);
  });

  it('emits only for the fleet repository and respects the repo gate', async () => {
    const runsDir = writeJournal(recurringHolds());
    expect(await laneTargetChangesBacklogItems({ repo: 'ashlrai/other', runsDir, now: NOW })).toEqual([]);
    expect(await laneTargetChangesBacklogItems({ repo: 'other', runsDir, now: NOW })).toEqual([]);
    expect(await laneTargetChangesBacklogItems({ repo: '', runsDir, now: NOW })).toEqual([]);
    expect(await laneTargetChangesBacklogItems({ repo: 'not a repo!!', runsDir, now: NOW })).toEqual([]);
    const items = await laneTargetChangesBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: NOW });
    expect(items).toHaveLength(1);
  });

  it('honors ASHLR_RUNS_DIR and homeDir resolution', async () => {
    const custom = join(home, 'custom-runs');
    mkdirSync(join(custom, 'queue'), { recursive: true });
    writeFileSync(join(custom, 'queue', 'lane-target-changes.log'), recurringHolds().join('\n') + '\n');
    process.env['ASHLR_RUNS_DIR'] = custom;
    expect(await laneTargetChangesBacklogItems({ repo: REPO, now: NOW })).toHaveLength(1);
    delete process.env['ASHLR_RUNS_DIR'];
    const altHome = join(home, 'alt-home');
    mkdirSync(join(altHome, '.ashlr-runs', 'queue'), { recursive: true });
    writeFileSync(
      join(altHome, '.ashlr-runs', 'queue', 'lane-target-changes.log'),
      recurringHolds().join('\n') + '\n');
    expect(await laneTargetChangesBacklogItems({ repo: REPO, homeDir: altHome, now: NOW })).toHaveLength(1);
    expect(await laneTargetChangesBacklogItems({ repo: REPO, homeDir: join(home, 'empty-home'), now: NOW })).toEqual([]);
  });

  it('notes malformed retained lines and the truncated-tail floor in prompts', async () => {
    const runsDir = writeJournal([
      ...recurringHolds(),
      'a line that is not an audit record',
      `${iso(NOW_MS - HOUR)}\t${LANE}\tbogus-change\tby`,
    ]);
    const items = await laneTargetChangesBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('failed the writers');
    expect(items[0]!.prompt).toContain('not counted');
  });

  it('caps emitted items at the limit', async () => {
    const runsDir = writeJournal([
      ...recurringHolds(LANE),
      ...churnedRetargets(OTHER_LANE),
      ...recurringHolds('jobs-lane'),
    ]);
    const items = await laneTargetChangesBacklogItems({ repo: REPO, runsDir, now: NOW, limit: 2 });
    expect(items).toHaveLength(2);
  });
});

describe('discoverBacklog integration', () => {
  it('surfaces journal cells through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      // discoverBacklog calls the feed with no path overrides, so the feed
      // resolves <home>/.ashlr-runs — HOME is this test's temp dir.
      writeJournal(recurringHolds());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') {
          return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        }
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const landed = first.items.filter((i) => i.id.startsWith('lane-target-changes-'));
      expect(landed).toHaveLength(1);
      expect(landed[0]!.area).toBe('lane-target-changes-lane-hold');
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(landed)).toBe(landed.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('lane-target-changes-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('lane-target-changes-'))).toHaveLength(landed.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
