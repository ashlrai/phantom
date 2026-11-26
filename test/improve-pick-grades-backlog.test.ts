import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPickGrade,
  PICK_GRADE_ERROR_MARGIN,
  PICK_GRADES_WINDOW_HOURS,
  pickGradeCells,
  pickGradeRows,
  pickGradesBacklogItems,
  type PickGradeCell,
  type PickGradeRow,
} from '../src/core/improve/pick-grades-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are epoch ms like the writer emits. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');

/** One grades.jsonl row in runPickGrader's writer shape. */
function gradeRow(pickId: string, window: '24h' | '7d', gradedAtMs: number, predicted: number, realized: number, over: Record<string, unknown> = {}): string {
  return J({
    pickId, window, gradedAt: gradedAtMs, predicted, realized,
    hit: (predicted >= 0.5) === (realized >= 0.5),
    features: { mergeRate: predicted },
    ...over,
  });
}

/** A contract-valid row for the pure cell fold. */
function grade(pickId: string, window: '24h' | '7d', gradedAtMs: number, predicted: number, realized: number): PickGradeRow {
  return { pickId, window, gradedAtMs, predicted, realized };
}

describe('pickGradeRows', () => {
  it('keeps contract-valid rows, first per (pickId, window), and skips the rest', () => {
    const text = [
      gradeRow('RQ-PICK-0001', '7d', NOW_MS - 2 * DAY, 0.9, 0),
      gradeRow('RQ-PICK-0001', '7d', NOW_MS - DAY, 0.1, 1), // duplicate pair — first wins
      gradeRow('RQ-PICK-0001', '24h', NOW_MS - 2 * DAY, 0.8, 0.4), // same pick, other window — kept
      gradeRow('RQ-PICK-0002', '7d', NOW_MS - 3 * DAY, 0.2, 1.0),
      'not json',
      J({ pickId: 'bad id!', window: '7d', gradedAt: NOW_MS, predicted: 0.5, realized: 0 }),
      J({ pickId: 'RQ-PICK-0003', window: '30d', gradedAt: NOW_MS, predicted: 0.5, realized: 0 }),
      J({ pickId: 'RQ-PICK-0004', window: '7d', gradedAt: 'yesterday', predicted: 0.5, realized: 0 }),
      J({ pickId: 'RQ-PICK-0005', window: '7d', gradedAt: NOW_MS, predicted: 1.4, realized: 0 }),
      J({ pickId: 'RQ-PICK-0006', window: '7d', gradedAt: NOW_MS, predicted: 0.5, realized: -0.1 }),
      '',
    ].join('\n');
    const rows = pickGradeRows(text);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ pickId: 'RQ-PICK-0001', window: '7d', predicted: 0.9, realized: 0 });
    expect(rows.map((r) => `${r.pickId}:${r.window}`)).toEqual(['RQ-PICK-0001:7d', 'RQ-PICK-0001:24h', 'RQ-PICK-0002:7d']);
  });
});

describe('classifyPickGrade', () => {
  it('maps signed error at the margin and stays null inside it', () => {
    const M = PICK_GRADE_ERROR_MARGIN;
    expect(classifyPickGrade(grade('RQ-PICK-A', '7d', NOW_MS, 0.9, 0))).toBe('over-predicted');
    expect(classifyPickGrade(grade('RQ-PICK-B', '7d', NOW_MS, 0.85, 0.4286))).toBe('over-predicted'); // err ≈ 0.42
    expect(classifyPickGrade(grade('RQ-PICK-C', '7d', NOW_MS, 0.2, 1.0))).toBe('under-predicted');
    expect(classifyPickGrade(grade('RQ-PICK-D', '7d', NOW_MS, 0.59, 1.0))).toBe('under-predicted'); // err = -0.41
    // Inside the margin — ordinary ranker variance, never a cell.
    expect(classifyPickGrade(grade('RQ-PICK-E', '7d', NOW_MS, 0.6, 0.4286))).toBeNull(); // err ≈ 0.17
    expect(classifyPickGrade(grade('RQ-PICK-F', '7d', NOW_MS, 0.7, 1.0))).toBeNull(); // err = -0.3
    expect(classifyPickGrade(grade('RQ-PICK-G', '7d', NOW_MS, M, 0))).toBe('over-predicted'); // boundary counts
    expect(classifyPickGrade(grade('RQ-PICK-H', '7d', NOW_MS, 0, M))).toBe('under-predicted'); // realized − predicted = M exactly
  });
});

describe('pickGradeCells', () => {
  it('emits recurring miscalibration classes only and quotes the window denominator', () => {
    const rows = [
      // over-predicted across three days
      grade('RQ-PICK-0001', '7d', NOW_MS - 4 * DAY, 0.9, 0),
      grade('RQ-PICK-0002', '7d', NOW_MS - 3 * DAY, 0.85, 0.4286),
      grade('RQ-PICK-0003', '7d', NOW_MS - 2 * DAY, 0.8, 0),
      // under-predicted across two days
      grade('RQ-PICK-0004', '7d', NOW_MS - 5 * DAY, 0.2, 1.0),
      grade('RQ-PICK-0005', '7d', NOW_MS - 4 * DAY, 0.3, 1.0),
      grade('RQ-PICK-0006', '7d', NOW_MS - 6 * DAY, 0.1, 1.0),
      // context: inside-margin 7d grades, hits, 24h rows (never cells),
      // undated-impossible, out-of-window and future-dated rows
      grade('RQ-PICK-0007', '7d', NOW_MS - DAY, 0.6, 0.4286),
      grade('RQ-PICK-0008', '7d', NOW_MS - 2 * DAY, 0.55, 1.0), // hit? predicted<0.5? no — 0.55>=0.5, realized 1.0 → hit, err -0.45 → under-predicted! see note
      grade('RQ-PICK-0009', '24h', NOW_MS - 3 * DAY, 0.95, 0), // 24h context only
      grade('RQ-PICK-0010', '7d', NOW_MS - 30 * DAY, 0.95, 0), // out of window
      grade('RQ-PICK-0011', '7d', NOW_MS + DAY, 0.95, 0), // future-dated
    ];
    const { cells, window } = pickGradeCells(rows, NOW_MS, PICK_GRADES_WINDOW_HOURS, { gradesLowerBound: true });
    // Sorted busiest first: under-predicted has 4 grades (0004-0006 plus
    // 0008, whose 0.55-vs-1.0 gap is -0.45), over-predicted has 3.
    expect(cells.map((c) => c.cls)).toEqual(['under-predicted', 'over-predicted']);
    const [under, over] = cells as [PickGradeCell, PickGradeCell];
    expect(over.grades).toBe(3);
    expect(over.days).toEqual([
      new Date(NOW_MS - 4 * DAY).toISOString().slice(0, 10),
      new Date(NOW_MS - 3 * DAY).toISOString().slice(0, 10),
      new Date(NOW_MS - 2 * DAY).toISOString().slice(0, 10),
    ]);
    expect(over.examples).toEqual(['RQ-PICK-0001', 'RQ-PICK-0002', 'RQ-PICK-0003']);
    expect(over.predictions).toEqual([{ text: '0.7-0.9', count: 2 }, { text: '0.9-plus', count: 1 }]);
    expect(over.meanError).toBeGreaterThan(0.4);
    expect(over.gradesLowerBound).toBe(true);
    expect(under.grades).toBe(4);
    expect(under.predictions).toEqual([{ text: 'under-0.5', count: 3 }, { text: '0.5-0.7', count: 1 }]);
    // Dated in-window 7d rows: 0001-0008 (0010 is out-of-window, 0011 future-dated).
    expect(window.graded7d).toBe(8);
    expect(window.graded24h).toBe(1);
    // Only 0008 (0.55 predicted vs 1.0 realized) lands on the same side
    // of 0.5 as a hit; every other in-window 7d row is a recorded miss.
    expect(window.hits7d).toBe(1);
    expect(window.adverse.get('over-predicted')).toBe(3);
    expect(window.adverse.get('under-predicted')).toBe(4);
  });

  it('holds the recurring bars: count, distinct days and the 7d-only rule', () => {
    // Three over-predicted grades but all on one UTC day → below the days bar.
    const sameDay = [
      grade('RQ-PICK-0101', '7d', NOW_MS - 2 * DAY - 4 * HOUR, 0.9, 0),
      grade('RQ-PICK-0102', '7d', NOW_MS - 2 * DAY - 2 * HOUR, 0.9, 0),
      grade('RQ-PICK-0103', '7d', NOW_MS - 2 * DAY, 0.9, 0),
    ];
    expect(pickGradeCells(sameDay, NOW_MS, PICK_GRADES_WINDOW_HOURS).cells).toEqual([]);
    // Two grades across two days → below the count bar.
    const fewer = [
      grade('RQ-PICK-0104', '7d', NOW_MS - 3 * DAY, 0.9, 0),
      grade('RQ-PICK-0105', '7d', NOW_MS - 2 * DAY, 0.9, 0),
    ];
    expect(pickGradeCells(fewer, NOW_MS, PICK_GRADES_WINDOW_HOURS).cells).toEqual([]);
    // Three 24h-only miscalibrations across three days → never cells.
    const early = [
      grade('RQ-PICK-0106', '24h', NOW_MS - 4 * DAY, 0.95, 0),
      grade('RQ-PICK-0107', '24h', NOW_MS - 3 * DAY, 0.95, 0),
      grade('RQ-PICK-0108', '24h', NOW_MS - 2 * DAY, 0.95, 0),
    ];
    const { cells, window } = pickGradeCells(early, NOW_MS, PICK_GRADES_WINDOW_HOURS);
    expect(cells).toEqual([]);
    expect(window.graded24h).toBe(3);
    expect(window.graded7d).toBe(0);
  });
});

describe('pickGradesBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'pick-grades-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** Write a grades.jsonl under <dir>/.ashlr/picks — the writer's own pickGraderPaths layout. */
  async function gradesDir(name: string, rows: string[] | null): Promise<string> {
    const dir = join(home, name);
    if (rows !== null) {
      await mkdir(join(dir, '.ashlr', 'picks'), { recursive: true });
      await writeFile(join(dir, '.ashlr', 'picks', 'grades.jsonl'), rows.length ? rows.join('\n') + '\n' : '');
    }
    return dir;
  }

  /** Three over-predicted 7d grades across three days. */
  const overFixture = () => [
    gradeRow('RQ-PICK-0201', '7d', NOW_MS - 5 * DAY, 0.9, 0),
    gradeRow('RQ-PICK-0202', '7d', NOW_MS - 4 * DAY, 0.85, 0.4286),
    gradeRow('RQ-PICK-0203', '7d', NOW_MS - 3 * DAY, 0.8, 0),
    gradeRow('RQ-PICK-0201', '24h', NOW_MS - 6 * DAY, 0.9, 0.4), // context only
  ];

  /** Three under-predicted 7d grades across three days. */
  const underFixture = () => [
    gradeRow('RQ-PICK-0301', '7d', NOW_MS - 5 * DAY, 0.2, 1.0),
    gradeRow('RQ-PICK-0302', '7d', NOW_MS - 4 * DAY, 0.3, 1.0),
    gradeRow('RQ-PICK-0303', '7d', NOW_MS - 2 * DAY, 0.1, 1.0),
  ];

  it('emits an over-predicted item for recurring confident misses', async () => {
    const dir = await gradesDir('home-over', overFixture());
    const items = await pickGradesBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'pick-grades' });
    expect(item!.id).toMatch(/^pick-grades-over-predicted-[0-9a-f]{16}$/);
    expect(item!.title).toContain('over-predicting');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-PICK-0201');
    expect(item!.prompt).toContain('grades.jsonl');
    expect(item!.prompt).toContain('pickGraderPaths');
    expect(item!.prompt).toContain('3 graded pick(s)');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits an under-predicted item for recurring missed merges', async () => {
    const dir = await gradesDir('home-under', underFixture());
    const items = await pickGradesBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item!.id).toMatch(/^pick-grades-under-predicted-[0-9a-f]{16}$/);
    expect(item!.title).toContain('under-predicting');
    expect(item!.prompt).toContain('RQ-PICK-0301');
    expect(validBacklogItem(item)).not.toBeNull();
  });

  it('emits both classes when both recur, capped and stably identified', async () => {
    const dir = await gradesDir('home-both', [...overFixture(), ...underFixture()]);
    const opts = { repo: 'ashlrai/phantom', homeDir: dir, now: NOW };
    const first = await pickGradesBacklogItems(opts);
    const second = await pickGradesBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(2);
    const limited = await pickGradesBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('emits nothing for missing or withheld evidence, another repository, or below-bar cells', async () => {
    // No picks dir at all.
    expect(await pickGradesBacklogItems({ repo: 'ashlrai/phantom', homeDir: join(home, 'nope'), now: NOW })).toEqual([]);

    const dir = await gradesDir('home-thin', overFixture());
    // Injected withheld journal — the source IS the grades, so unknown stays quiet.
    expect(await pickGradesBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, gradesText: null, now: NOW })).toEqual([]);
    // Empty and malformed-only journals contribute nothing.
    expect(await pickGradesBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, gradesText: '', now: NOW })).toEqual([]);
    expect(await pickGradesBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, gradesText: 'not json\n{}\n', now: NOW })).toEqual([]);

    // Below the bars and the repo gate.
    const thinDir = await gradesDir('home-thin2', overFixture().slice(0, 2));
    expect(await pickGradesBacklogItems({ repo: 'ashlrai/phantom', homeDir: thinDir, now: NOW })).toEqual([]);
    const recurring = await gradesDir('home-rec', overFixture());
    expect(await pickGradesBacklogItems({ repo: 'ashlrai/lexicon', homeDir: recurring, now: NOW })).toEqual([]);
    expect(await pickGradesBacklogItems({ repo: '', homeDir: recurring, now: NOW })).toEqual([]);
  });

  it('treats hits, inside-margin grades and young picks as context', async () => {
    const healthy = [
      // Hits and small errors — the ranker working as recorded.
      gradeRow('RQ-PICK-0401', '7d', NOW_MS - 4 * DAY, 0.7, 1.0),
      gradeRow('RQ-PICK-0402', '7d', NOW_MS - 3 * DAY, 0.55, 0.4286),
      gradeRow('RQ-PICK-0403', '7d', NOW_MS - 2 * DAY, 0.39, 0), // err 0.39 — inside the margin
      gradeRow('RQ-PICK-0404', '7d', NOW_MS - DAY, 0.65, 1.0),
      // A lone over-prediction — below the count bar.
      gradeRow('RQ-PICK-0405', '7d', NOW_MS - 5 * DAY, 0.95, 0),
    ];
    const dir = await gradesDir('home-healthy', healthy);
    expect(await pickGradesBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, now: NOW })).toEqual([]);
  });

  it('carries the truncated-tail flag from the bounded read into the cell', async () => {
    const rows = pickGradeRows(overFixture().join('\n')).map((r) => grade(r.pickId, r.window, r.gradedAtMs, r.predicted, r.realized));
    const { cells, window } = pickGradeCells(rows, NOW_MS, PICK_GRADES_WINDOW_HOURS, { gradesLowerBound: true });
    expect(cells).toHaveLength(1);
    expect(cells[0]!.gradesLowerBound).toBe(true);
    expect(window.graded7d).toBe(3);
    expect(window.graded24h).toBe(1);
  });

  it('appends pick-grade items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock and resolves
    // the grader home through homedir(), so the fixture lands under the
    // relocated HOME's .ashlr/picks and stamps relative to Date.now().
    const realNow = Date.now();
    const at = (d: number): number => realNow - d * DAY;
    await mkdir(join(home, '.ashlr', 'picks'), { recursive: true });
    await writeFile(join(home, '.ashlr', 'picks', 'grades.jsonl'), [
      gradeRow('RQ-PICK-0501', '7d', at(5), 0.9, 0),
      gradeRow('RQ-PICK-0502', '7d', at(4), 0.85, 0.4286),
      gradeRow('RQ-PICK-0503', '7d', at(3), 0.8, 0),
      gradeRow('RQ-PICK-0401', '7d', at(2), 0.7, 1.0), // a hit — context
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const gradeItems = first.items.filter((i) => i.id.startsWith('pick-grades-'));
    expect(gradeItems).toHaveLength(1);
    expect(gradeItems[0]!.area).toBe('pick-grades');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(gradeItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('pick-grades-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('pick-grades-'))).toHaveLength(1);
  });
});
