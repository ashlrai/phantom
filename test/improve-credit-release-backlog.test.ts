import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { creditReleaseBacklogItems, CREDIT_RELEASE_RECURRING, foldCreditRelease } from '../src/core/improve/credit-release-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-credit-release-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const iso = (hoursAgo: number): string => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

interface SweepShape {
  scanned?: number;
  released?: number;
  skipped?: number;
  sourceComplete?: boolean;
  reasons?: Record<string, number>;
}

/** A persisted DaemonTick-shaped row whose producerMaintenance carries one credit-sweep result. */
const sweep = (hoursAgo: number, o: SweepShape = {}): Record<string, unknown> => ({
  ts: iso(hoursAgo),
  reason: 'ok',
  producerMaintenance: {
    selfHeal: true,
    invent: false,
    ancillary: true,
    proposalRepair: false,
    postMergeCreditScanned: o.scanned ?? 0,
    postMergeCreditReleased: o.released ?? 0,
    postMergeCreditSkipped: o.skipped ?? 0,
    postMergeCreditSourceComplete: o.sourceComplete ?? true,
    postMergeCreditSkippedByReason: o.reasons ?? {},
  },
});

/** A tick where producer maintenance ran but the credit sweep did not (cadence skip or stop). */
const noSweep = (hoursAgo: number): Record<string, unknown> => ({
  ts: iso(hoursAgo),
  reason: 'ok',
  producerMaintenance: { selfHeal: true, invent: false, ancillary: true, proposalRepair: false, skippedByCadence: true },
});

/** A tick with no producerMaintenance record at all. */
const idleTick = (hoursAgo: number): Record<string, unknown> => ({ ts: iso(hoursAgo), reason: 'ok' });

/** Write daemon.json under a scratch ASHLR root and return the rootDir option. */
const writeState = (rootName: string, state: unknown): string => {
  const root = path.join(home, rootName);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'daemon.json'), typeof state === 'string' ? state : `${JSON.stringify(state)}\n`);
  return root;
};

/** Sweep ticks where 'stability-ledger-degraded' recurs — the recurring-failure fixture. */
const degradedTicks = (count: number, hoursStart = 50): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, i) => sweep(hoursStart - i, {
    scanned: 40, skipped: 40, reasons: { 'stability-ledger-degraded': 40 },
  }));

describe('credit release fold', () => {
  it('counts sweep ticks per reason, never the in-pass row tally', () => {
    const rows = [
      sweep(9, { scanned: 50, skipped: 50, reasons: { 'stability-ledger-degraded': 50 } }),
      sweep(8, { scanned: 50, skipped: 50, reasons: { 'stability-ledger-degraded': 50 } }),
      sweep(7, { scanned: 50, skipped: 50, reasons: { 'stability-ledger-degraded': 50 } }),
    ];
    const fold = foldCreditRelease(rows, NOW);
    expect(fold.ticks).toBe(3);
    expect(fold.sweeps).toBe(3);
    expect(fold.skipped).toBe(150);
    const tally = fold.reasons.find((r) => r.reason === 'stability-ledger-degraded')!;
    expect(tally.ticks).toBe(3);
    expect(tally.rows).toBe(150);
  });

  it('records designed holds as reason tallies but they stay context', () => {
    const rows = [
      sweep(9, { scanned: 10, skipped: 10, reasons: { 'report-only-operational-release-disabled': 7, 'observation-window-not-elapsed': 3 } }),
    ];
    const fold = foldCreditRelease(rows, NOW);
    expect(fold.reasons.map((r) => r.reason).sort()).toEqual([
      'observation-window-not-elapsed', 'report-only-operational-release-disabled',
    ]);
    expect(fold.reasons.every((r) => r.ticks === 1)).toBe(true);
  });

  it('counts unattributed skips only when the source reported complete', () => {
    const rows = [
      sweep(9, { scanned: 5, skipped: 5, sourceComplete: true, reasons: {} }),
      sweep(8, { scanned: 5, skipped: 3, sourceComplete: true, reasons: { error: 3 } }),
      sweep(7, { scanned: 5, skipped: 5, sourceComplete: false, reasons: {} }),
      sweep(6, { scanned: 5, skipped: 4, sourceComplete: true, reasons: { error: 4 } }),
    ];
    const fold = foldCreditRelease(rows, NOW);
    expect(fold.unattributedSkipTicks).toBe(1);
    expect(fold.firstUnattributedSkipAt).toBe(iso(9));
    expect(fold.lastUnattributedSkipAt).toBe(iso(9));
    expect(fold.sourceIncompleteTicks).toBe(1);
  });

  it('treats ticks without a recorded sweep as context, not evidence', () => {
    const rows = [
      ...degradedTicks(3),
      noSweep(2),
      idleTick(1),
      { ts: 'not-a-date', producerMaintenance: { postMergeCreditScanned: 1 } },
      { producerMaintenance: { postMergeCreditScanned: 1 } },
      'garbage',
    ];
    const fold = foldCreditRelease(rows, NOW);
    expect(fold.ticks).toBe(5);
    expect(fold.sweeps).toBe(3);
    expect(fold.skippedTicks).toBe(3);
  });

  it('drops ticks outside the window', () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => sweep(24 * 9 - i, { scanned: 5, skipped: 5, reasons: { error: 5 } })),
      sweep(10, { scanned: 5, skipped: 5, reasons: { error: 5 } }),
    ];
    const fold = foldCreditRelease(rows, NOW);
    expect(fold.ticks).toBe(1);
    expect(fold.reasons[0]).toMatchObject({ reason: 'error', ticks: 1 });
  });
});

describe('creditReleaseBacklogItems', () => {
  it('turns a recurring adverse reason into a valid priority-3 backlog item', async () => {
    const rootDir = writeState('.ashlr-a', { running: false, ticks: degradedTicks(CREDIT_RELEASE_RECURRING + 1) });
    const items = await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^credit-release-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'credit-release' });
    expect(item.title).toContain('stability-ledger-degraded');
    expect(item.prompt).toContain('4 of 4 in-window sweep pass(es)');
    expect(item.prompt).toContain('160 recorded skip row(s)');
    expect(item.prompt).toContain('daemon.json');
    expect(item.prompt).toContain('postMergeCreditSkippedByReason');
    expect(item.prompt).toContain('phm daemon status');
    expect(item.prompt).toContain('readPostMergeStability');
    expect(item.prompt).toContain('report-only-operational-release-disabled');
    expect(item.prompt).toContain('no-change');
  });

  it('emits items for every machinery signal and for unclassified reasons', async () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => sweep(60 - i, { scanned: 9, skipped: 9, reasons: { error: 9 } })),
      ...Array.from({ length: 3 }, (_, i) => sweep(50 - i, { scanned: 7, skipped: 7, reasons: { 'invalid-merge-timestamp': 7 } })),
      ...Array.from({ length: 3 }, (_, i) => sweep(40 - i, { scanned: 4, skipped: 4, reasons: { 'future-reason-v9': 4 } })),
      ...Array.from({ length: 3 }, (_, i) => sweep(30 - i, { scanned: 6, skipped: 6, sourceComplete: false, reasons: {} })),
      ...Array.from({ length: 3 }, (_, i) => sweep(20 - i, { scanned: 5, skipped: 5, sourceComplete: true, reasons: {} })),
    ];
    const rootDir = writeState('.ashlr-b', { ticks: rows });
    const items = await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW });
    expect(items).toHaveLength(5);
    const titles = items.map((i) => i.title);
    expect(titles.some((t) => t.includes("'error'"))).toBe(true);
    expect(titles.some((t) => t.includes('invalid-merge-timestamp'))).toBe(true);
    expect(titles.some((t) => t.includes('unclassified') && t.includes('future-reason-v9'))).toBe(true);
    expect(titles.some((t) => t.includes('incomplete sources'))).toBe(true);
    expect(titles.some((t) => t.includes('unattributed skips'))).toBe(true);
    const unclassified = items.find((i) => i.title.includes('future-reason-v9'))!;
    expect(unclassified.prompt).toContain('does not classify');
    const incomplete = items.find((i) => i.title.includes('incomplete sources'))!;
    expect(incomplete.prompt).toContain('sourceComplete:false');
    expect(incomplete.prompt).toContain('listProposalsDetailed');
    const unattributed = items.find((i) => i.title.includes('unattributed skips'))!;
    expect(unattributed.prompt).toContain('per-proposal catch');
    for (const item of items) expect(validBacklogItem(item)).not.toBeNull();
  });

  it('never emits for designed holds, however often they recur', async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => sweep(50 - i, {
        scanned: 12, skipped: 12,
        reasons: {
          'report-only-operational-release-disabled': 6,
          'observation-window-not-elapsed': 4,
          'no-positive-stability-witness': 2,
        },
      })),
      ...Array.from({ length: 4 }, (_, i) => sweep(20 - i, {
        scanned: 3, skipped: 3, reasons: { 'adverse-outcome-observed': 3 },
      })),
    ];
    const rootDir = writeState('.ashlr-c', { ticks: rows });
    expect(await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW })).toEqual([]);
  });

  it('emits nothing below the recurring bar or when only healthy passes record', async () => {
    const below = writeState('.ashlr-d', {
      ticks: [
        ...Array.from({ length: CREDIT_RELEASE_RECURRING - 1 }, (_, i) => sweep(50 - i, { scanned: 8, skipped: 8, reasons: { error: 8 } })),
        sweep(10, { scanned: 8, skipped: 0, reasons: {} }),
      ],
    });
    expect(await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir: below, now: NOW })).toEqual([]);
    const clean = writeState('.ashlr-e', {
      ticks: Array.from({ length: 10 }, (_, i) => sweep(50 - i, {
        scanned: 8, released: 2, skipped: 6,
        reasons: { 'observation-window-not-elapsed': 4, 'report-only-operational-release-disabled': 2 },
      })),
    });
    expect(await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir: clean, now: NOW })).toEqual([]);
  });

  it('emits nothing for stale history, a missing file, malformed JSON or a non-array ticks', async () => {
    const stale = writeState('.ashlr-f', { ticks: degradedTicks(6, 24 * 9) });
    expect(await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir: stale, now: NOW })).toEqual([]);
    expect(await creditReleaseBacklogItems({
      repo: 'ashlrai/phantom', rootDir: path.join(home, 'no-such-root'), now: NOW,
    })).toEqual([]);
    const malformed = writeState('.ashlr-g', '{not json');
    expect(await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir: malformed, now: NOW })).toEqual([]);
    const noTicks = writeState('.ashlr-h', { running: true, ticks: 'corrupt' });
    expect(await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir: noTicks, now: NOW })).toEqual([]);
  });

  it('emits nothing for another repository — the credit funnel is this install\'s machinery', async () => {
    const rootDir = writeState('.ashlr-i', { ticks: degradedTicks(CREDIT_RELEASE_RECURRING + 1) });
    expect(await creditReleaseBacklogItems({ repo: 'ashlrai/other', rootDir, now: NOW })).toEqual([]);
    expect(await creditReleaseBacklogItems({ repo: 'phantom', rootDir, now: NOW })).not.toEqual([]);
  });

  it('scrubs secret-shaped reason keys before they reach a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const rows = Array.from({ length: 3 }, (_, i) => sweep(50 - i, { scanned: 4, skipped: 4, reasons: { [token]: 4 } }));
    const rootDir = writeState('.ashlr-j', { ticks: rows });
    const items = await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => sweep(60 - i, { scanned: 9, skipped: 9, reasons: { error: 9 } })),
      ...Array.from({ length: 4 }, (_, i) => sweep(55 - i, { scanned: 7, skipped: 7, reasons: { 'observation-ledger-degraded': 7 } })),
      ...Array.from({ length: 3 }, (_, i) => sweep(50 - i, { scanned: 6, skipped: 6, reasons: { 'invalid-merge-timestamp': 6 } })),
    ];
    const rootDir = writeState('.ashlr-k', { ticks: rows });
    const first = await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW });
    const second = await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW });
    expect(first).toHaveLength(3);
    expect(first[0]!.title).toContain('error');
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const one = await creditReleaseBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(first[0]!.id);
  });

  it('appends credit-release items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the fold at the real clock, so fixture ticks
    // stamp relative to it — the 7-day window is the fold's own.
    const recent = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const rows = Array.from({ length: CREDIT_RELEASE_RECURRING + 1 }, (_, i) => ({
      ts: recent(50 - i),
      reason: 'ok',
      producerMaintenance: {
        selfHeal: true, ancillary: true,
        postMergeCreditScanned: 12,
        postMergeCreditReleased: 0,
        postMergeCreditSkipped: 12,
        postMergeCreditSourceComplete: true,
        postMergeCreditSkippedByReason: { 'stability-ledger-degraded': 12 },
      },
    }));
    const root = path.join(home, '.ashlr');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'daemon.json'), `${JSON.stringify({ running: true, ticks: rows })}\n`);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const credit = first.items.filter((i) => i.id.startsWith('credit-release-'));
    expect(credit).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(credit)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('credit-release-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('credit-release-'))).toHaveLength(1);
  });
});
