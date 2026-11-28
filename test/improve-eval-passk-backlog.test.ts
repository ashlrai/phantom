import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVAL_PASSK_IN_FLIGHT_MS,
  EVAL_PASSK_MIN_FAILURES,
  EVAL_PASSK_MIN_SKIPS,
  EVAL_PASSK_STALE_MS,
  evalPasskBacklogItems,
  foldEvalPassKEvidence,
  parseEvalPassKJournal,
  parseEvalPassKReportDoc,
  parseEvalPassKSkipDoc,
  type EvalPassKEvent,
  type EvalPassKGap,
} from '../src/core/improve/eval-passk-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW = new Date('2026-11-28T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number): string => new Date(NOW_MS - msAgo).toISOString();

/** One task row inside a lane's tasks array, writer-shaped. */
const taskRow = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  taskId: id,
  trials: 8,
  passes: 4,
  pass1: 0.5,
  ci95: [0.2, 0.8],
  passAtK: 0.9,
  passPowK: 0.4,
  dimensionRates: { tests: 0.5, diffQuality: 0.6, instructions: 0.7 },
  trialsDetail: [],
  ...over,
});

/** One lane inside report.lanes, writer-shaped. */
const laneRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  lane: 'local',
  model: 'local-coder',
  tasks: [taskRow('golden-1')],
  trialsTotal: 8,
  passesTotal: 4,
  meanPass1: 0.5,
  meanPassAtK: 0.9,
  meanPassPowK: 0.4,
  ...over,
});

/** The document `phm eval passk --json` prints on success: JSON.stringify({report, published}, null, 2). */
const reportDoc = (generatedAtMsAgo: number, over: Record<string, unknown> = {}): string => JSON.stringify({
  report: {
    schema: 'eval.passk.v1',
    id: `passk-${(NOW_MS - generatedAtMsAgo).toString(36)}`,
    generatedAt: iso(generatedAtMsAgo),
    dataset: { id: 'golden', sha256: 'a'.repeat(64), tasks: 6 },
    trials: 8,
    k: 4,
    lanes: [laneRow()],
    alerts: [],
    ...over,
  },
  published: {
    report: '/home/test/.ashlr/eval/passk/reports/x.json',
    scores: '/home/test/.ashlr/eval/passk/lane-scores.json',
    alerts: '/home/test/.ashlr/eval/passk/alerts.jsonl',
    dir: '/home/test/.ashlr/eval/passk',
    laneScores: '/home/test/.ashlr/eval/passk/lane-scores.json',
  },
}, null, 2);

/** The single-line verdict a provider-less local run prints. */
const skipLine = (reason = 'eval passk needs a local model — start Ollama or LM Studio, then re-run `phm eval passk`.'): string =>
  JSON.stringify({ skipped: true, reason });

/** `n` skip verdicts, oldest first. */
const skipLines = (n: number): string[] => Array.from({ length: n }, () => skipLine());

/** `n` CLI failure verdicts (`error:` lines), oldest first. */
const errorLines = (n: number, msg = 'error: could not publish the report'): string[] =>
  Array.from({ length: n }, () => msg);

/** A probable crashed run's stderr: an error line plus a stack trace. */
const crashLines = (): string[] => [
  'Error: spawn ollama ENOENT',
  '    at buildDefaultRunner (/x/src/core/eval/swe-bench.ts:10:5)',
  '    at cmdEvalPassK (/x/src/cli/eval-passk.ts:20:3)',
  '    at async main (/x/src/cli/index.ts:5:1)',
];

const emptyGap: EvalPassKGap = { strayLines: 0, errorLines: 0, crashClusters: 0 };
const reportSummary = (atMsAgo: number) => ({
  atMs: NOW_MS - atMsAgo,
  utcDay: iso(atMsAgo).slice(0, 10),
  reportId: `passk-${(NOW_MS - atMsAgo).toString(36)}`,
  datasetTasks: 6,
  lanes: 1,
  trials: 8,
  k: 4,
  alerts: 0,
});
const reportEvent = (atMsAgo: number): EvalPassKEvent => ({
  kind: 'report',
  gap: emptyGap,
  report: reportSummary(atMsAgo),
});
const skipEvent = (reason = 'r'): EvalPassKEvent => ({ kind: 'skip', gap: emptyGap, reason });
const abandonedEvent = (): EvalPassKEvent => ({ kind: 'abandoned', gap: emptyGap });

describe('parseEvalPassKReportDoc', () => {
  it('accepts an on-contract document and rejects off-contract shapes', () => {
    const doc = JSON.parse(reportDoc(DAY)) as Record<string, unknown>;
    const run = parseEvalPassKReportDoc(doc);
    expect(run).not.toBeNull();
    expect(run).toMatchObject({ datasetTasks: 6, lanes: 1, trials: 8, k: 4, alerts: 0 });
    expect(run!.atMs).toBe(NOW_MS - DAY);

    const report = doc['report'] as Record<string, unknown>;
    const published = doc['published'] as Record<string, unknown>;
    const cases: unknown[] = [
      null,
      [],
      'text',
      {},
      { report },
      { published },
      { report: { ...report, schema: 'eval.passk.v0' }, published },
      { report: { ...report, generatedAt: 'not-a-date' }, published },
      { report: { ...report, id: 42 }, published },
      { report: { ...report, dataset: { sha256: 'x' } }, published },
      { report: { ...report, trials: 0 }, published },
      { report: { ...report, k: 9 }, published }, // k > trials
      { report: { ...report, lanes: 'none' }, published },
      { report: { ...report, lanes: [{ lane: 'local' }] }, published },
      { report: { ...report, lanes: [laneRow({ meanPass1: 1.5 })] }, published },
      { report: { ...report, lanes: [laneRow({ tasks: [{ taskId: 't' }] })] }, published },
      { report: { ...report, alerts: 'none' }, published },
      { report, published: { ...published, report: 7 } },
      { report, published: { scores: '/x' } },
    ];
    for (const value of cases) expect(parseEvalPassKReportDoc(value)).toBeNull();
  });
});

describe('parseEvalPassKSkipDoc', () => {
  it('accepts the skip verdict and rejects lookalikes', () => {
    expect(parseEvalPassKSkipDoc(JSON.parse(skipLine()))).toContain('local model');
    const cases: unknown[] = [
      null, [], 'x', {},
      { skipped: false, reason: 'r' },
      { skipped: true },
      { skipped: true, reason: '' },
      { skipped: true, reason: 42 },
      { skipped: 'yes', reason: 'r' },
    ];
    for (const value of cases) expect(parseEvalPassKSkipDoc(value)).toBeNull();
  });
});

describe('parseEvalPassKJournal', () => {
  it('frames pretty documents on column-0 braces and single-line records beside them', () => {
    const text = [
      'launchd preamble noise',
      reportDoc(3 * DAY),
      skipLine(),
      skipLine(),
      reportDoc(DAY),
      'trailing stderr',
      '',
    ].join('\n');
    const { events, tailGap, coverage } = parseEvalPassKJournal(text);
    expect(events.map((e) => e.kind)).toEqual(['report', 'skip', 'skip', 'report']);
    expect(events[0]!.kind === 'report' && events[0]!.report.datasetTasks).toBe(6);
    // Gap attribution: the first report's gap holds the preamble line;
    // the first skip's gap is empty; the second skip's gap is empty;
    // the second report's gap is empty; EOF stderr lands in tailGap.
    expect(events[0]!.gap.strayLines).toBe(1);
    expect(events[1]!.gap.strayLines).toBe(0);
    expect(events[3]!.gap.strayLines).toBe(0);
    expect(tailGap.strayLines).toBe(1);
    expect(coverage.strayLines).toBe(2);
    expect(coverage.invalidDocs).toBe(0);
    expect(coverage.openTail).toBe(false);
  });

  it('classifies error lines, crash clusters and plain noise inside gaps', () => {
    const text = [
      reportDoc(2 * DAY),
      'error: could not read the pass^k dataset',
      ...crashLines(),
      'a benign warning line',
      'error: could not publish the report',
      skipLine(),
    ].join('\n');
    const { events, coverage } = parseEvalPassKJournal(text);
    expect(events.map((e) => e.kind)).toEqual(['report', 'skip']);
    const gap = events[1]!.gap;
    expect(gap.errorLines).toBe(2);
    expect(gap.crashClusters).toBe(1);
    expect(gap.strayLines).toBe(1);
    // Every non-record line counts toward coverage, classified or not.
    expect(coverage.strayLines).toBe(7);
  });

  it('counts a column-0 brace inside a document as an abandoned mid-write run', () => {
    const torn = '{\n  "report": {\n    "schema": "eval.passk.v1",';
    const text = `${reportDoc(2 * DAY)}\n${torn}\n${reportDoc(DAY)}\n`;
    const { events, coverage } = parseEvalPassKJournal(text);
    expect(events.map((e) => e.kind)).toEqual(['report', 'abandoned', 'report']);
    expect(coverage.openTail).toBe(false);
  });

  it('flags an unterminated tail document as openTail, never a verdict', () => {
    const torn = '{\n  "report": {\n    "schema": "eval.passk.v1",';
    const text = `${reportDoc(DAY)}\n${torn}`;
    const { events, coverage } = parseEvalPassKJournal(text);
    expect(events.map((e) => e.kind)).toEqual(['report']);
    expect(coverage.openTail).toBe(true);
  });

  it('counts closed off-contract documents and single-line records as invalidDocs', () => {
    const badDoc = JSON.stringify({ report: { schema: 'nope' } }, null, 2);
    const badLine = '{"unrelated":true}';
    const good = reportDoc(DAY);
    const { events, coverage } = parseEvalPassKJournal(`${badDoc}\n${badLine}\n${good}\n`);
    expect(events.map((e) => e.kind)).toEqual(['report']);
    expect(coverage.invalidDocs).toBe(2);
  });

  it('treats a brace-looking non-record line as stray, and a mid-document stderr line as invalid', () => {
    const { events, tailGap, coverage } = parseEvalPassKJournal('{not json}\nplain noise\n');
    expect(events).toEqual([]);
    expect(tailGap.strayLines).toBe(2);
    expect(coverage.strayLines).toBe(2);

    // stderr text at column 0 inside an open document breaks its JSON.
    const polluted = `{\n  "report": {\nerror: boom\n}\n`;
    const second = parseEvalPassKJournal(polluted);
    expect(second.events).toEqual([]);
    expect(second.coverage.invalidDocs).toBe(1);
  });
});

describe('foldEvalPassKEvidence', () => {
  const empty = emptyGap;
  it('anchors the tail on the newest non-skewed report', () => {
    const skewed: EvalPassKEvent = {
      kind: 'report',
      gap: emptyGap,
      report: { ...reportSummary(DAY), atMs: NOW_MS + 10 * 60_000 },
    };
    const events: EvalPassKEvent[] = [
      reportEvent(5 * DAY),
      skewed,
      skipEvent(), skipEvent(), skipEvent(),
      reportEvent(DAY),
      skipEvent(),
    ];
    const { evidence, skewedReports } = foldEvalPassKEvidence(events, empty, { nowMs: NOW_MS });
    // The skewed report cannot anchor; the DAY-ago report is newest valid.
    expect(skewedReports).toBe(1);
    expect(evidence.reports).toBe(2);
    expect(evidence.lastReportAt).toBe(iso(DAY));
    expect(evidence.prevReportAt).toBe(iso(5 * DAY));
    // Only the skip after the newest report joins the tail — the three
    // before it were followed by a healthy run and recovered.
    expect(evidence.tailSkips).toBe(1);
    expect(evidence.tailUnmeasured).toBe(1);
  });

  it('treats the whole stream as tail when no report exists', () => {
    const events: EvalPassKEvent[] = [skipEvent(), abandonedEvent(), skipEvent()];
    const { evidence } = foldEvalPassKEvidence(events, { strayLines: 0, errorLines: 2, crashClusters: 1 }, { nowMs: NOW_MS });
    expect(evidence.reports).toBe(0);
    expect(evidence.lastReportAt).toBeNull();
    expect(evidence.tailSkips).toBe(2);
    expect(evidence.tailAbandoned).toBe(1);
    expect(evidence.tailErrorLines).toBe(2);
    expect(evidence.tailCrashClusters).toBe(1);
    expect(evidence.tailUnmeasured).toBe(2 + 1 + 2 + 1);
  });

  it('folds gap classification and the EOF gap into the tail counts', () => {
    const events: EvalPassKEvent[] = [
      reportEvent(2 * DAY),
      { kind: 'skip', gap: { strayLines: 1, errorLines: 2, crashClusters: 1 }, reason: 'r' },
      { kind: 'abandoned', gap: { strayLines: 0, errorLines: 1, crashClusters: 0 }, },
    ];
    const { evidence } = foldEvalPassKEvidence(events, { strayLines: 3, errorLines: 1, crashClusters: 0 }, { nowMs: NOW_MS });
    expect(evidence.tailSkips).toBe(1);
    expect(evidence.tailAbandoned).toBe(1);
    expect(evidence.tailErrorLines).toBe(2 + 1 + 1);
    expect(evidence.tailCrashClusters).toBe(1);
    expect(evidence.tailStrayLines).toBe(1 + 3);
    expect(evidence.tailUnmeasured).toBe(1 + (4 + 1 + 1));
  });
});

describe('evalPasskBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'eval-passk-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** Write journal lines as the schedule's append sink would. */
  async function journal(name: string, lines: string[]): Promise<string> {
    const dir = join(home, '.ashlr', 'logs');
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, lines.join('\n') + '\n');
    return path;
  }
  const opts = (journalPath: string, repo = 'ashlrai/phantom') => ({ repo, journalPath, now: NOW });

  it('emits the skips item at the recorded-verdict bar', async () => {
    const path = await journal('eval-passk.jsonl', [
      reportDoc(6 * DAY),
      ...skipLines(EVAL_PASSK_MIN_SKIPS),
    ]);
    const items = await evalPasskBacklogItems(opts(path));
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ id: 'eval-passk-skips', priority: 3, repo: 'ashlrai/phantom', area: 'passk-eval' });
    expect(item!.prompt).toContain('eval-passk.jsonl');
    expect(item!.prompt).toContain('phm eval passk');
    expect(item!.prompt).toContain('skipped');
    expect(item!.prompt).toContain(iso(6 * DAY));
    expect(item!.prompt).toContain('no-change');
  });

  it('emits nothing below the skip bar or once a report lands again', async () => {
    // A recent report keeps the thin tail out of the stale axis too.
    const two = await journal('two.jsonl', [reportDoc(DAY), ...skipLines(EVAL_PASSK_MIN_SKIPS - 1)]);
    expect(await evalPasskBacklogItems(opts(two))).toEqual([]);

    // Three skips then a healthy report: the tail recovered.
    const recovered = await journal('recovered.jsonl', [
      reportDoc(6 * DAY),
      ...skipLines(EVAL_PASSK_MIN_SKIPS),
      reportDoc(DAY),
    ]);
    expect(await evalPasskBacklogItems(opts(recovered))).toEqual([]);
  });

  it('emits the failures item on error verdicts, crash clusters and abandoned fragments', async () => {
    // Two `error:` runs and one crash cluster land as gap stderr after
    // the report; two torn document fragments follow — the first is
    // abandoned by the second's column-0 `{`, the second stays an open
    // tail (fresh mtime: possibly a run in flight, so not counted).
    const tail = await journal('fails-tail.jsonl', [
      reportDoc(5 * DAY),
      'error: could not publish the report',
      'error: could not read the pass^k dataset',
      ...crashLines(),
      '{\n  "report": {\n    "schema": "eval.passk.v1",',
      '{\n  "report": {\n    "schema": "eval.passk.v1",',
    ]);
    const items = await evalPasskBacklogItems(opts(tail));
    expect(items.map((i) => i.id)).toEqual(['eval-passk-failures']);
    const [item] = items;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('phm eval passk');
    expect(item!.prompt).toContain('2 `error:` verdict(s)');
    expect(item!.prompt).toContain('1 crash cluster(s)');
    expect(item!.prompt).toContain('1 abandoned document fragment(s)');
    expect(item!.prompt).not.toContain('unterminated tail document untouched');
  });

  it('counts a stale unterminated tail as one crashed run', async () => {
    // A fresh open tail is possibly a run in flight — coverage only.
    // The report is recent so the stale axis stays out of the way.
    const fresh = await journal('torn-fresh.jsonl', [
      reportDoc(DAY),
      'error: could not publish the report',
      'error: could not read the pass^k dataset',
      '{\n  "report": {\n    "schema": "eval.passk.v1",',
    ]);
    // 2 error verdicts + 1 open tail (fresh) = 2 failures — below bar.
    expect(await evalPasskBacklogItems(opts(fresh))).toEqual([]);

    // Back-date the mtime past the in-flight bound: the fragment is a
    // torn write, one probable crashed run — 3 failures total.
    const old = new Date(NOW_MS - EVAL_PASSK_IN_FLIGHT_MS - DAY);
    await utimes(fresh, old, old);
    const items = await evalPasskBacklogItems(opts(fresh));
    expect(items.map((i) => i.id)).toEqual(['eval-passk-failures']);
    expect(items[0]!.prompt).toContain('unterminated tail document untouched for over six hours');
  });

  it('folds a records-free all-stderr journal into the failures item', async () => {
    const path = await journal('all-dead.jsonl', [
      'error: could not read the pass^k dataset',
      'error: could not publish the report',
      'error: runPassKEval blew up',
    ]);
    const items = await evalPasskBacklogItems(opts(path));
    expect(items.map((i) => i.id)).toEqual(['eval-passk-failures']);
    expect(items[0]!.prompt).toContain('no report has ever landed');
  });

  it('emits the stale item for an old report with a thin unmeasured tail', async () => {
    const oldEnough = Math.ceil(EVAL_PASSK_STALE_MS / DAY) * DAY + DAY;
    const path = await journal('stale.jsonl', [
      reportDoc(oldEnough),
      skipLine(),
      'error: could not publish the report',
    ]);
    const items = await evalPasskBacklogItems(opts(path));
    expect(items.map((i) => i.id)).toEqual(['eval-passk-stale']);
    const [item] = items;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('has not landed a report');
    expect(item!.prompt).toContain('skip verdict');
    expect(item!.prompt).toContain('error:');
  });

  it('stays silent on pure silence, recent reports and ambiguous noise', async () => {
    // Journal ends at the report — host-off vs uninstalled is unknowable.
    const silent = await journal('silent.jsonl', [reportDoc(EVAL_PASSK_STALE_MS + 5 * DAY)]);
    expect(await evalPasskBacklogItems(opts(silent))).toEqual([]);

    // Recent report plus a thin tail: nothing recurring, nothing stale.
    const fresh = await journal('fresh.jsonl', [reportDoc(DAY), skipLine(), 'a warning']);
    expect(await evalPasskBacklogItems(opts(fresh))).toEqual([]);

    // Old report but only unclassified noise after it: no definite
    // unmeasured run, so the stale axis stays silent too.
    const noisy = await journal('noisy.jsonl', [reportDoc(EVAL_PASSK_STALE_MS + 5 * DAY), 'a warning', 'another warning']);
    expect(await evalPasskBacklogItems(opts(noisy))).toEqual([]);
  });

  it('emits skips and failures together on a mixed tail, suppressing stale', async () => {
    const path = await journal('mixed.jsonl', [
      reportDoc(EVAL_PASSK_STALE_MS + 4 * DAY),
      ...skipLines(EVAL_PASSK_MIN_SKIPS),
      ...errorLines(EVAL_PASSK_MIN_FAILURES),
    ]);
    const items = await evalPasskBacklogItems(opts(path));
    expect(items.map((i) => i.id).sort()).toEqual(['eval-passk-failures', 'eval-passk-skips']);
  });

  it('emits nothing on missing, foreign-repo or noise-only evidence', async () => {
    expect(await evalPasskBacklogItems(opts(join(home, 'no-such.jsonl')))).toEqual([]);
    const noise = await journal('noise.jsonl', ['plain stderr', '{"half":']);
    expect(await evalPasskBacklogItems(opts(noise))).toEqual([]);
    const path = await journal('eval-passk.jsonl', [reportDoc(6 * DAY), ...skipLines(EVAL_PASSK_MIN_SKIPS)]);
    expect(await evalPasskBacklogItems(opts(path, 'ashlrai/other'))).toEqual([]);
    expect(await evalPasskBacklogItems(opts(path, 'AshlrAI/Phantom'))).toHaveLength(1);
    expect(await evalPasskBacklogItems({ repo: '', journalPath: path, now: NOW })).toEqual([]);
  });

  it('honors homeDir resolution and the limit', async () => {
    const path = await journal('eval-passk.jsonl', [
      reportDoc(6 * DAY),
      ...skipLines(EVAL_PASSK_MIN_SKIPS),
      ...errorLines(EVAL_PASSK_MIN_FAILURES),
    ]);
    const viaHome = await evalPasskBacklogItems({ repo: 'ashlrai/phantom', now: NOW });
    expect(viaHome.map((i) => i.id).sort()).toEqual(['eval-passk-failures', 'eval-passk-skips']);
    const viaOpts = await evalPasskBacklogItems({ repo: 'ashlrai/phantom', homeDir: home, journalPath: path, now: NOW });
    expect(viaOpts.map((i) => i.id).sort()).toEqual(viaHome.map((i) => i.id).sort());
    expect(await evalPasskBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW, limit: 1 })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const path = await journal('eval-passk.jsonl', [reportDoc(6 * DAY), ...skipLines(EVAL_PASSK_MIN_SKIPS + 1)]);
    const first = await evalPasskBacklogItems(opts(path));
    const second = await evalPasskBacklogItems(opts(path));
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends eval-passk items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await journal('eval-passk.jsonl', [reportDoc(6 * DAY), ...skipLines(EVAL_PASSK_MIN_SKIPS)]);
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const passkItems = first.items.filter((i) => i.id.startsWith('eval-passk-'));
      expect(passkItems.map((i) => i.id)).toEqual(['eval-passk-skips']);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(passkItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('eval-passk-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('eval-passk-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
