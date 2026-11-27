import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dispatchProductionBacklogItems,
  foldDispatchProductionCells,
} from '../src/core/improve/dispatch-production-backlog.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let repoPath: string;
let otherRepoPath: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-dispatch-production-'));
  process.env.HOME = home;
  // The ledger's repo field is the canonical absolute checkout path —
  // realpath the scratch home so fixture paths survive
  // canonicalDispatchRepoIdentity exactly as the writer records them.
  const realHome = await realpath(home);
  repoPath = join(realHome, 'phantom');
  otherRepoPath = join(realHome, 'other-project');
  await mkdir(repoPath, { recursive: true });
  await mkdir(otherRepoPath, { recursive: true });
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';
const HASH = 'a'.repeat(64);

/** Apply record overrides; `drop` names keys to delete (for off-contract negatives). */
const applyOverrides = (row: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> => {
  const { drop, ...rest } = over;
  const merged = { ...row, ...rest };
  for (const key of (drop as readonly string[] | undefined) ?? []) delete merged[key];
  return merged;
};

/**
 * A schemaVersion-1 ledger row — the writer's common shape (no
 * runEventSummary, so no token-evidence envelope is required). Title,
 * assignedBy and routeReason are plain text; the reader's sanitizer
 * digests them exactly as it does writer output.
 */
const eventRow = (day: string, hour: number, item: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify(applyOverrides({
    schemaVersion: 1,
    ts: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    itemId: item,
    source: 'self',
    repo: repoPath,
    title: `dispatch work ${item}`,
    backend: 'codex',
    tier: 'frontier',
    assignedBy: 'd1_router',
    routeReason: 'cheapest-capable',
    outcome: 'engine-failed',
    proposalCreated: false,
    spentUsd: 0.5,
    basis: 'run-proposal-outcome',
  }, over));

/**
 * A repair-handoff-eligible empty-diff row: run-proposal-outcome
 * basis, no proposal, a safe item id with no repair markers, a
 * sha256 objective hash and a coherent run/trajectory identity —
 * exactly what repairHandoffFromDispatchEvent accepts while live
 * repair machinery is enabled.
 */
const eligibleEmptyDiff = (day: string, hour: number, item: string, over: Record<string, unknown> = {}): string =>
  eventRow(day, hour, item, {
    outcome: 'empty-diff',
    objectiveHash: HASH,
    // Safe execution identities only — colons are path-unsafe and would
    // fail the eligibility fold's own identity checks.
    runId: 'job-1',
    trajectoryId: 'run:job-1',
    ...over,
  });

/** Write one dated ledger partition under <HOME>/.ashlr/dispatch-production/. */
const ledgerFile = async (date: string, lines: readonly string[]): Promise<void> => {
  const dir = join(home, '.ashlr', 'dispatch-production');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${date}.jsonl`), lines.length === 0 ? '' : lines.join('\n') + '\n');
};

/** Three distinct items across three UTC days — past both recurring bars for one cell. */
const recurringEngineFailed = (backend: string | null = 'codex', prefix = 'job'): string[] => [
  eventRow(D1, 8, `phantom:self:${prefix}-a`, { backend }),
  eventRow(D2, 9, `phantom:self:${prefix}-b`, { backend }),
  eventRow(D3, 10, `phantom:self:${prefix}-c`, { backend }),
];

const ev = (over: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent => ({
  schemaVersion: 1,
  ts: '2026-11-28T08:00:00.000Z',
  itemId: 'phantom:self:job-a',
  source: 'self',
  repo: '/checkout/phantom',
  title: 't',
  backend: 'codex',
  tier: 'frontier',
  assignedBy: 'a',
  routeReason: 'r',
  outcome: 'engine-failed',
  proposalCreated: false,
  spentUsd: 0.5,
  basis: 'run-proposal-outcome',
  ...over,
});

describe('foldDispatchProductionCells', () => {
  const foldOpts = { nowMs: NOW_MS, windowMs: 7 * DAY_MS, repoName: 'phantom' };

  it('groups adverse events per (repo, outcome, backend) and labels unreported backends', () => {
    const cells = foldDispatchProductionCells([
      ev({ itemId: 'i1', backend: 'codex' }),
      ev({ itemId: 'i2', backend: 'codex' }),
      ev({ itemId: 'i3', backend: null }),
      ev({ itemId: 'i4', outcome: 'sandbox-failed', backend: 'codex' }),
      ev({ itemId: 'i5', outcome: 'proposal-created', proposalCreated: true, backend: 'codex' }),
      ev({ itemId: 'i6', outcome: 'cancelled', backend: 'codex' }),
      ev({ itemId: 'i7', outcome: 'shadow-observation', backend: 'codex' }),
      ev({ itemId: 'i8', repo: '/checkout/other-project', backend: 'codex' }),
      ev({ itemId: 'i9', ts: '2026-11-01T08:00:00.000Z', backend: 'codex' }), // outside window
      ev({ itemId: 'i10', ts: '2026-12-05T08:00:00.000Z', backend: 'codex' }), // beyond skew
    ], foldOpts);
    expect(cells).toHaveLength(3);
    const byKey = new Map(cells.map((c) => [`${c.outcome}|${c.backend}`, c]));
    expect(byKey.get('engine-failed|codex')!.units).toBe(2);
    expect(byKey.get('engine-failed|unreported')!.units).toBe(1);
    expect(byKey.get('sandbox-failed|codex')!.units).toBe(1);
    for (const cell of cells) {
      expect(cell.repoName).toBe('phantom');
      expect(cell.lowerBound).toBe(false);
    }
  });

  it('skips events the handoffCovered predicate marks as repair-owned', () => {
    const cells = foldDispatchProductionCells([
      ev({ itemId: 'i1' }),
      ev({ itemId: 'i2' }),
      ev({ itemId: 'i3' }),
    ], { ...foldOpts, handoffCovered: (e) => e.itemId === 'i1' });
    expect(cells).toHaveLength(1);
    expect(cells[0]!.units).toBe(2);
    expect(cells[0]!.rows).toBe(2);
  });

  it('propagates the lowerBound flag onto every cell', () => {
    const cells = foldDispatchProductionCells([ev({ itemId: 'i1' })], foldOpts, true);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lowerBound).toBe(true);
  });
});

describe('dispatchProductionBacklogItems', () => {
  const opts = { repo: 'ashlrai/phantom', now: new Date(NOW_MS) };

  it('emits nothing when the ledger is missing', async () => {
    expect(await dispatchProductionBacklogItems(opts)).toEqual([]);
  });

  it('emits one item for a recurring adverse outcome cell', async () => {
    await ledgerFile(D1, [eventRow(D1, 8, 'phantom:self:job-a'), eventRow(D1, 9, 'phantom:self:job-b')]);
    await ledgerFile(D2, [eventRow(D2, 8, 'phantom:self:job-c')]);
    const items = await dispatchProductionBacklogItems(opts);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^fleet-dispatch-production-[a-f0-9]{16}$/);
    expect(item.title).toContain('engine-failing');
    expect(item.area).toBe('dispatch-production');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe('ashlrai/phantom');
    expect(item.prompt).toContain("'engine-failed'");
    expect(item.prompt).toContain('3 distinct work items');
    expect(item.prompt).toContain('codex');
    expect(item.prompt).toContain('dispatch-production');
    // Honesty: aggregate counts only — never the checkout path or item ids.
    expect(item.prompt).not.toContain(repoPath);
    expect(item.prompt).not.toContain('job-a');
    expect(validBacklogItem(item)).not.toBeNull();
  });

  it('stays silent below the recurrence bars', async () => {
    // Two distinct items on one day: not enough units, not enough days.
    await ledgerFile(D1, [eventRow(D1, 8, 'phantom:self:job-a'), eventRow(D1, 9, 'phantom:self:job-b')]);
    expect(await dispatchProductionBacklogItems(opts)).toEqual([]);
    // Three distinct items but all on one UTC day: days bar unmet.
    await rm(join(home, '.ashlr', 'dispatch-production', `${D1}.jsonl`), { force: true });
    await ledgerFile(D1, [
      eventRow(D1, 8, 'phantom:self:job-a'),
      eventRow(D1, 9, 'phantom:self:job-b'),
      eventRow(D1, 10, 'phantom:self:job-c'),
    ]);
    expect(await dispatchProductionBacklogItems(opts)).toEqual([]);
  });

  it('ignores events for other repository checkouts', async () => {
    await ledgerFile(D1, [
      eventRow(D1, 8, 'phantom:self:job-a', { repo: otherRepoPath }),
      eventRow(D1, 9, 'phantom:self:job-b', { repo: otherRepoPath }),
      eventRow(D1, 10, 'phantom:self:job-c', { repo: otherRepoPath }),
    ]);
    expect(await dispatchProductionBacklogItems(opts)).toEqual([]);
  });

  it('emits separate cells per backend and per outcome', async () => {
    const cx = recurringEngineFailed('codex', 'cx');
    const cl = recurringEngineFailed('claude', 'cl').map((l) =>
      JSON.stringify({ ...JSON.parse(l), outcome: 'sandbox-failed' }));
    const ok = [
      eventRow(D1, 12, 'phantom:self:ok-1', { outcome: 'proposal-created', proposalCreated: true, backend: 'codex' }),
      eventRow(D1, 13, 'phantom:self:cx-stop', { outcome: 'cancelled', backend: 'codex' }),
    ];
    // Each dated partition carries that day's rows for both cells.
    await ledgerFile(D1, [...cx.slice(0, 1), ...cl.slice(0, 1), ...ok]);
    await ledgerFile(D2, [cx[1]!, cl[1]!]);
    await ledgerFile(D3, [cx[2]!, cl[2]!]);
    const items = await dispatchProductionBacklogItems(opts);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.title).join(' ')).toContain('engine-failing');
    expect(items.map((i) => i.title).join(' ')).toContain('sandbox-failing');
    expect(items.every((i) => i.id.startsWith('fleet-dispatch-production-'))).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  it('excludes repair-handoff-eligible empty-diff events while live repair is enabled', async () => {
    // Default config: foundry.proposalRepair stays enabled and the fleet
    // is not in shared-queue mode, so the daemon's own gate records
    // handoffs for exactly these rows — the sibling feed owns them.
    await ledgerFile(D1, [eligibleEmptyDiff(D1, 8, 'phantom:self:parent-a')]);
    await ledgerFile(D2, [eligibleEmptyDiff(D2, 9, 'phantom:self:parent-b')]);
    await ledgerFile(D3, [eligibleEmptyDiff(D3, 10, 'phantom:self:parent-c')]);
    expect(await dispatchProductionBacklogItems(opts)).toEqual([]);
  });

  it('counts the same empty-diff shape when its basis is not run-proposal-outcome', async () => {
    // pending-proposal-delta rows never reach repairHandoffFromDispatchEvent's
    // eligibility fold, so the repair journals cannot own them — this feed does.
    const basis = { basis: 'pending-proposal-delta' };
    await ledgerFile(D1, [eligibleEmptyDiff(D1, 8, 'phantom:self:parent-a', basis)]);
    await ledgerFile(D2, [eligibleEmptyDiff(D2, 9, 'phantom:self:parent-b', basis)]);
    await ledgerFile(D3, [eligibleEmptyDiff(D3, 10, 'phantom:self:parent-c', basis)]);
    const items = await dispatchProductionBacklogItems(opts);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('empty diffs');
    expect(items[0]!.prompt).toContain('pending-proposal-delta');
    expect(items[0]!.prompt).toContain("'empty-diff'");
  });

  it('counts repair-eligible events when foundry.proposalRepair is disabled', async () => {
    const configDir = join(home, '.ashlr');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ foundry: { proposalRepair: false } }));
    await ledgerFile(D1, [eligibleEmptyDiff(D1, 8, 'phantom:self:parent-a')]);
    await ledgerFile(D2, [eligibleEmptyDiff(D2, 9, 'phantom:self:parent-b')]);
    await ledgerFile(D3, [eligibleEmptyDiff(D3, 10, 'phantom:self:parent-c')]);
    const items = await dispatchProductionBacklogItems(opts);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('empty diffs');
  });

  it('drops malformed rows, states the loss, and still folds the retained evidence', async () => {
    await ledgerFile(D1, [
      '{"schemaVersion":1,"ts":"not-a-date"}',
      'not json at all',
      eventRow(D1, 8, 'phantom:self:job-a'),
      eventRow(D1, 9, 'phantom:self:job-b'),
    ]);
    await ledgerFile(D2, [eventRow(D2, 8, 'phantom:self:job-c')]);
    const items = await dispatchProductionBacklogItems(opts);
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('malformed or off-contract rows dropped');
  });

  it('derives stable ids across calls and honors the item limit', async () => {
    const cx = recurringEngineFailed('codex', 'cx');
    const cl = recurringEngineFailed('claude', 'cl');
    const km = recurringEngineFailed('kimi', 'km').map((l) =>
      JSON.stringify({ ...JSON.parse(l), outcome: 'unknown' }));
    await ledgerFile(D1, [cx[0]!, cl[0]!, km[0]!]);
    await ledgerFile(D2, [cx[1]!, cl[1]!, km[1]!]);
    await ledgerFile(D3, [cx[2]!, cl[2]!, km[2]!]);
    const first = await dispatchProductionBacklogItems(opts);
    const second = await dispatchProductionBacklogItems(opts);
    expect(first).toHaveLength(3);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await dispatchProductionBacklogItems({ ...opts, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.length).toBeLessThanOrEqual(25);
  });

  it('appends dispatch-production items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — inside the 7-day window.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const iso = (days: number, hour: number): string => `${dayAgo(days)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
    const dir = join(home, '.ashlr', 'dispatch-production');
    await mkdir(dir, { recursive: true });
    const lines = [1, 2, 3].map((d) => eventRowRaw(iso(d, 8), `phantom:self:job-${d}`, repoPath));
    // One dated partition per UTC day keeps fileMayContainSince honest.
    for (const [index, d] of [1, 2, 3].entries()) {
      await writeFile(join(dir, `${dayAgo(d)}.jsonl`), lines[index]! + '\n');
    }
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const items = first.items.filter((i) => i.id.startsWith('fleet-dispatch-production-'));
    expect(items).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(items)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-dispatch-production-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-dispatch-production-'))).toHaveLength(1);
  });
});

/** Raw row builder for the wall-clock discover test (explicit ts, no day/hour split). */
function eventRowRaw(ts: string, item: string, repo: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    ts,
    itemId: item,
    source: 'self',
    repo,
    title: `dispatch work ${item}`,
    backend: 'codex',
    tier: 'frontier',
    assignedBy: 'd1_router',
    routeReason: 'cheapest-capable',
    outcome: 'engine-failed',
    proposalCreated: false,
    spentUsd: 0.5,
    basis: 'run-proposal-outcome',
  });
}
