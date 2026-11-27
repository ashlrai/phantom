import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldPickGradeBacklog,
  foldPickGradesJournal,
  pickGradeBacklogItems,
} from '../src/core/improve/pick-grade-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-pickgrade-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-26T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** ISO timestamp `msAgo` milliseconds before NOW. */
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

const REPO = 'ashlrai/phantom';
const PICK = (n: number): string => `RQ-PICK-${n.toString(16).padStart(4, '0')}`;

interface PickRow {
  at?: string;
  rank?: number;
  id?: string;
  repo?: string;
  jobType?: string;
  score?: number;
  predictedValue?: number;
  mergeRate?: number;
  minutes?: number;
  usage?: number;
  basis?: string;
  frictionId?: string;
}
interface GradeRow {
  pickId?: string;
  window?: string;
  gradedAt?: number;
  predicted?: number;
  realized?: number;
  hit?: boolean;
  features?: Record<string, number>;
}
interface JobRow {
  ts?: string;
  job?: string;
  event?: string;
}

/** A funded pick exactly as pickRecords writes it — the grader's own input shape. */
const pick = (id: string, msAgo: number, frictionId?: string): PickRow => ({
  at: iso(msAgo), rank: 1, id, repo: 'ashlrai/lexicon', jobType: 'work', score: 1.5,
  predictedValue: 0.8, mergeRate: 0.5, minutes: 30, usage: 0.3, basis: 'default',
  ...(frictionId === undefined ? {} : { frictionId }),
});
const grade = (pickId: string, window: '24h' | '7d', gradedAtMs: number): GradeRow => ({
  pickId, window, gradedAt: gradedAtMs, predicted: 0.5, realized: 0.6, hit: true,
  features: { mergeRate: 0.5 },
});
/** A dated jobs-ledger row — enough for foldPickGradeEvidence's coverageStartMs. */
const job = (msAgo: number): JobRow => ({ ts: iso(msAgo), job: 'J1', event: 'launch' });

const lines = (rows: Array<object | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

/** Three stranded picks funded 9-11 days ago; jobs coverage starts 6 days ago. */
const strandedFixture = (): { picks: string; jobs: string } => ({
  picks: lines([pick(PICK(1), 11 * DAY), pick(PICK(2), 10 * DAY), pick(PICK(3), 9 * DAY, 'FL-ITEM-1')]),
  jobs: lines([job(6 * DAY)]),
});
/** Same picks but jobs coverage reaches 30 days back — inside coverage, still ungraded. */
const missingFixture = (): { picks: string; jobs: string } => ({
  picks: lines([pick(PICK(1), 11 * DAY), pick(PICK(2), 10 * DAY), pick(PICK(3), 9 * DAY)]),
  jobs: lines([job(30 * DAY)]),
});

describe('pickGradeBacklogItems', () => {
  it('turns coverage-stranded picks into a valid priority-3 backlog item', async () => {
    const { picks, jobs } = strandedFixture();
    const items = await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW,
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^pick-grade-stranded-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'pick-grading' });
    expect(item.title).toContain('jobs-ledger coverage');
    expect(item.prompt).toContain('3 funded pick(s)');
    expect(item.prompt).toContain('proven-ungraded window(s) (3 at 24h and 3 at 7d)');
    expect(item.prompt).toContain('3 distinct UTC day(s)');
    expect(item.prompt).toContain('does not exist — no grade was ever recorded');
    expect(item.prompt).toContain('1 of the stranded pick(s) were friction-ledger-sourced');
    expect(item.prompt).toContain(PICK(1));
    expect(item.prompt).toContain('grades.jsonl');
    expect(item.prompt).toContain('weights.json');
    expect(item.prompt).toContain('grader-7d');
    expect(item.prompt).toContain('coverageStartMs');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).not.toContain('lower bound');
  });

  it('turns gradeable-but-ungraded picks into a valid priority-3 backlog item', async () => {
    const { picks, jobs } = missingFixture();
    const items = await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW,
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^pick-grade-missing-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'pick-grading' });
    expect(item.title).toContain('never landing');
    expect(item.prompt).toContain('3 funded pick(s)');
    expect(item.prompt).toContain('proven-ungraded window(s) (3 at 24h and 3 at 7d)');
    expect(item.prompt).toContain('the grades journal does not exist at all');
    expect(item.prompt).toContain('ai.ashlr.phm.selector');
    expect(item.prompt).toContain('runPickGrader');
    expect(item.prompt).toContain('no-change');
  });

  it('emits both buckets in a fixed order when picks straddle the coverage horizon', async () => {
    // Jobs coverage starts 6 days ago: picks funded 9-11 days ago strand,
    // picks funded 3-5 days ago sit inside coverage — their 24h windows
    // closed over a day ago while the 7d windows are not yet due.
    const picks = lines([
      pick(PICK(1), 11 * DAY), pick(PICK(2), 10 * DAY), pick(PICK(3), 9 * DAY),
      pick(PICK(4), 5 * DAY), pick(PICK(5), 4 * DAY), pick(PICK(6), 3 * DAY),
    ]);
    const jobs = lines([job(6 * DAY)]);
    const items = await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW,
    });
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toMatch(/^pick-grade-stranded-/);
    expect(items[1]!.id).toMatch(/^pick-grade-missing-/);
    expect(items[1]!.prompt).toContain('3 funded pick(s)');
    expect(items[1]!.prompt).toContain('(3 at 24h)');
    expect(items[1]!.prompt).not.toContain('and 3 at 7d');
    const one = await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW, limit: 1,
    });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(items[0]!.id);
  });

  it('keeps cells quiet below the pick or day bar and for picks not yet overdue', async () => {
    // Two stranded picks — below PICK_GRADE_MIN_PICKS.
    let { picks, jobs } = strandedFixture();
    picks = lines([pick(PICK(1), 11 * DAY), pick(PICK(2), 10 * DAY)]);
    expect(await pickGradeBacklogItems({ repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW })).toEqual([]);
    // Three stranded picks but all funded on one UTC day.
    picks = lines([pick(PICK(1), 9 * DAY + 2 * HOUR), pick(PICK(2), 9 * DAY + 3 * HOUR), pick(PICK(3), 9 * DAY + 4 * HOUR)]);
    expect(await pickGradeBacklogItems({ repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW })).toEqual([]);
    // ({ picks, jobs } = missingFixture()); — same bars apply to the missing cell.
    ({ picks, jobs } = missingFixture());
    picks = lines([pick(PICK(1), 5 * DAY), pick(PICK(2), 4 * DAY)]);
    expect(await pickGradeBacklogItems({ repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW })).toEqual([]);
    // A pick funded 36 hours ago: the 24h window closed only 12h ago —
    // inside the day's grace, so nothing is overdue yet.
    picks = lines([pick(PICK(1), 36 * HOUR), pick(PICK(2), 35 * HOUR), pick(PICK(3), 34 * HOUR)]);
    expect(await pickGradeBacklogItems({ repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW })).toEqual([]);
  });

  it('does not count picks whose grades are on record', async () => {
    const { picks, jobs } = strandedFixture();
    // An early anchor keeps every windowStart inside grades coverage; the
    // picks' own 24h+7d rows then exclude them cell by cell.
    const grades = lines([
      grade('RQ-ANCIENT', '24h', NOW.getTime() - 20 * DAY),
      grade(PICK(1), '24h', NOW.getTime() - 10 * DAY), grade(PICK(1), '7d', NOW.getTime() - 3 * DAY),
      grade(PICK(2), '24h', NOW.getTime() - 9 * DAY), grade(PICK(2), '7d', NOW.getTime() - 2 * DAY),
      grade(PICK(3), '24h', NOW.getTime() - 8 * DAY), grade(PICK(3), '7d', NOW.getTime() - DAY),
    ]);
    expect(await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesText: grades, now: NOW,
    })).toEqual([]);
  });

  it('counts a pick missing only its 7d grade when the 24h grade landed', async () => {
    const { jobs } = missingFixture();
    // Six picks inside coverage: PICK(10..12) carry no grades at all, while
    // PICK(1..3) already hold their 24h grade — only their 7d window stays
    // proven-ungraded.
    const picks = lines([
      pick(PICK(10), 14 * DAY), pick(PICK(11), 13 * DAY), pick(PICK(12), 12 * DAY),
      pick(PICK(1), 11 * DAY), pick(PICK(2), 10 * DAY), pick(PICK(3), 9 * DAY),
    ]);
    const grades = lines([
      grade('RQ-ANCIENT', '24h', NOW.getTime() - 20 * DAY),
      grade(PICK(1), '24h', NOW.getTime() - 10 * DAY),
      grade(PICK(2), '24h', NOW.getTime() - 9 * DAY),
      grade(PICK(3), '24h', NOW.getTime() - 8 * DAY),
    ]);
    const items = await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesText: grades, now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^pick-grade-missing-/);
    expect(items[0]!.prompt).toContain('6 funded pick(s)');
    expect(items[0]!.prompt).toContain('(3 at 24h and 6 at 7d)');
  });

  it('stays quiet when the grades tail cannot prove absence', async () => {
    const { picks, jobs } = missingFixture();
    // Every retained grade postdates the picks' window starts — an absent
    // grade could have aged out of the tail, so nothing is proven.
    const grades = lines([
      grade('RQ-OTHER-1', '24h', NOW.getTime() - HOUR),
      grade('RQ-OTHER-2', '7d', NOW.getTime() - 2 * HOUR),
    ]);
    expect(await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesText: grades, now: NOW,
    })).toEqual([]);
    // A read journal with content but no usable gradedAt gives no coverage
    // bound at all — dated grades could have aged out unseen.
    const undated = lines([
      { pickId: 'RQ-OTHER-1', window: '24h' },
      'garbage',
    ]);
    expect(await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesText: undated, now: NOW,
    })).toEqual([]);
    // A genuinely blank journal is proven-empty like a missing one.
    expect(await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesText: '\n\n', now: NOW,
    })).not.toEqual([]);
  });

  it('treats boundary coverage exactly like the writer guard', async () => {
    const { picks } = missingFixture();
    // coverageStartMs == pickedAt: the guard defers only when coverage is
    // NEWER than the window start, so equal coverage stays gradeable —
    // these picks land in 'missing', not 'stranded'.
    const jobs = lines([job(9 * DAY)]); // coverage = NOW-9d == PICK(3)'s funding time
    const items = await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW,
    });
    // PICK(1)=11d, PICK(2)=10d are before coverage → stranded (2 picks, 1+ days…
    // only two stranded picks → below the bar); PICK(3)=9d is at coverage → missing.
    // Missing has 1 pick → below the bar too: nothing emits.
    expect(items).toEqual([]);
    // Widening to three picks on each side emits both cells.
    const wider = lines([
      pick(PICK(1), 12 * DAY), pick(PICK(2), 11 * DAY), pick(PICK(3), 10 * DAY),
      pick(PICK(4), 9 * DAY), pick(PICK(5), 8 * DAY), pick(PICK(6), 7 * DAY + 12 * HOUR),
    ]);
    const both = await pickGradeBacklogItems({
      repo: REPO, picksText: wider, jobsText: jobs, gradesText: null, now: NOW,
    });
    expect(both.map((i) => i.id.split('-').slice(0, 3).join('-'))).toEqual([
      'pick-grade-stranded', 'pick-grade-missing',
    ]);
  });

  it('stays silent when picks, jobs or grades journals are missing or unreadable', async () => {
    const { picks, jobs } = strandedFixture();
    // Missing picks journal — nothing was funded or nothing can be read.
    expect(await pickGradeBacklogItems({
      repo: REPO, picksText: null, jobsText: jobs, gradesText: null, now: NOW,
    })).toEqual([]);
    expect(await pickGradeBacklogItems({
      repo: REPO, picksPath: path.join(home, 'absent-picks.jsonl'), jobsText: jobs, gradesText: null, now: NOW,
    })).toEqual([]);
    // Withheld jobs ledger — coverage unknowable, both cells silent.
    expect(await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: null, gradesText: null, now: NOW,
    })).toEqual([]);
    expect(await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsPath: path.join(home, 'absent-jobs.jsonl'), gradesText: null, now: NOW,
    })).toEqual([]);
    // A grades path that is not a file cannot prove absence — quiet.
    const gradesDir = path.join(home, 'grades-dir');
    fs.mkdirSync(gradesDir, { recursive: true });
    expect(await pickGradeBacklogItems({
      repo: REPO, picksText: picks, jobsText: jobs, gradesPath: gradesDir, now: NOW,
    })).toEqual([]);
  });

  it('yields nothing for empty input, bad repo or a non-fleet repository', async () => {
    const { picks, jobs } = strandedFixture();
    expect(await pickGradeBacklogItems({ repo: '', picksText: picks, jobsText: jobs, gradesText: null, now: NOW })).toEqual([]);
    expect(await pickGradeBacklogItems({ repo: 'not-a-repo', picksText: picks, jobsText: jobs, gradesText: null, now: NOW })).toEqual([]);
    expect(await pickGradeBacklogItems({ repo: 'ashlrai/lexicon', picksText: picks, jobsText: jobs, gradesText: null, now: NOW })).toEqual([]);
    expect(await pickGradeBacklogItems({ repo: REPO, picksText: '', jobsText: jobs, gradesText: null, now: NOW })).toEqual([]);
    expect(await pickGradeBacklogItems({ repo: REPO, picksText: 'not json\n', jobsText: jobs, gradesText: null, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const { picks, jobs } = strandedFixture();
    const first = await pickGradeBacklogItems({ repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW });
    const second = await pickGradeBacklogItems({ repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = lines([pick(PICK(1), 11 * DAY), pick(PICK(2), 10 * DAY), pick(PICK(3), 9 * DAY), pick(PICK(4), 8 * DAY)]);
    const third = await pickGradeBacklogItems({ repo: REPO, picksText: grown, jobsText: jobs, gradesText: null, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('scrubs secret-shaped text out of recorded pick ids before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const picks = lines([
      pick(`RQ-X-${token}`, 11 * DAY), pick(PICK(2), 10 * DAY), pick(PICK(3), 9 * DAY),
    ]);
    const { jobs } = strandedFixture();
    const items = await pickGradeBacklogItems({ repo: REPO, picksText: picks, jobsText: jobs, gradesText: null, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the default journal paths under the runs dir and OS home', async () => {
    const { picks, jobs } = strandedFixture();
    const runs = path.join(home, '.ashlr-runs');
    fs.mkdirSync(path.join(runs, 'selector'), { recursive: true });
    fs.mkdirSync(path.join(runs, 'metrics'), { recursive: true });
    fs.writeFileSync(path.join(runs, 'selector', 'picks.jsonl'), picks);
    fs.writeFileSync(path.join(runs, 'metrics', 'jobs.jsonl'), jobs);
    // grades.jsonl deliberately absent — missing is proven-empty.
    const items = await pickGradeBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^pick-grade-stranded-/);
  });
});

describe('pick grade fold purity', () => {
  it('foldPickGradesJournal keeps the graded set, coverage and newest stamp', () => {
    const fold = foldPickGradesJournal(lines([
      grade('RQ-1', '24h', NOW.getTime() - DAY),
      grade('RQ-1', '7d', NOW.getTime() - DAY + HOUR),
      grade('RQ-2', '24h', NOW.getTime()),
      'garbage',
      { pickId: 'RQ-3', window: '12h', gradedAt: 1 },
      { pickId: '', window: '24h', gradedAt: 1 },
      { pickId: 'RQ-4', window: '24h' },
    ]));
    expect(fold.graded.has('24h:RQ-1')).toBe(true);
    expect(fold.graded.has('7d:RQ-1')).toBe(true);
    expect(fold.graded.has('24h:RQ-2')).toBe(true);
    expect(fold.graded.has('24h:RQ-4')).toBe(true); // no gradedAt still marks graded
    expect(fold.graded.has('12h:RQ-3')).toBe(false);
    expect(fold.coverageStartMs).toBe(NOW.getTime() - DAY);
    expect(fold.newestMs).toBe(NOW.getTime());
    expect(fold.rows).toBe(4);
    expect(fold.malformed).toBe(3);
  });

  it('foldPickGradeBacklog splits stranded and missing on the coverage boundary', () => {
    const { picks } = strandedFixture();
    const covStart = NOW.getTime() - 6 * DAY;
    const fold = foldPickGradeBacklog(picks, null, covStart, NOW.getTime());
    expect(fold.picks).toBe(3);
    expect(fold.skipped).toBe(0);
    expect(fold.stranded).toHaveLength(3);
    expect(fold.missing).toHaveLength(0);
    expect(fold.stranded.map((c) => c.id).sort()).toEqual([PICK(1), PICK(2), PICK(3)].sort());
    expect(fold.stranded[0]!.windows).toEqual(['24h', '7d']);
    expect(fold.stranded[2]!.friction).toBe(true);
    expect(fold.gradesJournal).toBe('missing');
    expect(fold.jobsCoverageStartMs).toBe(covStart);
    // Coverage reaching further back flips the same picks to 'missing'.
    const flipped = foldPickGradeBacklog(picks, null, NOW.getTime() - 30 * DAY, NOW.getTime());
    expect(flipped.stranded).toHaveLength(0);
    expect(flipped.missing).toHaveLength(3);
    // Null coverage classifies nothing.
    const unknown = foldPickGradeBacklog(picks, null, null, NOW.getTime());
    expect(unknown.stranded).toHaveLength(0);
    expect(unknown.missing).toHaveLength(0);
  });

  it('foldPickGradeBacklog dedupes picks and skips rows the grader parser rejects', () => {
    const text = lines([
      pick(PICK(1), 11 * DAY),
      pick(PICK(1), 10 * DAY), // duplicate id — first row wins
      { at: iso(10 * DAY), id: PICK(2), mergeRate: 1.5 }, // mergeRate out of [0,1] — grader skips it too
      { at: iso(9 * DAY), id: 'bad id!', mergeRate: 0.5 }, // unsafe id
      pick(PICK(3), 9 * DAY),
      { at: 'not-a-date', id: PICK(4), mergeRate: 0.5 },
    ]);
    const fold = foldPickGradeBacklog(text, null, NOW.getTime() - 6 * DAY, NOW.getTime());
    expect(fold.picks).toBe(2); // PICK(1) once + PICK(3); PICK(2)/PICK(4)/bad-id rejected
    expect(fold.skipped).toBe(3);
    expect(fold.stranded.map((c) => c.id).sort()).toEqual([PICK(1), PICK(3)].sort());
  });
});

describe('pick grade items through discovery', () => {
  it('appends pick-grade items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_HOME = path.join(home, 'ashlr-home');
      fs.mkdirSync(process.env.ASHLR_HOME, { recursive: true });
      const { picks, jobs } = strandedFixture();
      const runs = path.join(home, '.ashlr-runs');
      fs.mkdirSync(path.join(runs, 'selector'), { recursive: true });
      fs.mkdirSync(path.join(runs, 'metrics'), { recursive: true });
      fs.writeFileSync(path.join(runs, 'selector', 'picks.jsonl'), picks);
      fs.writeFileSync(path.join(runs, 'metrics', 'jobs.jsonl'), jobs);
      // grades.jsonl stays absent under <home>/.ashlr/picks — missing is proven-empty.
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const grades = first.items.filter((i) => i.id.startsWith('pick-grade-'));
      expect(grades).toHaveLength(1);
      expect(grades[0]!.id).toMatch(/^pick-grade-stranded-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(grades)).toBe(grades.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('pick-grade-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('pick-grade-'))).toHaveLength(grades.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
