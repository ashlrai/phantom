import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { branchGardenerBacklogItems } from '../src/core/improve/branch-gardener-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-branchgardener-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
/** Epoch seconds `days` before NOW (fractional hours allowed via `hours`). */
const at = (days: number, hours = 0): number => NOW_S - days * 86400 + hours * 3600;

const REPO = 'ashlrai/phantom';

interface BranchRow {
  branch: string;
  action: 'keep' | 'delete' | 'flag';
  reason: string;
  result: 'planned' | 'retained' | 'guard-changed' | 'failed-or-uncertain' | 'deleted';
}

interface JournalRow {
  schema?: string;
  at?: number;
  repo?: string;
  event?: string;
  dry_run?: boolean;
  rows?: BranchRow[];
  counts?: Record<string, number>;
  error?: string | null;
}

const keep = (branch: string): BranchRow => ({ branch, action: 'keep', reason: 'protected', result: 'retained' });
const flag = (branch: string, reason = 'pr-less-unique-or-recent'): BranchRow => ({ branch, action: 'flag', reason, result: 'retained' });
const failedDelete = (branch: string): BranchRow => ({ branch, action: 'delete', reason: 'stale-no-unique-commits', result: 'failed-or-uncertain' });

/** One `result` event — the authoritative per-repo report the fold reads. */
const result = (repo: string, atSec: number, rows: BranchRow[], error: string | null = null): JournalRow => ({
  schema: 'branch-gardener.v1', at: atSec, repo, event: 'result', rows, counts: {}, error,
});
/** A `plan` event — pre-apply snapshot the fold must ignore. */
const plan = (repo: string, atSec: number, rows: BranchRow[]): JournalRow => ({
  schema: 'branch-gardener.v1', at: atSec, repo, event: 'plan', dry_run: true, rows,
});

const journal = (rows: Array<JournalRow | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<JournalRow | string> | string): string => {
  const file = path.join(home, 'branch-gardener.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

/** Two branches flagged on audits two days apart — the persisting triage list. */
const strandedRows = (repo = REPO): JournalRow[] => [
  result(repo, at(1), [keep('master'), flag('fleet/stale-alpha'), flag('fleet/stale-beta', 'tip-changed-after-pr'), flag('fleet/fresh-gamma')]),
  result(repo, at(3), [keep('master'), flag('fleet/stale-alpha'), flag('fleet/stale-beta', 'tip-changed-after-pr')]),
];

describe('branchGardenerBacklogItems', () => {
  it('turns persistently flagged branches into a valid priority-3 backlog item', async () => {
    const items = await branchGardenerBacklogItems({ repo: REPO, journalPath: writeJournal(strandedRows()), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^branch-gardener-stranded-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'branch-gardener' });
    expect(item.title).toContain('stuck flagged');
    expect(item.prompt).toContain('2 branch(es) stayed flagged');
    expect(item.prompt).toContain("'fleet/stale-alpha'");
    expect(item.prompt).toContain("'fleet/stale-beta'");
    // The single-observation branch never counts as persisting.
    expect(item.prompt).not.toContain('fresh-gamma');
    expect(item.prompt).toContain('5 flag observation(s) across 3 distinct branch(es)');
    expect(item.prompt).toContain('branch-gardener.jsonl');
    expect(item.prompt).toContain('branch-gardener.py');
    expect(item.prompt).toContain('no-change');
  });

  it('stays quiet below the persisting-branch bar, inside the span bar, or on non-result events', async () => {
    // Only one branch persists — below BRANCH_GARDENER_STRANDED_MIN_BRANCHES.
    const one = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        result(REPO, at(1), [flag('fleet/only-one')]),
        result(REPO, at(3), [flag('fleet/only-one')]),
      ]),
    });
    expect(one).toEqual([]);
    // Two branches but every observation inside a 24h span.
    const quick = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        result(REPO, at(1), [flag('fleet/alpha'), flag('fleet/beta')]),
        result(REPO, at(1, 12), [flag('fleet/alpha'), flag('fleet/beta')]),
      ]),
    });
    expect(quick).toEqual([]);
    // Flag rows on plan/delete-intent events alone never fold — result events are authoritative.
    const planOnly = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        plan(REPO, at(1), [flag('fleet/alpha'), flag('fleet/beta')]),
        { schema: 'branch-gardener.v1', at: at(3), repo: REPO, event: 'delete-intent', rows: [flag('fleet/alpha'), flag('fleet/beta')] },
      ]),
    });
    expect(planOnly).toEqual([]);
    // Keep/delete/retained rows are explained outcomes, never stranded work.
    const clean = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        result(REPO, at(1), [keep('master'), { branch: 'fleet/old', action: 'delete', reason: 'merged-pr', result: 'deleted' }]),
        result(REPO, at(3), [keep('master')]),
      ]),
    });
    expect(clean).toEqual([]);
  });

  it('turns recurring failed-or-uncertain deletes into a delete item', async () => {
    const rows: JournalRow[] = [
      result(REPO, at(1), [failedDelete('fleet/gone-a'), failedDelete('fleet/gone-b')]),
      result(REPO, at(1, 8), [failedDelete('fleet/gone-c')]),
      result(REPO, at(3), [failedDelete('fleet/gone-d'), failedDelete('fleet/gone-e')]),
      result(REPO, at(5), [keep('master')]),
    ];
    const items = await branchGardenerBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^branch-gardener-delete-uncertain-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'branch-gardener' });
    expect(item.prompt).toContain('5 failed-or-uncertain row(s) across 2 distinct UTC day(s)');
    expect(item.prompt).toContain('5 distinct branch(es)');
    expect(item.prompt).toContain('push --delete');
    expect(item.prompt).toContain('no-change');
  });

  it('keeps delete failures quiet below the row or day bar', async () => {
    // Enough rows but all on one UTC day.
    const oneDay = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        result(REPO, at(1), [failedDelete('fleet/a'), failedDelete('fleet/b'), failedDelete('fleet/c'), failedDelete('fleet/d')]),
        result(REPO, at(1, 8), [failedDelete('fleet/e')]),
      ]),
    });
    expect(oneDay).toEqual([]);
    // Two days but below the row bar.
    const few = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        result(REPO, at(1), [failedDelete('fleet/a')]),
        result(REPO, at(3), [failedDelete('fleet/b')]),
      ]),
    });
    expect(few).toEqual([]);
  });

  it('turns recurring per-repo audit errors into an audit item', async () => {
    const rows: JournalRow[] = [
      result(REPO, at(1), [keep('master')], 'evidence-unavailable-or-invalid'),
      result(REPO, at(2), [keep('master')], 'evidence-unavailable-or-invalid'),
      result(REPO, at(4), [keep('master')], 'gardener-refused-config-lock-or-audit'),
      result(REPO, at(6), [keep('master')], null),
    ];
    const items = await branchGardenerBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^branch-gardener-audit-error-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'branch-gardener' });
    expect(item.prompt).toContain('3 errored result event(s)');
    expect(item.prompt).toContain('evidence-unavailable-or-invalid');
    expect(item.prompt).toContain('no-change');
  });

  it('keeps audit errors quiet on a single day or clean passes', async () => {
    const sameDay = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        result(REPO, at(1), [], 'evidence-unavailable-or-invalid'),
        result(REPO, at(1, 8), [], 'evidence-unavailable-or-invalid'),
      ]),
    });
    expect(sameDay).toEqual([]);
    const clean = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([result(REPO, at(1), [keep('master')], null), result(REPO, at(3), [keep('master')], null)]),
    });
    expect(clean).toEqual([]);
  });

  it('emits all three buckets in a fixed order and honours the limit', async () => {
    const rows: JournalRow[] = [
      ...strandedRows(),
      result(REPO, at(2), [failedDelete('fleet/x1'), failedDelete('fleet/x2')]),
      result(REPO, at(4), [failedDelete('fleet/x3'), failedDelete('fleet/x4')]),
      result(REPO, at(5), [keep('master')], 'evidence-unavailable-or-invalid'),
      result(REPO, at(6), [keep('master')], 'evidence-unavailable-or-invalid'),
    ];
    const items = await branchGardenerBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items).toHaveLength(3);
    expect(items[0]!.id).toMatch(/^branch-gardener-stranded-/);
    expect(items[1]!.id).toMatch(/^branch-gardener-delete-uncertain-/);
    expect(items[2]!.id).toMatch(/^branch-gardener-audit-error-/);
    const one = await branchGardenerBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(items[0]!.id);
  });

  it('ignores rows for other repositories and matches case-insensitively', async () => {
    const foreign = strandedRows('ashlrai/lexicon');
    expect(await branchGardenerBacklogItems({ repo: REPO, journalPath: writeJournal(foreign), now: NOW })).toEqual([]);
    // Fork remotes audit their own branch namespace — masonwyatt23 rows never land on ashlrai.
    const fork = strandedRows('masonwyatt23/phantom');
    expect(await branchGardenerBacklogItems({ repo: REPO, journalPath: writeJournal(fork), now: NOW })).toEqual([]);
    const mixed = strandedRows('AshlrAI/Phantom');
    const items = await branchGardenerBacklogItems({ repo: REPO, journalPath: writeJournal(mixed), now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: REPO });
  });

  it('drops events outside the 7-day window', async () => {
    const stale = strandedRows().map((row) => {
      const r = row as JournalRow;
      return { ...r, at: (r.at ?? 0) - 10 * 86400 };
    });
    expect(await branchGardenerBacklogItems({ repo: REPO, journalPath: writeJournal(stale), now: NOW })).toEqual([]);
  });

  it('drops events stamped past the evaluation-time future skew', async () => {
    // Both flag observations sit beyond now + skew: corrupt or replayed
    // evidence, no stranded cell.
    const future = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        result(REPO, NOW_S + 7200, [flag('fleet/future-alpha'), flag('fleet/future-beta')]),
        result(REPO, NOW_S + 86400, [flag('fleet/future-alpha'), flag('fleet/future-beta')]),
      ]),
    });
    expect(future).toEqual([]);
    // A future stamp cannot stretch a persisting branch's span either:
    // one real observation plus one beyond the skew leaves a lone flag.
    const stretched = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        result(REPO, at(1), [flag('fleet/alpha'), flag('fleet/beta')]),
        result(REPO, NOW_S + 86400, [flag('fleet/alpha'), flag('fleet/beta')]),
      ]),
    });
    expect(stretched).toEqual([]);
    // Inside the one-minute skew the stamp still counts as same-host drift:
    // the same two branches now span a full day and emit.
    const within = await branchGardenerBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        result(REPO, at(1), [flag('fleet/alpha'), flag('fleet/beta')]),
        result(REPO, NOW_S + 30, [flag('fleet/alpha'), flag('fleet/beta')]),
      ]),
    });
    expect(within).toHaveLength(1);
    expect(within[0]!.id).toMatch(/^branch-gardener-stranded-/);
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await branchGardenerBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeJournal([
      'not json',
      '{"schema":"branch-gardener.v1","at":123,"repo":"ashlrai/phantom","event":"bogus"}',
      '{"schema":"other.v1","at":123,"repo":"ashlrai/phantom","event":"result","rows":[]}',
      '{"schema":"branch-gardener.v1","at":"soon","repo":"ashlrai/phantom","event":"result","rows":[]}',
      '{"schema":"branch-gardener.v1","at":123,"repo":"ashlrai/phantom","event":"result","rows":[{"action":"flag"}]}',
      '{"schema":"branch-gardener.v1","at":123,"repo":"ashlrai/phantom","event":"result","rows":[]}',
    ]);
    expect(await branchGardenerBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
    expect(await branchGardenerBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await branchGardenerBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal(strandedRows());
    const first = await branchGardenerBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await branchGardenerBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // Shifted tallies on the same repo re-derive the same id.
    const grown = writeJournal([...strandedRows(), result(REPO, at(1, 6), [flag('fleet/stale-alpha')])]);
    const third = await branchGardenerBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('scrubs secret-shaped text out of recorded branch names before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const rows: JournalRow[] = [
      result(REPO, at(1), [flag(`fleet/${token}`), flag('fleet/beta')]),
      result(REPO, at(3), [flag(`fleet/${token}`), flag('fleet/beta')]),
    ];
    const items = await branchGardenerBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the default journal path under the runs dir', async () => {
    process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
    const dir = path.join(home, 'runs', 'metrics');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'branch-gardener.jsonl'), journal(strandedRows()));
    const items = await branchGardenerBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^branch-gardener-stranded-/);
  });

  it('appends branch-gardener items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
      const dir = path.join(home, 'runs', 'metrics');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'branch-gardener.jsonl'), journal(strandedRows()));
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const gardener = first.items.filter((i) => i.id.startsWith('branch-gardener-'));
      expect(gardener).toHaveLength(1);
      expect(gardener[0]!.id).toMatch(/^branch-gardener-stranded-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(gardener)).toBe(gardener.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('branch-gardener-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('branch-gardener-'))).toHaveLength(gardener.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
