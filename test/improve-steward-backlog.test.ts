import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STEWARD_MIN_RUNS,
  foldStewardEvidence,
  parseStewardJournal,
  parseStewardReportDoc,
  stewardBacklogItems,
  type StewardRootReport,
  type StewardRunReport,
} from '../src/core/improve/steward-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIB = 1024 * 1024;

/** One root row inside a journaled StewardReport, writer-shaped. */
const rootRow = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  path: `/home/test/${id}`,
  exists: true,
  files: 120,
  bytes: 30 * MIB,
  quotaBytes: 20 * MIB,
  overQuota: true,
  reclaimable: { files: 4, bytes: 3 * MIB },
  action: 'delete',
  ...over,
});

/** The document `phm steward disk --json` prints: JSON.stringify(report, null, 2). */
const stewardDoc = (roots: Record<string, unknown>[], over: Record<string, unknown> = {}): string => JSON.stringify({
  applied: false,
  roots,
  totalBytes: roots.reduce((a, r) => a + (r['bytes'] as number), 0),
  reclaimableBytes: roots.reduce((a, r) => a + ((r['reclaimable'] as { bytes: number }).bytes), 0),
  deleted: { files: 0, bytes: 0 },
  archived: { files: 0, bytes: 0 },
  ...over,
}, null, 2);

/** `n` consecutive over-quota documents for one root, oldest first. */
const overQuotaDocs = (id: string, count: number, rootOver: Record<string, unknown> = {}, reportOver: Record<string, unknown> = {}): string[] =>
  Array.from({ length: count }, () => stewardDoc([rootRow(id, rootOver)], reportOver));

/** A validated run for the pure fold, same defaults as stewardDoc's row. */
const runReport = (over: Partial<StewardRunReport> = {}): StewardRunReport => ({
  applied: false,
  roots: [{
    id: 'codex-log',
    action: 'delete',
    exists: true,
    files: 120,
    bytes: 30 * MIB,
    quotaBytes: 20 * MIB,
    overQuota: true,
    reclaimableFiles: 4,
    reclaimableBytes: 3 * MIB,
  }],
  totalBytes: 30 * MIB,
  reclaimableBytes: 3 * MIB,
  deletedFiles: 0,
  deletedBytes: 0,
  archivedFiles: 0,
  archivedBytes: 0,
  ...over,
});

const rootOf = (id: string, over: Partial<StewardRootReport> = {}): StewardRootReport => ({
  id,
  action: 'delete',
  exists: true,
  files: 120,
  bytes: 30 * MIB,
  quotaBytes: 20 * MIB,
  overQuota: true,
  reclaimableFiles: 4,
  reclaimableBytes: 3 * MIB,
  ...over,
});

describe('parseStewardReportDoc', () => {
  it('accepts an on-contract report and rejects off-contract shapes', () => {
    const doc = JSON.parse(stewardDoc([rootRow('codex-log')])) as Record<string, unknown>;
    const run = parseStewardReportDoc(doc);
    expect(run).not.toBeNull();
    expect(run!.applied).toBe(false);
    expect(run!.roots).toHaveLength(1);
    expect(run!.roots[0]).toMatchObject({ id: 'codex-log', action: 'delete', overQuota: true, bytes: 30 * MIB });

    const cases: unknown[] = [
      null,
      [],
      'text',
      { ...doc, applied: 'yes' },
      { ...doc, roots: 'none' },
      { ...doc, roots: [{}] },
      { ...doc, roots: [{ ...rootRow('x'), action: 'shred' }] },
      { ...doc, roots: [{ ...rootRow('x'), overQuota: 1 }] },
      { ...doc, roots: [{ ...rootRow('x'), files: -1 }] },
      { ...doc, roots: [{ ...rootRow('x'), files: 1.5 }] },
      { ...doc, roots: [{ ...rootRow('x'), bytes: '30' }] },
      { ...doc, roots: [{ ...rootRow('x'), quotaBytes: -1 }] },
      { ...doc, roots: [{ ...rootRow('x'), reclaimable: { files: 1 } }] },
      { ...doc, roots: [{ ...rootRow('x'), reclaimable: { files: 1, bytes: -2 } }] },
      { ...doc, roots: [{ ...rootRow('x'), nativeHint: 42 }] },
      { ...doc, totalBytes: -1 },
      { ...doc, reclaimableBytes: 'x' },
      { ...doc, deleted: { files: 0 } },
      { ...doc, archived: { files: -1, bytes: 0 } },
    ];
    for (const value of cases) expect(parseStewardReportDoc(value)).toBeNull();
    // A report-only install's zeros and an --apply run's churn both parse.
    expect(parseStewardReportDoc(JSON.parse(stewardDoc([rootRow('a')], {
      applied: true,
      deleted: { files: 7, bytes: 5 * MIB },
      archived: { files: 2, bytes: 9 * MIB },
    })))).not.toBeNull();
    // Empty roots is a valid report — a policy measuring nothing.
    expect(parseStewardReportDoc(JSON.parse(stewardDoc([], { totalBytes: 0, reclaimableBytes: 0 })))).not.toBeNull();
  });
});

describe('parseStewardJournal', () => {
  it('frames documents on column-0 braces and counts everything else as coverage', () => {
    const docs = overQuotaDocs('codex-log', 2);
    const invalid = JSON.stringify({ applied: 'yes', roots: [] }, null, 2);
    const text = [
      'stderr noise before the first report',
      docs[0],
      'a stderr warning between reports',
      invalid,
      docs[1],
      '',
    ].join('\n');
    const { runs, coverage } = parseStewardJournal(text);
    expect(runs).toHaveLength(2);
    expect(coverage.strayLines).toBe(2);
    expect(coverage.invalidDocs).toBe(1);
    expect(coverage.abandonedDocs).toBe(0);
    expect(coverage.openTail).toBe(false);
  });

  it('counts a column-0 brace inside a document as an abandoned mid-write', () => {
    const good = overQuotaDocs('codex-log', 1)[0]!;
    const torn = '{\n  "applied": false,\n  "roots": [\n    {\n      "id": "claude-projects",';
    const text = `${torn}\n${good}\n`;
    const { runs, coverage } = parseStewardJournal(text);
    // The torn fragment was abandoned when the next doc's `{` opened;
    // the good document still parses.
    expect(runs).toHaveLength(1);
    expect(coverage.abandonedDocs).toBe(1);
    expect(coverage.openTail).toBe(false);
  });

  it('flags an unterminated tail document as openTail, never a run', () => {
    const good = overQuotaDocs('codex-log', 1)[0]!;
    const torn = '{\n  "applied": false,\n  "roots": [';
    const text = `${good}\n${torn}`;
    const { runs, coverage } = parseStewardJournal(text);
    expect(runs).toHaveLength(1);
    expect(coverage.openTail).toBe(true);
  });

  it('counts closed documents failing the contract as invalidDocs', () => {
    const bad = JSON.stringify({ applied: false, roots: 'nope' }, null, 2);
    const good = overQuotaDocs('codex-log', 1)[0]!;
    const { runs, coverage } = parseStewardJournal(`${bad}\n${good}\n`);
    expect(runs).toHaveLength(1);
    expect(coverage.invalidDocs).toBe(1);
  });
});

describe('foldStewardEvidence', () => {
  it('measures the consecutive over-quota suffix ending at the newest run', () => {
    const runs = [
      runReport(),                                                        // oldest: over
      runReport({ roots: [rootOf('codex-log', { overQuota: false, bytes: 5 * MIB })] }), // recovered
      runReport(),                                                        // over again
      runReport(),                                                        // over
      runReport(),                                                        // newest: over
    ];
    const cells = foldStewardEvidence(runs);
    expect(cells).toHaveLength(1);
    // The middle recovery broke the streak: only the newest three count.
    expect(cells[0]).toMatchObject({ id: 'codex-log', runs: 3, appliedRuns: 0, reportOnlyRuns: 3 });
    expect(cells[0]!.newestBytes).toBe(30 * MIB);
    expect(cells[0]!.newestQuotaBytes).toBe(20 * MIB);
    expect(cells[0]!.newestReclaimableFiles).toBe(4);
  });

  it('ends a streak when a report stops measuring the root', () => {
    // A middle report measuring nothing breaks the streak: only the
    // newest run still counts.
    const gapped = foldStewardEvidence([
      runReport(), runReport(), runReport({ roots: [] }), runReport(),
    ]);
    expect(gapped).toHaveLength(1);
    expect(gapped[0]!.runs).toBe(1);
    // A newest report lacking the root leaves no current streak.
    const absent = foldStewardEvidence([
      runReport(), runReport(), runReport(),
      runReport({ roots: [rootOf('other-root')] }),
    ]);
    expect(absent.find((c) => c.id === 'codex-log')).toBeUndefined();
    expect(absent.find((c) => c.id === 'other-root')!.runs).toBe(1);
  });

  it('emits nothing for a root whose newest verdict is under quota', () => {
    const runs = [
      runReport(), runReport(), runReport(),
      runReport({ roots: [rootOf('codex-log', { overQuota: false, bytes: 5 * MIB })] }),
    ];
    expect(foldStewardEvidence(runs)).toEqual([]);
  });

  it('folds per-root streaks independently and sums applied-run churn', () => {
    const applied = {
      applied: true,
      deletedFiles: 10, deletedBytes: 8 * MIB,
      archivedFiles: 3, archivedBytes: 6 * MIB,
    };
    const runs = [
      runReport({ roots: [rootOf('codex-log'), rootOf('claude-projects', { action: 'archive' })] }),
      runReport({ roots: [rootOf('codex-log'), rootOf('claude-projects', { action: 'archive' })], ...applied }),
      runReport({ roots: [rootOf('codex-log'), rootOf('claude-projects', { action: 'archive', overQuota: false, bytes: 1 * MIB })] }),
      runReport({ roots: [rootOf('codex-log'), rootOf('claude-projects', { action: 'archive' })] }),
    ];
    const cells = foldStewardEvidence(runs);
    const codex = cells.find((c) => c.id === 'codex-log')!;
    const claude = cells.find((c) => c.id === 'claude-projects')!;
    // codex-log over on all four; claude-projects broke at run 3 → streak 1.
    expect(codex.runs).toBe(4);
    expect(codex.appliedRuns).toBe(1);
    expect(codex.reportOnlyRuns).toBe(3);
    expect(codex.deletedFiles).toBe(10);
    expect(codex.archivedFiles).toBe(3);
    expect(codex.action).toBe('delete');
    expect(claude.runs).toBe(1);
    expect(claude.action).toBe('archive');
    // Sorted by streak length desc, then id.
    expect(cells[0]!.id).toBe('codex-log');
  });
});

describe('stewardBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'steward-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** Write docs as the schedule's append sink would: one pretty doc per run. */
  async function journal(name: string, docs: string[]): Promise<string> {
    const dir = join(home, '.ashlr', 'logs');
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, docs.join('\n') + '\n');
    return path;
  }
  const opts = (journalPath: string, repo = 'ashlrai/phantom') => ({ repo, journalPath });

  it('emits one item per root at the consecutive-run bar', async () => {
    // Both roots over quota on the same three consecutive runs.
    const mixed = [
      stewardDoc([rootRow('codex-log'), rootRow('claude-projects', { action: 'archive', nativeHint: 'hint' })]),
      stewardDoc([rootRow('codex-log'), rootRow('claude-projects', { action: 'archive' })], { applied: true, deleted: { files: 12, bytes: 9 * MIB } }),
      stewardDoc([rootRow('codex-log'), rootRow('claude-projects', { action: 'archive' })]),
    ];
    const path = await journal('steward.jsonl', mixed);
    const items = await stewardBacklogItems(opts(path));
    expect(items).toHaveLength(2);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'disk-pressure' });
      expect(item.id).toMatch(/^steward-overquota-[A-Za-z0-9._-]+-[0-9a-f]{16}$/);
      expect(item.prompt).toContain('consecutive recorded runs');
      expect(item.prompt).toContain('steward.jsonl');
      expect(item.prompt).toContain('phm steward disk');
      expect(item.prompt).toContain('no-change');
    }
    const codex = items.find((i) => i.title.includes('codex-log'))!;
    expect(codex.prompt).toContain('3 consecutive recorded runs');
    expect(codex.prompt).toContain('applied and');
    const claude = items.find((i) => i.title.includes('claude-projects'))!;
    expect(claude.prompt).toContain('archive');
  });

  it('emits nothing below the bar or when the newest verdict recovered', async () => {
    const two = await journal('two.jsonl', overQuotaDocs('codex-log', STEWARD_MIN_RUNS - 1));
    expect(await stewardBacklogItems(opts(two))).toEqual([]);

    // Three over-quota runs then a recovery: the streak is broken.
    const recovered = await journal('recovered.jsonl', [
      ...overQuotaDocs('codex-log', STEWARD_MIN_RUNS),
      stewardDoc([rootRow('codex-log', { overQuota: false, bytes: 4 * MIB })]),
    ]);
    expect(await stewardBacklogItems(opts(recovered))).toEqual([]);

    // An older streak cannot emit once a newer under-quota run exists.
    const oldStreak = await journal('old-streak.jsonl', [
      ...overQuotaDocs('codex-log', STEWARD_MIN_RUNS + 2),
      stewardDoc([rootRow('codex-log', { overQuota: false, bytes: 4 * MIB })]),
      stewardDoc([rootRow('codex-log', { overQuota: false, bytes: 4 * MIB })]),
    ]);
    expect(await stewardBacklogItems(opts(oldStreak))).toEqual([]);
  });

  it('splits the prompt on report-only streaks and zero reclaimable', async () => {
    // Report-only install: applied:false on every run, zero churn.
    const reportOnly = await journal('report-only.jsonl', overQuotaDocs('codex-log', STEWARD_MIN_RUNS));
    const [item] = await stewardBacklogItems(opts(reportOnly));
    expect(item!.prompt).toContain('report-only — the unit measures the root but never reclaims it');

    // Nothing eligible to reclaim on the newest report.
    const stuck = await journal('stuck.jsonl', overQuotaDocs('codex-log', STEWARD_MIN_RUNS, {
      reclaimable: { files: 0, bytes: 0 },
    }));
    const [stuckItem] = await stewardBacklogItems(opts(stuck));
    expect(stuckItem!.prompt).toContain('reclaimable tally is zero');
    expect(stuckItem!.prompt).toContain('retention alone cannot bring this root under quota');
  });

  it('emits nothing on missing, unreadable-shape or foreign-repo evidence', async () => {
    expect(await stewardBacklogItems(opts(join(home, 'no-such.jsonl')))).toEqual([]);
    // A journal of only noise and torn fragments yields no runs.
    const noise = await journal('noise.jsonl', ['plain stderr line', '{"half":']);
    expect(await stewardBacklogItems(opts(noise))).toEqual([]);
    // Off-contract documents only.
    const bad = await journal('bad.jsonl', [JSON.stringify({ applied: 'x' }, null, 2)]);
    expect(await stewardBacklogItems(opts(bad))).toEqual([]);
    // Another repository never inherits this host's evidence.
    const path = await journal('steward.jsonl', overQuotaDocs('codex-log', STEWARD_MIN_RUNS));
    expect(await stewardBacklogItems(opts(path, 'ashlrai/other'))).toEqual([]);
    expect(await stewardBacklogItems(opts(path, 'AshlrAI/Phantom'))).toHaveLength(1);
    expect(await stewardBacklogItems({ repo: '', journalPath: path })).toEqual([]);
  });

  it('honors homeDir resolution and the limit', async () => {
    const path = await journal('steward.jsonl', [
      stewardDoc([rootRow('codex-log'), rootRow('claude-projects')]),
      stewardDoc([rootRow('codex-log'), rootRow('claude-projects')]),
      stewardDoc([rootRow('codex-log'), rootRow('claude-projects')]),
    ]);
    // Default resolution: <home>/.ashlr/logs/steward.jsonl via HOME.
    const viaHome = await stewardBacklogItems({ repo: 'ashlrai/phantom' });
    expect(viaHome).toHaveLength(2);
    // Explicit homeDir + journalPath name the same file.
    const viaOpts = await stewardBacklogItems({ repo: 'ashlrai/phantom', homeDir: home, journalPath: path });
    expect(viaOpts.map((i) => i.id)).toEqual(viaHome.map((i) => i.id));
    expect(await stewardBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, limit: 1 })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const path = await journal('steward.jsonl', overQuotaDocs('codex-log', STEWARD_MIN_RUNS + 1));
    const first = await stewardBacklogItems(opts(path));
    const second = await stewardBacklogItems(opts(path));
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // A longer streak keeps the same id — counts never enter it.
    const longer = await journal('steward-longer.jsonl', overQuotaDocs('codex-log', STEWARD_MIN_RUNS + 4));
    const third = await stewardBacklogItems(opts(longer));
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends steward items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const path = await journal('steward.jsonl', [
        stewardDoc([rootRow('codex-log'), rootRow('claude-projects', { action: 'archive' })]),
        stewardDoc([rootRow('codex-log'), rootRow('claude-projects', { action: 'archive' })]),
        stewardDoc([rootRow('codex-log'), rootRow('claude-projects', { action: 'archive' })]),
      ]);
      void path;
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const stewardItems = first.items.filter((i) => i.id.startsWith('steward-overquota-'));
      expect(stewardItems).toHaveLength(2);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(stewardItems)).toBe(2);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('steward-overquota-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('steward-overquota-'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
