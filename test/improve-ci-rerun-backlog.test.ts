import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { ciRerunBacklogItems } from '../src/core/improve/ci-rerun-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-cirrerun-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
const daysAgo = (days: number): string => new Date(NOW_MS - days * 86_400_000).toISOString();
const sha = (n: number): string => n.toString(16).padStart(40, '0');

const REPO = 'ashlrai/phantom';
const TEST_A = 'test/alpha.test.ts > suite > keeps failing';
const TEST_B = 'test/beta.test.ts > suite > same head only';
const TEST_C = 'test/gamma.test.ts > suite > mostly passing';

interface Row {
  at: string;
  repo: string;
  head: string;
  runId: number;
  pr: number;
  outcome: 'attempt' | 'ok' | 'failed' | 'verdict';
  test?: string;
  tests?: string[];
  verdict?: 'pass' | 'fail' | 'inconclusive';
}

let runSeq = 0;
/** One probable-flake rerun lifecycle: attempt, the gh call result, then the resolved verdict. */
const rerun = (repo: string, test: string, head: string, pr: number, verdict: 'pass' | 'fail' | 'inconclusive', days: number): Row[] => {
  const runId = 1000 + ++runSeq;
  const at = daysAgo(days);
  return [
    { at, repo, head, runId, pr, outcome: 'attempt', test },
    { at, repo, head, runId, pr, outcome: 'ok', test },
    { at, repo, head, runId, pr, outcome: 'verdict', verdict, test },
  ];
};

const journal = (rows: Row[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Rows for TEST_A failing its reruns on three distinct heads inside the window. */
const failingVerdicts = (repo = REPO): Row[] => [
  ...rerun(repo, TEST_A, sha(1), 11, 'fail', 1),
  ...rerun(repo, TEST_A, sha(2), 12, 'fail', 2),
  ...rerun(repo, TEST_A, sha(3), 13, 'fail', 3),
  ...rerun(repo, TEST_A, sha(4), 14, 'pass', 4),
  ...rerun(repo, TEST_A, sha(5), 15, 'inconclusive', 5),
];

/** Rows for TEST_B: three fail verdicts all on ONE head — recurring count, single head. */
const sameHeadFails = (repo = REPO): Row[] => [
  ...rerun(repo, TEST_B, sha(6), 16, 'fail', 1),
  ...rerun(repo, TEST_B, sha(6), 17, 'fail', 2),
  ...rerun(repo, TEST_B, sha(6), 18, 'fail', 3),
];

const writeJournal = (rows: Row[] | string): string => {
  const file = path.join(home, 'journal.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

describe('ciRerunBacklogItems', () => {
  it('turns recurring fail verdicts into a valid priority-3 backlog item', async () => {
    const items = await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(failingVerdicts()), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^ci-rerun-verdict-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'ci-rerun' });
    expect(item.title).toContain('alpha.test.ts');
    expect(item.prompt).toContain('3 recorded rerun verdicts concluded failure');
    expect(item.prompt).toContain('1 passed, 1 inconclusive');
    expect(item.prompt).toContain('5 rerun attempt rows');
    expect(item.prompt).toContain('3 distinct head(s)');
    expect(item.prompt).toContain('phm ci reruns');
    expect(item.prompt).toContain('phm ci baseline');
    expect(item.prompt).toContain('RQ-CIFLAKE');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('ci-reruns/journal.jsonl');
  });

  it('counts shared attempt evidence once per triggering test without attributing the workflow verdict', async () => {
    const shared = { at: daysAgo(1), repo: REPO, head: sha(7), runId: 7, pr: 7 };
    const items = await ciRerunBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        ...failingVerdicts(),
        { ...shared, outcome: 'attempt', tests: [TEST_A, TEST_B, TEST_A] },
        { ...shared, outcome: 'ok' },
        { ...shared, outcome: 'verdict', verdict: 'fail' },
      ]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.prompt).toContain('6 rerun attempt rows');
    expect(items[0]?.prompt).toContain('3 recorded rerun verdicts concluded failure');
  });

  it('stays quiet below the recurring bar, on a single head, or outside the window', async () => {
    // Two fail verdicts never reach the bar.
    const two = await ciRerunBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([...rerun(REPO, TEST_A, sha(1), 21, 'fail', 1), ...rerun(REPO, TEST_A, sha(2), 22, 'fail', 2)]),
    });
    expect(two).toEqual([]);
    // Three fails on one head is one PR's problem, not a recurring classification failure.
    const oneHead = await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(sameHeadFails()), now: NOW });
    expect(oneHead).toEqual([]);
    // Recurring shape but every row older than the 7-day window.
    const stale = await ciRerunBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        ...rerun(REPO, TEST_A, sha(1), 23, 'fail', 8),
        ...rerun(REPO, TEST_A, sha(2), 24, 'fail', 9),
        ...rerun(REPO, TEST_A, sha(3), 25, 'fail', 10),
      ]),
    });
    expect(stale).toEqual([]);
    // Pass and inconclusive verdicts alone never emit.
    const clean = await ciRerunBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([...rerun(REPO, TEST_C, sha(7), 26, 'pass', 1), ...rerun(REPO, TEST_C, sha(8), 27, 'inconclusive', 2)]),
    });
    expect(clean).toEqual([]);
  });

  it('ignores verdict rows without a test id and rows for other repositories', async () => {
    const untaged: Row[] = [
      { at: daysAgo(1), repo: REPO, head: sha(31), runId: 31, pr: 31, outcome: 'verdict', verdict: 'fail' },
      { at: daysAgo(1), repo: REPO, head: sha(32), runId: 32, pr: 32, outcome: 'verdict', verdict: 'fail' },
      { at: daysAgo(1), repo: REPO, head: sha(33), runId: 33, pr: 33, outcome: 'verdict', verdict: 'fail' },
    ];
    expect(await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(untaged), now: NOW })).toEqual([]);
    // Same recurring shape recorded against a different repository never lands here.
    const foreign = failingVerdicts('ashlrai/lexicon');
    expect(await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(foreign), now: NOW })).toEqual([]);
    // Repo matching is case-insensitive like the sibling sources.
    const mixed = failingVerdicts('AshlrAI/Phantom');
    const items = await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(mixed), now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: REPO });
  });

  it('turns a majority of failed rerun calls into a call item', async () => {
    const rows: Row[] = [
      { at: daysAgo(1), repo: REPO, head: sha(41), runId: 41, pr: 41, outcome: 'failed' },
      { at: daysAgo(1), repo: REPO, head: sha(42), runId: 42, pr: 42, outcome: 'failed' },
      { at: daysAgo(1), repo: REPO, head: sha(43), runId: 43, pr: 43, outcome: 'failed', test: TEST_A },
      { at: daysAgo(1), repo: REPO, head: sha(44), runId: 44, pr: 44, outcome: 'failed', test: TEST_C },
      { at: daysAgo(2), repo: REPO, head: sha(45), runId: 45, pr: 45, outcome: 'ok', test: TEST_C },
      // Other repositories' call failures never land here.
      { at: daysAgo(1), repo: 'ashlrai/lexicon', head: sha(46), runId: 46, pr: 46, outcome: 'failed' },
      { at: daysAgo(1), repo: 'ashlrai/lexicon', head: sha(47), runId: 47, pr: 47, outcome: 'failed' },
      { at: daysAgo(1), repo: 'ashlrai/lexicon', head: sha(48), runId: 48, pr: 48, outcome: 'failed' },
    ];
    const items = await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^ci-rerun-calls-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'ci-rerun' });
    expect(item.title).toContain('rerun calls');
    expect(item.prompt).toContain('4 failed rerun call(s) against 1 successful');
    expect(item.prompt).toContain('ci-reruns/status.json');
    expect(item.prompt).toContain('no-change');
  });

  it('keeps call failures quiet below the bar or when ok calls dominate', async () => {
    const few = await ciRerunBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        { at: daysAgo(1), repo: REPO, head: sha(51), runId: 51, pr: 51, outcome: 'failed' },
        { at: daysAgo(1), repo: REPO, head: sha(52), runId: 52, pr: 52, outcome: 'failed' },
        { at: daysAgo(1), repo: REPO, head: sha(53), runId: 53, pr: 53, outcome: 'ok' },
      ]),
    });
    expect(few).toEqual([]);
    const minority = await ciRerunBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        { at: daysAgo(1), repo: REPO, head: sha(54), runId: 54, pr: 54, outcome: 'failed' },
        { at: daysAgo(1), repo: REPO, head: sha(55), runId: 55, pr: 55, outcome: 'failed' },
        { at: daysAgo(1), repo: REPO, head: sha(56), runId: 56, pr: 56, outcome: 'failed' },
        ...[57, 58, 59, 60].map((n) => ({ at: daysAgo(1), repo: REPO, head: sha(n), runId: n, pr: n, outcome: 'ok' as const })),
      ]),
    });
    expect(minority).toEqual([]);
    const stale = await ciRerunBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        { at: daysAgo(9), repo: REPO, head: sha(61), runId: 61, pr: 61, outcome: 'failed' },
        { at: daysAgo(9), repo: REPO, head: sha(62), runId: 62, pr: 62, outcome: 'failed' },
        { at: daysAgo(9), repo: REPO, head: sha(63), runId: 63, pr: 63, outcome: 'failed' },
        { at: daysAgo(9), repo: REPO, head: sha(64), runId: 64, pr: 64, outcome: 'failed' },
      ]),
    });
    expect(stale).toEqual([]);
  });

  it('orders verdict items deterministically and honours the limit', async () => {
    const rows: Row[] = [
      ...failingVerdicts(),
      // TEST_B recurring fails on three heads so both verdict groups exist.
      ...rerun(REPO, TEST_B, sha(71), 71, 'fail', 1),
      ...rerun(REPO, TEST_B, sha(72), 72, 'fail', 2),
      ...rerun(REPO, TEST_B, sha(73), 73, 'fail', 3),
      { at: daysAgo(1), repo: REPO, head: sha(74), runId: 74, pr: 74, outcome: 'failed' },
      { at: daysAgo(1), repo: REPO, head: sha(75), runId: 75, pr: 75, outcome: 'failed' },
      { at: daysAgo(1), repo: REPO, head: sha(76), runId: 76, pr: 76, outcome: 'failed' },
      { at: daysAgo(1), repo: REPO, head: sha(77), runId: 77, pr: 77, outcome: 'failed' },
    ];
    const items = await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    // 4 failed vs the fixture's ok rows: the call tally must outnumber ok calls.
    // failingVerdicts contributes 5 ok rows, sameHead-style TEST_B adds 3 more → ok=8 > failed=4,
    // so no call item here; the two verdict groups emit instead.
    expect(items.filter((i) => i.id.startsWith('ci-rerun-calls-'))).toHaveLength(0);
    expect(items.filter((i) => i.id.startsWith('ci-rerun-verdict-'))).toHaveLength(2);
    const one = await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(items[0]!.id);
  });

  it('puts the call item first when both kinds recur', async () => {
    const rows: Row[] = [
      ...failingVerdicts(),
      // Enough failed calls to outnumber every ok row in the window.
      ...[81, 82, 83, 84, 85, 86, 87, 88, 89].map((n) => ({ at: daysAgo(1), repo: REPO, head: sha(n), runId: n, pr: n, outcome: 'failed' as const })),
    ];
    const items = await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items[0]!.id).toMatch(/^ci-rerun-calls-/);
    expect(items.filter((i) => i.id.startsWith('ci-rerun-verdict-'))).toHaveLength(1);
    const one = await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 1 });
    expect(one[0]!.id).toMatch(/^ci-rerun-calls-/);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal(failingVerdicts());
    const first = await ciRerunBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await ciRerunBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // Shifted tallies on the same test re-derive the same id.
    const grown = writeJournal([...failingVerdicts(), ...rerun(REPO, TEST_A, sha(90), 90, 'fail', 1)]);
    const third = await ciRerunBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await ciRerunBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeJournal('not json\n{"at":"x"}\n{"at":"2026-11-22T00:00:00Z","repo":"ashlrai/phantom","head":"abc","runId":1,"pr":1,"outcome":"bogus"}\n');
    expect(await ciRerunBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
    expect(await ciRerunBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await ciRerunBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
  });

  it('scrubs secret-shaped text out of the recorded test id before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const rows = [
      ...rerun(REPO, `test/${token}.test.ts > case`, sha(1), 91, 'fail', 1),
      ...rerun(REPO, `test/${token}.test.ts > case`, sha(2), 92, 'fail', 2),
      ...rerun(REPO, `test/${token}.test.ts > case`, sha(3), 93, 'fail', 3),
    ];
    const items = await ciRerunBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
    expect(items[0]!.title).not.toContain(token);
  });

  it('reads the default journal path under ASHLR_HOME', async () => {
    process.env.ASHLR_HOME = path.join(home, '.ashlr');
    const dir = path.join(home, '.ashlr', 'ci-reruns');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), journal(failingVerdicts()));
    const items = await ciRerunBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^ci-rerun-verdict-/);
  });

  it('appends ci-rerun items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_HOME = path.join(home, '.ashlr-e2e');
      process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
      const dir = path.join(home, '.ashlr-e2e', 'ci-reruns');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'journal.jsonl'), journal(failingVerdicts()));
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const rerun = first.items.filter((i) => i.id.startsWith('ci-rerun-'));
      expect(rerun).toHaveLength(1);
      expect(rerun[0]!.id).toMatch(/^ci-rerun-verdict-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(rerun)).toBe(rerun.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('ci-rerun-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('ci-rerun-'))).toHaveLength(rerun.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
