import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldSpawnProposals,
  SPAWN_MIN_DUP_ONLY_ROWS,
  SPAWN_MIN_FLEET_DUP_ROWS,
  SPAWN_MIN_FLEET_PARENTS,
  SPAWN_PROPOSALS_WINDOW_HOURS,
  spawnProposalCells,
  spawnProposalsBacklogItems,
} from '../src/core/improve/spawn-proposals-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the journal writer's at. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One spawn-proposal journal row in the writer's SpawnJournalEntry shape. */
function proposalRow(spec: {
  atMs?: number;
  parent?: string;
  owner?: string;
  proposed?: number;
  applied?: number;
  duplicates?: number;
  at?: string | null;
  extra?: Record<string, unknown>;
}): string {
  const proposed = spec.proposed ?? 4;
  const applied = spec.applied ?? 0;
  const duplicates = spec.duplicates ?? proposed - applied;
  const at = spec.at === undefined ? iso(spec.atMs ?? NOW_MS) : spec.at;
  return J({
    v: 1,
    at,
    parent: spec.parent ?? 'RQ-PARENT-1',
    owner: spec.owner ?? 'agent-alpha',
    proposed,
    applied,
    duplicates,
    ...spec.extra,
  });
}

/**
 * Rows for one parent inside the window. `dupOnly` rows have applied 0
 * and every child duplicated; `partial` rows mix applied and duplicate
 * drops; `clean` rows apply everything.
 */
function parentRows(opts: {
  parent: string;
  owner?: string;
  dupOnly?: number;
  partial?: number;
  clean?: number;
  spreadMs?: number;
}): string[] {
  const rows: string[] = [];
  const spread = opts.spreadMs ?? HOUR;
  let i = 0;
  const push = (applied: number, duplicates: number, proposed?: number) => {
    rows.push(proposalRow({
      atMs: NOW_MS - i++ * spread,
      parent: opts.parent,
      owner: opts.owner,
      proposed: proposed ?? applied + duplicates,
      applied,
      duplicates,
    }));
  };
  for (let d = 0; d < (opts.dupOnly ?? 0); d++) push(0, 4);
  for (let d = 0; d < (opts.partial ?? 0); d++) push(2, 2);
  for (let d = 0; d < (opts.clean ?? 0); d++) push(4, 0);
  return rows;
}

/** The production fold: one journal text (the single append-only file). */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldSpawnProposals([rows.join('\n')], nowMs, SPAWN_PROPOSALS_WINDOW_HOURS);
}

describe('foldSpawnProposals', () => {
  it('counts in-window proposals and skips foreign shapes without guessing', () => {
    const rows = [
      proposalRow({ atMs: NOW_MS - HOUR, parent: 'RQ-A', proposed: 4, applied: 0, duplicates: 4 }),
      proposalRow({ atMs: NOW_MS - 2 * HOUR, parent: 'RQ-B', proposed: 4, applied: 3, duplicates: 1 }),
      // Outside the window — too old and too far in the future.
      proposalRow({ atMs: NOW_MS - SPAWN_PROPOSALS_WINDOW_HOURS * 3_600_000 - DAY }),
      proposalRow({ atMs: NOW_MS + 600_000 }),
      // Malformed JSON and non-object rows.
      'not json at all',
      '[1,2,3]',
      'null',
      // Foreign shapes — the store contract rejects them all.
      J({ at: iso(NOW_MS), parent: 'RQ-A', owner: 'o', proposed: 1, applied: 0, duplicates: 1 }), // no v
      J({ v: 2, at: iso(NOW_MS), parent: 'RQ-A', owner: 'o', proposed: 1, applied: 0, duplicates: 1 }),
      J({ v: 1, at: 'not-a-date', parent: 'RQ-A', owner: 'o', proposed: 1, applied: 0, duplicates: 1 }),
      J({ v: 1, at: iso(NOW_MS), parent: '-bad', owner: 'o', proposed: 1, applied: 0, duplicates: 1 }),
      J({ v: 1, at: iso(NOW_MS), parent: 'RQ-A', owner: '', proposed: 1, applied: 0, duplicates: 1 }),
      J({ v: 1, at: iso(NOW_MS), parent: 'RQ-A', owner: 'o'.repeat(200), proposed: 1, applied: 0, duplicates: 1 }),
      J({ v: 1, at: iso(NOW_MS), parent: 'RQ-A', owner: 'o', proposed: 1.5, applied: 0, duplicates: 1 }),
      J({ v: 1, at: iso(NOW_MS), parent: 'RQ-A', owner: 'o', proposed: -1, applied: 0, duplicates: 1 }),
      J({ v: 1, at: iso(NOW_MS), parent: 'RQ-A', owner: 'o', proposed: 200_000, applied: 0, duplicates: 1 }),
      J({ v: 1, at: iso(NOW_MS), parent: 'RQ-A', owner: 'o', proposed: 4, applied: 0 }), // missing duplicates
      '{"v":1,"at":"2026',
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.proposals).toBe(2);
    expect(fold.malformed).toBe(14);
    expect(fold.outsideWindow).toBe(2);
    expect([...fold.parents.keys()].sort()).toEqual(['RQ-A', 'RQ-B']);
  });

  it('folds per-parent totals and classifies all-duplicate, partial and clean rows', () => {
    const rows = [
      ...parentRows({ parent: 'RQ-A', owner: 'agent-alpha', dupOnly: 3, partial: 1, clean: 1 }),
      ...parentRows({ parent: 'RQ-B', owner: 'agent-beta', dupOnly: 1, clean: 2 }),
      // A second owner on RQ-A — claim holders are tracked as a set.
      proposalRow({ atMs: NOW_MS - 5 * HOUR, parent: 'RQ-A', owner: 'agent-gamma', proposed: 2, applied: 0, duplicates: 2 }),
    ];
    const fold = foldRows(rows);
    expect(fold.proposals).toBe(9);
    const a = fold.parents.get('RQ-A')!;
    expect(a.rows).toBe(6);
    expect(a.dupOnly).toBe(4);   // 3 dupOnly + the agent-gamma all-dup row
    expect(a.dupRows).toBe(5);   // dupOnly 4 + the partial row
    expect(a.proposedTotal).toBe(4 * 3 + 4 + 4 + 2); // 3×4 dupOnly + partial 4 + clean 4 + gamma 2
    expect(a.appliedTotal).toBe(2 + 4);               // partial applied 2 + clean applied 4
    expect(a.duplicatesTotal).toBe(4 * 3 + 2 + 2);    // 3 dupOnly×4 + partial 2 + gamma 2 (clean contributes 0)
    expect(a.owners).toEqual(new Set(['agent-alpha', 'agent-gamma']));
    const b = fold.parents.get('RQ-B')!;
    expect(b.dupOnly).toBe(1);
    expect(b.dupRows).toBe(1);
  });
});

describe('spawnProposalCells', () => {
  it('emits a parent cell only at the all-duplicate bar', () => {
    // Below the bar: two all-duplicate rows stay quiet even with partials around.
    const below = foldRows(parentRows({ parent: 'RQ-A', dupOnly: SPAWN_MIN_DUP_ONLY_ROWS - 1, partial: 2, clean: 1 }));
    expect(spawnProposalCells(below)).toEqual([]);

    // At the bar: emits, carrying totals and the share denominator.
    const at = foldRows(parentRows({ parent: 'RQ-A', dupOnly: SPAWN_MIN_DUP_ONLY_ROWS, partial: 1, clean: 1 }));
    const cells = spawnProposalCells(at);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      kind: 'spawn-duplicates',
      parent: 'RQ-A',
      dupOnly: SPAWN_MIN_DUP_ONLY_ROWS,
      proposals: 5,
      parents: 1,
      ownerTotal: 1,
      lowerBound: false,
    });
    expect(cells[0]!.days.length).toBe(1);
    expect(cells[0]!.firstSeen).not.toBeNull();
  });

  it('emits the fleet cell when enough parents repeat the pattern without any single parent at the bar', () => {
    // Four all-duplicate rows spread across two parents (2+2): no parent
    // reaches SPAWN_MIN_DUP_ONLY_ROWS, but the fleet pattern is systemic.
    const rows = [
      ...parentRows({ parent: 'RQ-A', dupOnly: 2 }),
      ...parentRows({ parent: 'RQ-B', dupOnly: 2, owner: 'agent-beta' }),
    ];
    const fold = foldRows(rows);
    const cells = spawnProposalCells(fold);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      kind: 'spawn-duplicates-fleet',
      parent: null,
      dupOnly: SPAWN_MIN_FLEET_DUP_ROWS,
      parents: SPAWN_MIN_FLEET_PARENTS,
      proposals: 4,
    });
  });

  it('does not emit the fleet cell for a single parent however bad it is', () => {
    // One parent with five all-duplicate rows: the parent cell fires,
    // the fleet cell needs SPAWN_MIN_FLEET_PARENTS distinct parents.
    const fold = foldRows(parentRows({ parent: 'RQ-A', dupOnly: 5 }));
    const cells = spawnProposalCells(fold);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.kind).toBe('spawn-duplicates');
  });

  it('orders the fleet cell first, then parents by dupOnly descending', () => {
    const rows = [
      ...parentRows({ parent: 'RQ-B', dupOnly: 2 }),
      ...parentRows({ parent: 'RQ-C', dupOnly: 2, owner: 'agent-gamma' }),
      ...parentRows({ parent: 'RQ-A', dupOnly: 3 }),
      ...parentRows({ parent: 'RQ-D', dupOnly: 1 }),
    ];
    const cells = spawnProposalCells(foldRows(rows));
    // Fleet dupOnly = 2+2+3+1 = 8 across 4 parents; only RQ-A (3) clears the parent bar.
    expect(cells.map((c) => c.kind)).toEqual(['spawn-duplicates-fleet', 'spawn-duplicates']);
    expect(cells[0]!.dupOnly).toBe(8);
    expect(cells[0]!.parents).toBe(4);
    expect(cells[1]!.parent).toBe('RQ-A');
  });

  it('marks truncation as a lower bound on every cell', () => {
    const fold = foldRows(parentRows({ parent: 'RQ-A', dupOnly: 3 }));
    const cells = spawnProposalCells(fold, true);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lowerBound).toBe(true);
    expect(spawnProposalCells(fold, false)[0]!.lowerBound).toBe(false);
  });
});

describe('spawnProposalsBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'spawn-proposals-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under the temp home carrying the given rows. */
  async function journal(name: string, rows: string[]): Promise<string> {
    const dir = join(home, 'runs', 'queue');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }

  it('emits one item per recurring cell with grounded prompts', async () => {
    const rows = [
      ...parentRows({ parent: 'RQ-PARENT-1', dupOnly: SPAWN_MIN_DUP_ONLY_ROWS, partial: 1 }),
      ...parentRows({ parent: 'RQ-PARENT-2', dupOnly: 1, owner: 'agent-beta' }),
      ...parentRows({ parent: 'RQ-PARENT-3', dupOnly: 1, owner: 'agent-gamma' }),
    ];
    const path = await journal('spawn-proposals', rows);
    const items = await spawnProposalsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    // Fleet cell (5 dupOnly across 3 parents) + parent cell (RQ-PARENT-1 at 3).
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.area)).toEqual(['spawn-duplicates-fleet', 'spawn-duplicates']);
    for (const item of items) {
      expect(item.id).toMatch(/^spawn-dup-[0-9a-f]{16}$/);
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('spawn-proposals.jsonl');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
      expect(item.prompt).toContain('24-hour');
    }
    const [fleet, parent] = items;
    expect(fleet!.title).toContain('fleet-wide');
    expect(fleet!.prompt).toContain('3 distinct parent(s)');
    expect(parent!.title).toContain('RQ-PARENT-1');
    expect(parent!.prompt).toContain('agent-alpha');
    expect(parent!.prompt).toContain('four proposals per 24-hour window');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await spawnProposalsBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'spawn-proposals.jsonl'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'runs', 'queue', 'spawn-proposals.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await spawnProposalsBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Another repository never inherits this install's spawn journal.
    const thin = parentRows({ parent: 'RQ-A', dupOnly: 3 });
    const thinPath = await journal('proposals-thin', thin);
    expect(await spawnProposalsBacklogItems({ repo: 'ashlrai/lexicon', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await spawnProposalsBacklogItems({ repo: '', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await spawnProposalsBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPath, now: NOW })).not.toEqual([]);

    // Rows below the recurring bars emit nothing: two all-duplicate rows
    // on RQ-S and one on RQ-T — 3 fleet dupOnly < 4, no parent at 3.
    const sparse = [
      proposalRow({ atMs: NOW_MS - HOUR, parent: 'RQ-S', proposed: 4, applied: 0, duplicates: 4 }),
      proposalRow({ atMs: NOW_MS - 2 * HOUR, parent: 'RQ-S', proposed: 4, applied: 0, duplicates: 4 }),
      proposalRow({ atMs: NOW_MS - 3 * HOUR, parent: 'RQ-T', proposed: 4, applied: 0, duplicates: 4 }),
      'not json at all',
    ];
    const sparsePath = await journal('proposals-sparse', sparse);
    expect(await spawnProposalsBacklogItems({ repo: 'ashlrai/phantom', journalPath: sparsePath, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = parentRows({ parent: 'RQ-A', dupOnly: 3 });
    // Pad past the 1 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(1100 * 1024);
    const path = await journal('proposals-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await spawnProposalsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...parentRows({ parent: 'RQ-A', dupOnly: 3 }),
      ...parentRows({ parent: 'RQ-B', dupOnly: 3, owner: 'agent-beta' }),
      ...parentRows({ parent: 'RQ-C', dupOnly: 1, owner: 'agent-gamma' }),
    ];
    const path = await journal('proposals-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await spawnProposalsBacklogItems(opts);
    const second = await spawnProposalsBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(3); // fleet + RQ-A + RQ-B
    const limited = await spawnProposalsBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends spawn-proposal items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The journal's writer path is <runs>/queue — ASHLR_RUNS_DIR wins
    // when absolute, else ~/.ashlr-runs under the relocated HOME.
    const realNow = Date.now();
    const at = (h: number): number => realNow - h * HOUR;
    const queueDir = join(home, '.ashlr-runs', 'queue');
    await mkdir(queueDir, { recursive: true });
    const liveRows = [
      // RQ-A: three all-duplicate proposals — at the parent bar.
      proposalRow({ atMs: at(1), parent: 'RQ-A', proposed: 4, applied: 0, duplicates: 4 }),
      proposalRow({ atMs: at(3), parent: 'RQ-A', proposed: 4, applied: 0, duplicates: 4 }),
      proposalRow({ atMs: at(5), parent: 'RQ-A', proposed: 4, applied: 0, duplicates: 4 }),
      // RQ-B and RQ-C: one all-duplicate each — fleet spread, no parent bar.
      proposalRow({ atMs: at(2), parent: 'RQ-B', owner: 'agent-beta', proposed: 2, applied: 0, duplicates: 2 }),
      proposalRow({ atMs: at(4), parent: 'RQ-C', owner: 'agent-gamma', proposed: 3, applied: 0, duplicates: 3 }),
      // A clean proposal that counts toward totals but never the bars.
      proposalRow({ atMs: at(6), parent: 'RQ-D', proposed: 4, applied: 4, duplicates: 0 }),
    ];
    await writeFile(join(queueDir, 'spawn-proposals.jsonl'), liveRows.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const journalItems = first.items.filter((i) => i.id.startsWith('spawn-dup-'));
    expect(journalItems).toHaveLength(2);
    expect(journalItems.map((i) => i.area)).toEqual(['spawn-duplicates-fleet', 'spawn-duplicates']);
    expect(journalItems[0]!.title).toContain('fleet-wide');
    expect(journalItems[1]!.title).toContain('RQ-A');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(journalItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('spawn-dup-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('spawn-dup-'))).toHaveLength(2);
  });
});
