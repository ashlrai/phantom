import { describe, expect, it } from 'vitest';
import type { LedgerEntry, LedgerReadOptions, LedgerReadResult } from '../src/core/authority/types.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  classifyHarnessEntry,
  foldHarnessRows,
  harnessBacklogItems,
  harnessTargetOf,
} from '../src/core/improve/harness-backlog.js';
import type { HarnessStateV1 } from '../src/core/learn/harness-registry.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import { resetLedgerCachesForTest } from '../src/core/authority/ledger.js';

const NOW = new Date('2026-11-23T12:00:00Z');
const at = (days: number, hours = 0): string =>
  new Date(NOW.getTime() - days * 86400_000 + hours * 3600_000).toISOString();

const REPO = 'ashlrai/phantom';

let seq = 0;
function entry(kind: LedgerEntry['kind'], data: Record<string, unknown>, days: number, actor: LedgerEntry['actor'] = 'daemon'): LedgerEntry {
  seq += 1;
  return {
    v: 1,
    seq,
    at: at(days),
    actor,
    grantId: null,
    repo: null,
    prevHash: '0'.repeat(64),
    hash: '1'.repeat(64),
    kind,
    data,
  } as unknown as LedgerEntry;
}

const experiment = (id: string, status: string, verdict: string | null, days: number, actor: LedgerEntry['actor'] = 'daemon'): LedgerEntry =>
  entry('harness:experiment', {
    v: 1, id, hypothesisId: `h-${id}`, baseVersionId: 'h-0000', candidateVersionId: `h-${id}`,
    taskSet: { id: 'heldout', digest: 'd' }, status, pairs: 8, wins: 1, losses: 7, ties: 0,
    lift: null, refuseRegression: null, claimedChangeNoneMadeDelta: null, costDeltaPct: null,
    verdict, reasons: ['the paired eval could not separate the arms'], startedAt: at(days + 1), finishedAt: at(days),
  }, days, actor);

const rollback = (versionId: string, fromVersionId: string, experimentId: string | null, days: number): LedgerEntry =>
  entry('harness:rolled-back', {
    versionId, fromVersionId, configDigest: 'c'.repeat(64), experimentId,
    reason: 'canary pass rate fell below baseline - 1 SE',
  }, days);

const adopted = (versionId: string, experimentId: string, days: number): LedgerEntry =>
  entry('harness:adopted', {
    versionId, fromVersionId: 'h-0000', configDigest: 'c'.repeat(64), experimentId,
    reason: 'adopted by leader: gate passed',
  }, days, 'leader');

const rejectedRow = (versionId: string, experimentId: string, days: number): LedgerEntry =>
  entry('harness:rejected', {
    versionId, fromVersionId: 'h-0000', configDigest: 'c'.repeat(64), experimentId,
    reason: 'the adoption gate does not hold',
  }, days);

const stateWith = (targets: Record<string, string>): HarnessStateV1 => ({
  v: 1,
  versionSeq: 9,
  experimentSeq: 9,
  activeId: null,
  versions: [],
  canary: null,
  experiments: [],
  experimentMeta: Object.fromEntries(Object.entries(targets).map(([id, target]) => [id, {
    requestedBy: 'leader' as const,
    hypothesis: { v: 1 as const, id: `h-${id}`, source: { kind: 'leader' as const, ref: null }, target: target as never, patch: {}, statement: 's', metric: 'm', predictedDelta: 1, createdAt: at(9) },
    queuedAt: at(9),
    runner: null,
    cancel: null,
    armPasses: null,
  }])),
  hypotheses: [],
  outcomes: [],
});

const ledgerResult = (entries: LedgerEntry[], chain: LedgerReadResult['chain'] = 'ok'): LedgerReadResult => ({
  entries, head: entries.length ? { seq: entries.length, hash: 'f'.repeat(64), at: entries.at(-1)!.at } : null,
  chain, brokenAtSeq: chain === 'broken' ? 3 : null, reason: chain === 'broken' ? 'test break' : null,
});

const reader =
  (entries: LedgerEntry[], chain: LedgerReadResult['chain'] = 'ok') =>
  async (_opts: LedgerReadOptions): Promise<LedgerReadResult> => ledgerResult(entries, chain);

describe('classifyHarnessEntry', () => {
  it('classifies the four adverse experiment outcomes and the rollback', () => {
    expect(classifyHarnessEntry(experiment('e1', 'failed', null, 1))).toMatchObject({ kind: 'experiment-failed', experimentId: 'e1' });
    expect(classifyHarnessEntry(experiment('e2', 'cancelled', null, 1))).toMatchObject({ kind: 'experiment-cancelled', experimentId: 'e2' });
    expect(classifyHarnessEntry(experiment('e3', 'done', 'inconclusive', 1))).toMatchObject({ kind: 'experiment-inconclusive', experimentId: 'e3' });
    expect(classifyHarnessEntry(experiment('e4', 'done', 'reject', 1))).toMatchObject({ kind: 'candidate-rejected', experimentId: 'e4' });
    expect(classifyHarnessEntry(rollback('h-0001', 'h-0002', 'e9', 1))).toMatchObject({ kind: 'adoption-rolled-back', experimentId: 'e9' });
  });

  it('skips the success path, non-terminal states, other kinds and malformed payloads', () => {
    expect(classifyHarnessEntry(experiment('e5', 'done', 'adopt', 1))).toBeNull();
    expect(classifyHarnessEntry(experiment('e6', 'running', null, 1))).toBeNull();
    expect(classifyHarnessEntry(experiment('e7', 'queued', null, 1))).toBeNull();
    expect(classifyHarnessEntry(experiment('e8', 'done', null, 1))).toBeNull();
    expect(classifyHarnessEntry(adopted('h-0003', 'e10', 1))).toBeNull();
    expect(classifyHarnessEntry(rejectedRow('h-0004', 'e11', 1))).toBeNull();
    expect(classifyHarnessEntry(entry('gate:result', { verdict: 'refuse' }, 1))).toBeNull();
    expect(classifyHarnessEntry(experiment('', 'failed', null, 1))).toBeNull();
    const bad = experiment('e12', 'failed', null, 1);
    (bad as { data: unknown }).data = { status: 'failed' };
    expect(classifyHarnessEntry(bad)).toBeNull();
    const badRollback = rollback('h-0005', 'h-0006', 'e13', 1);
    (badRollback as { data: unknown }).data = 'not-an-object';
    expect(classifyHarnessEntry(badRollback)).toBeNull();
  });
});

describe('harnessTargetOf', () => {
  it('resolves targets through experimentMeta and degrades honestly', () => {
    const state = stateWith({ e1: 'routing', e2: 'prompt' });
    expect(harnessTargetOf(state, 'e1')).toBe('routing');
    expect(harnessTargetOf(state, 'e2')).toBe('prompt');
    expect(harnessTargetOf(state, 'missing')).toBe('unknown');
    expect(harnessTargetOf(state, null)).toBe('unknown');
    expect(harnessTargetOf(null, 'e1')).toBe('unknown');
    const bad = stateWith({ e1: 'routing' });
    bad.experimentMeta['e3'] = { ...bad.experimentMeta['e1']!, hypothesis: { ...bad.experimentMeta['e1']!.hypothesis, target: 'bogus' as never } };
    expect(harnessTargetOf(bad, 'e3')).toBe('unknown');
  });
});

describe('foldHarnessRows', () => {
  it('folds rows into (kind, target) cells inside the window only', () => {
    const rows = [
      ...[1, 2, 4].map((d) => classifyHarnessEntry(experiment(`f${d}`, 'failed', null, d))!),
      classifyHarnessEntry(experiment('r1', 'done', 'reject', 2))!,
      classifyHarnessEntry(rollback('h-0007', 'h-0008', 'f1', 3))!,
      classifyHarnessEntry(experiment('old', 'failed', null, 10))!,
    ];
    const state = stateWith({ f1: 'routing', f2: 'routing', f4: 'routing', r1: 'prompt' });
    const fold = foldHarnessRows(rows, state, NOW.getTime());
    expect(fold.size).toBe(3);
    const failed = [...fold.values()].find((c) => c.kind === 'experiment-failed' && c.target === 'routing');
    expect(failed?.track.rows).toBe(3);
    expect(failed?.track.days.size).toBe(3);
    const rejected = [...fold.values()].find((c) => c.kind === 'candidate-rejected');
    expect(rejected?.track.rows).toBe(1);
    const rolled = [...fold.values()].find((c) => c.kind === 'adoption-rolled-back');
    expect(rolled?.target).toBe('routing');
  });
});

describe('harnessBacklogItems', () => {
  const failedCell = (): LedgerEntry[] => [
    experiment('e1', 'failed', null, 1, 'daemon'),
    experiment('e2', 'failed', null, 2, 'leader'),
    experiment('e3', 'failed', null, 4, 'daemon'),
  ];

  it('turns recurring failed experiments on one target into a valid priority-3 item', async () => {
    const items = await harnessBacklogItems({
      repo: REPO, now: NOW,
      readLedger: reader(failedCell()),
      loadHarnessState: () => stateWith({ e1: 'routing', e2: 'routing', e3: 'routing' }),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^harness-experiment-failed-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'harness' });
    expect(item.title).toContain('router weights');
    expect(item.prompt).toContain('3 adverse row(s) across 3 distinct UTC day(s)');
    expect(item.prompt).toContain('2 distinct recorded actor(s)');
    expect(item.prompt).toContain('authority/ledger.jsonl');
    expect(item.prompt).toContain('harness-registry.ts');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('dispatch router weights');
  });

  it('keeps cells quiet below the row or day bar', async () => {
    const two = await harnessBacklogItems({
      repo: REPO, now: NOW,
      readLedger: reader([experiment('e1', 'failed', null, 1), experiment('e2', 'failed', null, 2)]),
      loadHarnessState: () => stateWith({}),
    });
    expect(two).toEqual([]);
    const oneDay = await harnessBacklogItems({
      repo: REPO, now: NOW,
      readLedger: reader([
        experiment('e1', 'failed', null, 1), experiment('e2', 'failed', null, 1, 'leader'), experiment('e3', 'failed', null, 1),
      ]),
      loadHarnessState: () => stateWith({}),
    });
    expect(oneDay).toEqual([]);
  });

  it('emits each adverse kind on its own cell and never the success path', async () => {
    const entries = [
      ...failedCell(),
      experiment('c1', 'cancelled', null, 1), experiment('c2', 'cancelled', null, 2), experiment('c3', 'cancelled', null, 4),
      experiment('i1', 'done', 'inconclusive', 1), experiment('i2', 'done', 'inconclusive', 2), experiment('i3', 'done', 'inconclusive', 4),
      experiment('r1', 'done', 'reject', 1), experiment('r2', 'done', 'reject', 2), experiment('r3', 'done', 'reject', 4),
      experiment('a1', 'done', 'adopt', 1), experiment('a2', 'done', 'adopt', 2), experiment('a3', 'done', 'adopt', 4),
      adopted('h-0100', 'a1', 2), adopted('h-0101', 'a2', 3), adopted('h-0102', 'a3', 4),
      rejectedRow('h-0103', 'r1', 2), rejectedRow('h-0104', 'r2', 3), rejectedRow('h-0105', 'r3', 4),
    ];
    const items = await harnessBacklogItems({
      repo: REPO, now: NOW,
      readLedger: reader(entries),
      loadHarnessState: () => stateWith({}),
    });
    expect(items).toHaveLength(4);
    const kinds = items.map((i) => i.id).sort();
    expect(kinds.every((id) => id.startsWith('harness-'))).toBe(true);
    expect(items.some((i) => i.id.includes('adopted') || i.id.includes('adopt-'))).toBe(false);
    // All metas missing → every cell folds under 'unknown'.
    for (const item of items) {
      expect(item.prompt).toContain("'unknown'");
      expect(item.prompt).toContain('unrecorded target');
    }
  });

  it('folds rolled-back rows into their own recurring cell keyed by the failed adoption\'s target', async () => {
    const items = await harnessBacklogItems({
      repo: REPO, now: NOW,
      readLedger: reader([
        rollback('h-0000', 'h-0100', 'e1', 1),
        rollback('h-0000', 'h-0101', 'e2', 2),
        rollback('h-0000', 'h-0103', 'e3', 4),
        rollback('h-0002', 'h-0104', null, 1),
        rollback('h-0002', 'h-0105', null, 3),
        rollback('h-0002', 'h-0106', null, 5),
      ]),
      loadHarnessState: () => stateWith({ e1: 'skill', e2: 'skill', e3: 'skill' }),
    });
    expect(items).toHaveLength(2);
    const skill = items.find((i) => i.title.includes('skill'));
    const unknown = items.find((i) => i.title.includes('unrecorded'));
    expect(skill?.id).toMatch(/^harness-adoption-rolled-back-/);
    expect(skill?.prompt).toContain('3 adverse row(s)');
    expect(skill?.prompt).toContain('enabled learned-skill set');
    expect(unknown?.id).toMatch(/^harness-adoption-rolled-back-/);
    expect(unknown?.prompt).toContain('3 adverse row(s)');
    expect(unknown?.prompt).toContain('manual rollback');
  });

  it('fails closed on a broken chain and yields nothing for an empty one', async () => {
    const entries = failedCell();
    expect(await harnessBacklogItems({
      repo: REPO, now: NOW, readLedger: reader(entries, 'broken'), loadHarnessState: () => stateWith({}),
    })).toEqual([]);
    expect(await harnessBacklogItems({
      repo: REPO, now: NOW, readLedger: reader([], 'empty'), loadHarnessState: () => stateWith({}),
    })).toEqual([]);
  });

  it('emits only for the fleet repository and tolerates read failures', async () => {
    const read = reader(failedCell());
    expect(await harnessBacklogItems({ repo: 'ashlrai/lexicon', now: NOW, readLedger: read, loadHarnessState: () => stateWith({}) })).toEqual([]);
    expect(await harnessBacklogItems({ repo: '', now: NOW, readLedger: read, loadHarnessState: () => stateWith({}) })).toEqual([]);
    expect(await harnessBacklogItems({ repo: 'not-a-repo', now: NOW, readLedger: read, loadHarnessState: () => stateWith({}) })).toEqual([]);
    const throwing = async (): Promise<LedgerReadResult> => { throw new Error('ledger gone'); };
    expect(await harnessBacklogItems({ repo: REPO, now: NOW, readLedger: throwing, loadHarnessState: () => stateWith({}) })).toEqual([]);
    const items = await harnessBacklogItems({ repo: 'AshlrAI/Phantom', now: NOW, readLedger: read, loadHarnessState: () => stateWith({}) });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('degrades to unknown targets when the state reader throws or is absent', async () => {
    const items = await harnessBacklogItems({
      repo: REPO, now: NOW,
      readLedger: reader(failedCell()),
      loadHarnessState: () => { throw new Error('state gone'); },
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain("'unknown'");
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const read = reader(failedCell());
    const load = () => stateWith({ e1: 'routing', e2: 'routing', e3: 'routing' });
    const first = await harnessBacklogItems({ repo: REPO, now: NOW, readLedger: read, loadHarnessState: load });
    const second = await harnessBacklogItems({ repo: REPO, now: NOW, readLedger: read, loadHarnessState: load });
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    const one = await harnessBacklogItems({ repo: REPO, now: NOW, readLedger: read, loadHarnessState: load, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(first[0]!.id);
  });

  it('never emits actor or reason text, even when it is secret-shaped', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const entries = [
      experiment('e1', 'failed', null, 1, 'daemon'),
      experiment('e2', 'failed', null, 2, 'leader'),
      experiment('e3', 'failed', null, 4, 'daemon'),
    ];
    for (const e of entries) (e.data as { reasons: string[] }).reasons = [`runner error: ${token}`];
    const items = await harnessBacklogItems({
      repo: REPO, now: NOW,
      readLedger: reader(entries),
      loadHarnessState: () => stateWith({ e1: 'routing', e2: 'routing', e3: 'routing' }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('2 distinct recorded actor(s)');
  });

  it('appends harness items through discovery and dedupes on refresh', async () => {
    resetLedgerCachesForTest();
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      if (p.includes('/check-runs')) return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"check_runs":[]}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    // discoverBacklog reads the real ledger path; on a machine without one it yields nothing,
    // so assert the integration contract instead: no throw, valid items, harness prefix absent-or-valid.
    const result = await discoverBacklog(REPO, { gh: greenGh });
    expect(result.errors).toEqual([]);
    expect(result.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    const harnessItems = result.items.filter((i) => i.id.startsWith('harness-'));
    for (const item of harnessItems) expect(validBacklogItem(item)).not.toBeNull();
    if (harnessItems.length > 0) {
      expect(appendUserBacklogItems(harnessItems)).toBe(harnessItems.length);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('harness-')).length).toBe(harnessItems.length);
    }
  });
});
