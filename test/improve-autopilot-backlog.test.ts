import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { autopilotBacklogItems, parseAutopilotJournal } from '../src/core/improve/autopilot-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-autopilot-')));
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

const REPO = 'ashlrai/phantom';

interface JournalRow {
  v?: number;
  at?: string;
  repo?: string;
  number?: number;
  headSha?: string;
  plan?: string;
  reason?: string;
  result?: string;
  detail?: string[];
  newHead?: string | null;
}

/** One outcomes-journal row under the writer's v1 contract. */
const row = (over: Partial<JournalRow> & { plan: string; result: string }): JournalRow => ({
  v: 1,
  at: at(1),
  repo: REPO,
  number: 1234,
  headSha: 'a'.repeat(40),
  reason: 'tick reason',
  detail: [],
  newHead: null,
  ...over,
});

const stop = (number: number, reason: string, daysAgo: number, hours = 0): JournalRow =>
  row({ number, plan: 'stop', reason, result: 'none', at: at(daysAgo, hours) });

const journal = (rows: Array<JournalRow | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<JournalRow | string> | string): string => {
  const dir = path.join(home, '.ashlr', 'autopilot');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'outcomes.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

const PUSH_LIMIT = 'reached the push limit (6) on this PR; it needs a person';
const SAME_FAILURE = 'the same failure survived 2 fix attempts (Merge Gate); it needs a person';

describe('parseAutopilotJournal', () => {
  it('keeps contract rows and skips malformed or out-of-vocabulary lines', () => {
    const rows = parseAutopilotJournal(journal([
      'not json',
      '{"v":2,"at":"2026-11-20T00:00:00Z","repo":"ashlrai/phantom","number":1,"plan":"stop","result":"none"}',
      '{"v":1,"at":"not-a-date","repo":"ashlrai/phantom","number":1,"plan":"stop","result":"none"}',
      '{"v":1,"at":"2026-11-20T00:00:00Z","repo":"","number":1,"plan":"stop","result":"none"}',
      '{"v":1,"at":"2026-11-20T00:00:00Z","repo":"ashlrai/phantom","number":0,"plan":"stop","result":"none"}',
      '{"v":1,"at":"2026-11-20T00:00:00Z","repo":"ashlrai/phantom","number":1,"plan":"bogus","result":"none"}',
      '{"v":1,"at":"2026-11-20T00:00:00Z","repo":"ashlrai/phantom","number":1,"plan":"stop","result":"bogus"}',
      row({ plan: 'stop', result: 'none', reason: PUSH_LIMIT, at: at(1) }),
      row({ plan: 'fix-ci', result: 'error', reason: 'x', detail: ['boom', 42 as unknown as string], at: at(2) }),
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ repo: REPO, number: 1234, plan: 'stop', result: 'none', reason: PUSH_LIMIT });
    expect(rows[1]!.detail).toEqual(['boom']);
  });
});

describe('autopilotBacklogItems', () => {
  it('turns a pull request the autopilot keeps handing to a person into a valid item', async () => {
    const items = await autopilotBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        stop(1234, PUSH_LIMIT, 1),
        stop(1234, PUSH_LIMIT, 1, 8),
        stop(1234, SAME_FAILURE, 3),
        stop(1234, PUSH_LIMIT, 5),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^autopilot-needs-person-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'autopilot' });
    expect(item.title).toContain(`${REPO}#1234`);
    expect(item.prompt).toContain('4 \'stop\' decision(s)');
    expect(item.prompt).toContain('3 distinct UTC day(s)');
    expect(item.prompt).toContain('reached the push limit (6)');
    expect(item.prompt).toContain('the same failure survived 2 fix attempts');
    expect(item.prompt).toContain('autopilot/outcomes.jsonl');
    expect(item.prompt).toContain('no-change');
  });

  it('never counts deliberate-off stops: kill switch, pause and foreign PRs', async () => {
    const items = await autopilotBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        stop(1234, 'the kill switch is engaged; nothing runs until it is cleared', 1),
        stop(1234, 'the kill switch is engaged; nothing runs until it is cleared', 2),
        stop(1234, 'Phantom is paused; resume to let the autopilot act', 3),
        stop(1234, "not this autopilot's PR: PR #1234 was opened by someone-else, not viewer", 4),
        stop(1234, 'Phantom is paused; resume to let the autopilot act', 5),
      ]),
    });
    expect(items).toEqual([]);
  });

  it('keeps per-PR stop cells quiet below the row or day bar and splits PRs', async () => {
    // Enough rows but all on one UTC day (Nov 22: 04:00, 12:00 and 16:00).
    const oneDay = await autopilotBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([stop(1234, PUSH_LIMIT, 1, -8), stop(1234, PUSH_LIMIT, 1), stop(1234, PUSH_LIMIT, 1, 4)]),
    });
    expect(oneDay).toEqual([]);
    // Two days but below the row bar.
    const few = await autopilotBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([stop(1234, PUSH_LIMIT, 1), stop(1234, PUSH_LIMIT, 3)]),
    });
    expect(few).toEqual([]);
    // Two PRs each recurring: two items, one per PR.
    const two = await autopilotBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        stop(1234, PUSH_LIMIT, 1), stop(1234, PUSH_LIMIT, 1, 8), stop(1234, PUSH_LIMIT, 4),
        stop(5678, SAME_FAILURE, 1), stop(5678, SAME_FAILURE, 2), stop(5678, SAME_FAILURE, 5),
      ]),
    });
    expect(two).toHaveLength(2);
    expect(new Set(two.map((i) => i.id)).size).toBe(2);
    expect(two.every((i) => i.id.startsWith('autopilot-needs-person-'))).toBe(true);
    expect(two.some((i) => i.prompt.includes('#1234'))).toBe(true);
    expect(two.some((i) => i.prompt.includes('#5678'))).toBe(true);
  });

  it('turns recurring error results into a tick-error item', async () => {
    const items = await autopilotBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row({ plan: 'wait', result: 'error', reason: 'could not read the PR: gh api failed', detail: ['could not read the PR: HTTP 502'], number: 111, at: at(1) }),
        row({ plan: 'fix-ci', result: 'error', reason: 'merge failed without conflicts', detail: ['merge failed without conflicts: fatal: refusing'], number: 222, at: at(1, 8) }),
        row({ plan: 'wait', result: 'error', reason: 'could not read the PR: gh api failed', detail: ['could not read the PR: HTTP 502'], number: 333, at: at(3) }),
        row({ plan: 'wait', result: 'none', reason: 'checks still running', number: 444, at: at(2) }),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^autopilot-tick-error-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('3 row(s) across 2 distinct UTC day(s)');
    expect(item.prompt).toContain('3 distinct pull request(s)');
    expect(item.prompt).toContain('#111');
    expect(item.prompt).toContain('could not read the PR');
    expect(item.prompt).toContain('no-change');
  });

  it('turns recurring verify-failed results into a verify item', async () => {
    const items = await autopilotBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row({ plan: 'fix-ci', result: 'verify-failed', reason: '2 check(s) failed', detail: ['verify failed: npm run check exited 1'], number: 111, at: at(1) }),
        row({ plan: 'address-review', result: 'verify-failed', reason: '1 review item(s)', detail: ['verify failed: vitest related exited 1'], number: 222, at: at(2) }),
        row({ plan: 'merge-base', result: 'verify-failed', reason: 'behind base', detail: ['verify failed: tsc exited 2'], number: 333, at: at(4) }),
      ]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^autopilot-verify-failed-[0-9a-f]{16}$/);
    expect(items[0]!.prompt).toContain('verify-failed');
    expect(items[0]!.prompt).toContain('verifyPlan');
  });

  it('turns recurring refused results into a refused item but never kill-switch or pause refusals', async () => {
    const items = await autopilotBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row({ plan: 'fix-ci', result: 'refused', reason: '2 check(s) failed', detail: ['the fixer moved HEAD (commits are the autopilot\'s job); nothing pushed'], number: 111, at: at(1) }),
        row({ plan: 'recut', result: 'refused', reason: 'conflicts with master', detail: ['conflict markers remain in src/x.ts'], number: 222, at: at(2) }),
        row({ plan: 'fix-ci', result: 'refused', reason: '2 check(s) failed', detail: ['push refused: ! [remote rejected]'], number: 333, at: at(4) }),
        // Deliberate-off refusals: engaged kill switch / pause mid-act.
        row({ plan: 'fix-ci', result: 'refused', reason: '2 check(s) failed', detail: ['the kill switch was engaged while acting; nothing pushed'], number: 444, at: at(1, 8) }),
        row({ plan: 'fix-ci', result: 'refused', reason: '2 check(s) failed', detail: ['Phantom was paused while acting; nothing pushed'], number: 555, at: at(3, 8) }),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^autopilot-refused-[0-9a-f]{16}$/);
    expect(item.prompt).toContain('3 row(s) across 3 distinct UTC day(s)');
    expect(item.prompt).toContain('the fixer moved HEAD');
    expect(item.prompt).not.toContain('kill switch was engaged');
    expect(item.prompt).not.toContain('paused while acting');
  });

  it('counts empty fixer diffs only on fix-ci and address-review plans', async () => {
    const items = await autopilotBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row({ plan: 'fix-ci', result: 'no-change', reason: '2 check(s) failed', detail: ['the fixer changed nothing'], number: 111, at: at(1) }),
        row({ plan: 'address-review', result: 'no-change', reason: '1 review item(s)', detail: ['the fixer changed nothing'], number: 222, at: at(2) }),
        row({ plan: 'fix-ci', result: 'no-change', reason: '2 check(s) failed', detail: ['the fixer changed nothing'], number: 333, at: at(4) }),
        // Benign no-change rows on merge plans never count.
        row({ plan: 'merge-base', result: 'no-change', reason: 'behind master', detail: ['already up to date with the base'], number: 444, at: at(1, 8) }),
        row({ plan: 'recut', result: 'no-change', reason: 'conflicts with master', detail: ["the PR's changes are already in master; there is nothing to recut"], number: 555, at: at(3) }),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^autopilot-empty-fix-[0-9a-f]{16}$/);
    expect(item.prompt).toContain('3 row(s) across 3 distinct UTC day(s)');
    expect(item.prompt).toContain('the fixer changed nothing');
    expect(item.prompt).not.toContain('already up to date');
  });

  it('emits all cell kinds in a fixed order and honours the limit', async () => {
    const stops = [
      stop(1234, PUSH_LIMIT, 1), stop(1234, PUSH_LIMIT, 1, 8), stop(1234, PUSH_LIMIT, 4),
    ];
    const rows: JournalRow[] = [
      ...stops,
      row({ plan: 'wait', result: 'error', reason: 'e', detail: ['d'], number: 1, at: at(1) }),
      row({ plan: 'wait', result: 'error', reason: 'e', detail: ['d'], number: 2, at: at(2) }),
      row({ plan: 'wait', result: 'error', reason: 'e', detail: ['d'], number: 3, at: at(3) }),
      row({ plan: 'fix-ci', result: 'verify-failed', reason: 'r', detail: ['v'], number: 4, at: at(1) }),
      row({ plan: 'fix-ci', result: 'verify-failed', reason: 'r', detail: ['v'], number: 5, at: at(2) }),
      row({ plan: 'fix-ci', result: 'verify-failed', reason: 'r', detail: ['v'], number: 6, at: at(3) }),
      row({ plan: 'fix-ci', result: 'refused', reason: 'r', detail: ['x'], number: 7, at: at(1) }),
      row({ plan: 'fix-ci', result: 'refused', reason: 'r', detail: ['x'], number: 8, at: at(2) }),
      row({ plan: 'fix-ci', result: 'refused', reason: 'r', detail: ['x'], number: 9, at: at(3) }),
      row({ plan: 'fix-ci', result: 'no-change', reason: 'r', detail: ['n'], number: 10, at: at(1) }),
      row({ plan: 'fix-ci', result: 'no-change', reason: 'r', detail: ['n'], number: 11, at: at(2) }),
      row({ plan: 'fix-ci', result: 'no-change', reason: 'r', detail: ['n'], number: 12, at: at(3) }),
    ];
    const items = await autopilotBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items).toHaveLength(5);
    expect(items[0]!.id).toMatch(/^autopilot-needs-person-/);
    expect(items[1]!.id).toMatch(/^autopilot-tick-error-/);
    expect(items[2]!.id).toMatch(/^autopilot-verify-failed-/);
    expect(items[3]!.id).toMatch(/^autopilot-refused-/);
    expect(items[4]!.id).toMatch(/^autopilot-empty-fix-/);
    const one = await autopilotBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 2 });
    expect(one.map((i) => i.id)).toEqual(items.slice(0, 2).map((i) => i.id));
  });

  it('ignores rows for other repositories and matches case-insensitively', async () => {
    const foreign = [
      stop(1234, PUSH_LIMIT, 1), stop(1234, PUSH_LIMIT, 3),
    ].map((r) => ({ ...r, repo: 'ashlrai/lexicon' }));
    expect(await autopilotBacklogItems({ repo: REPO, journalPath: writeJournal(foreign), now: NOW })).toEqual([]);
    // A fork's own autopilot journal never lands on the upstream repo.
    const fork = [
      stop(1234, PUSH_LIMIT, 1), stop(1234, PUSH_LIMIT, 3),
    ].map((r) => ({ ...r, repo: 'masonwyatt23/phantom' }));
    expect(await autopilotBacklogItems({ repo: REPO, journalPath: writeJournal(fork), now: NOW })).toEqual([]);
    const mixed = [
      { ...stop(1234, PUSH_LIMIT, 1), repo: 'AshlrAI/Phantom' },
      { ...stop(1234, PUSH_LIMIT, 1, 8), repo: 'AshlrAI/Phantom' },
      { ...stop(1234, PUSH_LIMIT, 4), repo: 'AshlrAI/Phantom' },
    ];
    const items = await autopilotBacklogItems({ repo: REPO, journalPath: writeJournal(mixed), now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: REPO });
  });

  it('drops rows outside the 7-day window and beyond the future-skew allowance', async () => {
    const stale = [
      stop(1234, PUSH_LIMIT, 8), stop(1234, PUSH_LIMIT, 9), stop(1234, PUSH_LIMIT, 10),
    ];
    expect(await autopilotBacklogItems({ repo: REPO, journalPath: writeJournal(stale), now: NOW })).toEqual([]);
    const future = [
      stop(1234, PUSH_LIMIT, -1), stop(1234, PUSH_LIMIT, -1, 1), stop(1234, PUSH_LIMIT, -1, 2),
    ];
    expect(await autopilotBacklogItems({ repo: REPO, journalPath: writeJournal(future), now: NOW })).toEqual([]);
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await autopilotBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeJournal([
      'not json',
      '{"v":1,"at":"2026-11-20T00:00:00Z","repo":"ashlrai/phantom","number":1,"plan":"stop","result":"bogus"}',
      '{"schema":"other.v1","at":"2026-11-20T00:00:00Z","repo":"ashlrai/phantom","plan":"stop","result":"none"}',
    ]);
    expect(await autopilotBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
    expect(await autopilotBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await autopilotBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const rows = [
      stop(1234, PUSH_LIMIT, 1), stop(1234, PUSH_LIMIT, 1, 8), stop(1234, PUSH_LIMIT, 4),
    ];
    const file = writeJournal(rows);
    const first = await autopilotBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await autopilotBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // Shifted tallies on the same PR re-derive the same id.
    const grown = writeJournal([...rows, stop(1234, SAME_FAILURE, 2)]);
    const third = await autopilotBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('scrubs secret-shaped text out of recorded reasons and details before they reach a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const rows: JournalRow[] = [
      stop(1234, `reached the push limit (6); token ${token} leaked`, 1),
      stop(1234, `reached the push limit (6); token ${token} leaked`, 3),
      stop(1234, `reached the push limit (6); token ${token} leaked`, 5),
      row({ plan: 'fix-ci', result: 'verify-failed', reason: 'r', detail: [`verify saw ${token}`], number: 1, at: at(1) }),
      row({ plan: 'fix-ci', result: 'verify-failed', reason: 'r', detail: [`verify saw ${token}`], number: 2, at: at(2) }),
      row({ plan: 'fix-ci', result: 'verify-failed', reason: 'r', detail: [`verify saw ${token}`], number: 3, at: at(4) }),
    ];
    const items = await autopilotBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(item.prompt).not.toContain(token);
    }
    expect(items.some((i) => i.prompt.includes('[REDACTED]'))).toBe(true);
  });

  it('reads the default journal path under the Ashlr home', async () => {
    // writeJournal already placed the file at <home>/.ashlr/autopilot/outcomes.jsonl.
    writeJournal([stop(1234, PUSH_LIMIT, 1), stop(1234, PUSH_LIMIT, 3), stop(1234, PUSH_LIMIT, 5)]);
    const items = await autopilotBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^autopilot-needs-person-/);
  });

  it('appends autopilot items through discovery and dedupes on refresh', async () => {
    writeJournal([stop(1234, PUSH_LIMIT, 1), stop(1234, PUSH_LIMIT, 3), stop(1234, PUSH_LIMIT, 5)]);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const autopilot = first.items.filter((i) => i.id.startsWith('autopilot-'));
    expect(autopilot).toHaveLength(1);
    expect(autopilot[0]!.id).toMatch(/^autopilot-needs-person-/);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(autopilot)).toBe(autopilot.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('autopilot-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('autopilot-'))).toHaveLength(autopilot.length);
  });
});
