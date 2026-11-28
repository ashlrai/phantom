import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTCOME_LEDGER_MAX_CELLS_PER_AXIS,
  OUTCOME_LEDGER_MIN_DAYS,
  OUTCOME_LEDGER_MIN_PROPOSALS,
  OUTCOME_LEDGER_MIN_ROWS,
  OUTCOME_LEDGER_WINDOW_MS,
  foldOutcomeLedgerEvidence,
  measureReasonKey,
  outcomeLedgerBacklogItems,
  promoteReasonKey,
} from '../src/core/improve/outcome-ledger-backlog.js';
import { appendLedger, type LedgerEvent, type LedgerRecord } from '../src/core/improve/outcomes.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

/** A verified-shape record for the pure fold; the fold never re-checks digests (readLedger does). */
const rec = (atMs: number, event: LedgerEvent): LedgerRecord => ({
  ...event,
  v: 1,
  at: new Date(atMs).toISOString(),
  prev: '0'.repeat(64),
  digest: '0'.repeat(64),
});

const registered = (proposalId: string): LedgerEvent => ({
  type: 'registered',
  proposalId,
  title: 't',
  proposalKind: 'test-kind',
  source: { kind: 'deterministic', rule: 'rule-1' },
  metric: { name: 'm', direction: 'increase', runner: { kind: 'node', path: 'metric.mjs' } },
  predictedDelta: null,
});

const measuredUnknown = (proposalId: string, phase: 'base' | 'head', reason: string, atMs: number): LedgerRecord =>
  rec(atMs, { type: 'measured', proposalId, phase, sha: phase === 'base' ? SHA_A : SHA_B, value: null, reason });

const measuredOk = (proposalId: string, phase: 'base' | 'head', value: number, atMs: number): LedgerRecord =>
  rec(atMs, { type: 'measured', proposalId, phase, sha: phase === 'base' ? SHA_A : SHA_B, value, reason: null });

const promotionRefused = (proposalId: string, reasons: string[], atMs: number): LedgerRecord =>
  rec(atMs, { type: 'promotion', proposalId, headSha: SHA_B, decision: 'refused', reasons });

const promotionQueued = (proposalId: string, atMs: number): LedgerRecord =>
  rec(atMs, { type: 'promotion', proposalId, headSha: SHA_B, decision: 'merge-queued', reasons: [] });

/** `count` unknown measurements of one reason kind across `days` UTC days and `proposals` proposals. */
const measureFailures = (reason: string, count: number, days: number, proposals: number): LedgerRecord[] => {
  const rows: LedgerRecord[] = [];
  const perDay = Math.ceil(count / days);
  for (let d = 0; d < days; d += 1) {
    for (let i = 0; i < perDay && rows.length < count; i += 1) {
      const proposalId = `aaaaaa${String((d * perDay + i) % proposals).padStart(4, '0')}`.slice(0, 10);
      rows.push(measuredUnknown(proposalId, rows.length % 2 === 0 ? 'base' : 'head', reason, NOW_MS - (days - 1 - d) * DAY_MS - i * 3_600_000));
    }
  }
  return rows;
};

/** `count` refused promotions touching one reason across `days` UTC days and `proposals` proposals. */
const promoteRefusals = (reason: string, count: number, days: number, proposals: number): LedgerRecord[] => {
  const rows: LedgerRecord[] = [];
  const perDay = Math.ceil(count / days);
  for (let d = 0; d < days; d += 1) {
    for (let i = 0; i < perDay && rows.length < count; i += 1) {
      const proposalId = `bbbbbb${String((d * perDay + i) % proposals).padStart(4, '0')}`.slice(0, 10);
      rows.push(promotionRefused(proposalId, [reason, 'checks not green: suite-x'], NOW_MS - (days - 1 - d) * DAY_MS - i * 3_600_000));
    }
  }
  return rows;
};

describe('reason classifiers', () => {
  it('classifies the writer measurement vocabulary and keeps unknowns verbatim', () => {
    expect(measureReasonKey('metric script metric.mjs is missing at this commit')).toBe('metric-script-missing');
    expect(measureReasonKey('checkout did not land on the requested commit')).toBe('checkout-mismatch');
    expect(measureReasonKey('not an exact 40-hex commit')).toBe('bad-commit');
    expect(measureReasonKey('metric printed nothing')).toBe('metric-no-output');
    expect(measureReasonKey('last stdout line is not JSON')).toBe('metric-not-json');
    expect(measureReasonKey('last stdout line does not name metric m')).toBe('metric-wrong-name');
    expect(measureReasonKey('metric value is not a finite number')).toBe('metric-bad-value');
    expect(measureReasonKey('metric timed out')).toBe('metric-timeout');
    expect(measureReasonKey('metric exited 1: Error: boom')).toBe('metric-exit-1');
    expect(measureReasonKey('metric exited 137: ')).toBe('metric-exit-137');
    expect(measureReasonKey('npm error code ENOSPC')).toBe('other:npm error code ENOSPC');
    expect(measureReasonKey(`x${'y'.repeat(200)}`)).toHaveLength('other:'.length + 120);
  });

  it('classifies the promotion gate vocabulary and keeps unknowns verbatim', () => {
    expect(promoteReasonKey('checks not green: suite-x, suite-y')).toBe('checks-red');
    expect(promoteReasonKey('checks still pending: suite-x')).toBe('checks-pending');
    expect(promoteReasonKey('no checks reported on the head commit')).toBe('checks-absent');
    expect(promoteReasonKey('no check actually passed on the head commit (all skipped or neutral)')).toBe('checks-none-green');
    expect(promoteReasonKey('metric m is unknown (base-unknown: x)')).toBe('metric-not-improved');
    expect(promoteReasonKey('metric m is regressed')).toBe('metric-not-improved');
    expect(promoteReasonKey('metric was measured on a different head commit; re-measure')).toBe('stale-head');
    expect(promoteReasonKey('base branch moved since the baseline was measured; re-measure')).toBe('stale-base');
    expect(promoteReasonKey('the gate has not re-measured the metric itself yet')).toBe('gate-not-remeasured');
    expect(promoteReasonKey('gate re-measurement is unknown (no value)')).toBe('gate-remeasure-unknown');
    expect(promoteReasonKey('recorded head value 3 does not reproduce (gate measured 4)')).toBe('gate-nonreproducible');
    expect(promoteReasonKey('gate re-measurement shows no improvement (1 -> 1)')).toBe('gate-no-improvement');
    expect(promoteReasonKey('touches src/core/improve/promote.ts: the promotion gate')).toBe('protected-path');
    expect(promoteReasonKey('touches the promotion gate or its governance (a.ts); a person reviews those')).toBe('promotion-gate');
    expect(promoteReasonKey('changes its own metric script metric.mjs; the yardstick must come from the base')).toBe('metric-script-self');
    expect(promoteReasonKey('the autonomy kill switch is on')).toBe('kill-switch');
    expect(promoteReasonKey('Phantom is paused')).toBe('paused');
    expect(promoteReasonKey('outcome ledger is not intact')).toBe('ledger-not-intact');
    expect(promoteReasonKey('no registered proposal with a declared metric')).toBe('unregistered-proposal');
    expect(promoteReasonKey('PR is merged, not open')).toBe('pr-not-open');
    expect(promoteReasonKey('PR head is in another repository')).toBe('cross-repo-head');
    expect(promoteReasonKey('branch feature/x is not owned by the improvement loop')).toBe('foreign-branch');
    expect(promoteReasonKey('PR targets dev, not the default branch master')).toBe('wrong-base');
    expect(promoteReasonKey('the PR changes nothing between its merge base and head')).toBe('empty-diff');
    expect(promoteReasonKey('weakens tests: test/x.test.ts drops an assertion')).toBe('test-weakening');
    expect(promoteReasonKey('auto-merge disabled again: ruleset')).toBe('automerge-drift');
    expect(promoteReasonKey('the PR changed while the gate measured it; run promote again')).toBe('pr-moved');
    expect(promoteReasonKey('some future gate reason nobody classified')).toBe('other:some future gate reason nobody classified');
  });
});

describe('foldOutcomeLedgerEvidence', () => {
  it('counts context tallies and bounds the window honestly', () => {
    const inside = NOW_MS - 2 * 3_600_000;
    const records = [
      rec(inside, registered('aaaaaa0001')),
      rec(inside + 60_000, { type: 'pr', proposalId: 'aaaaaa0001', repository: 'ashlrai/phantom', number: 42 }),
      measuredOk('aaaaaa0001', 'base', 10, inside + 120_000),
      measuredOk('aaaaaa0001', 'head', 12, inside + 180_000),
      measuredUnknown('aaaaaa0001', 'base', 'metric printed nothing', inside + 240_000),
      promotionQueued('aaaaaa0001', inside + 300_000),
      rec(inside + 360_000, { type: 'observed', proposalId: 'aaaaaa0001', observation: 'merged', sha: SHA_C }),
      rec(inside + 420_000, { type: 'observed', proposalId: 'aaaaaa0002', observation: 'reverted', sha: SHA_C }),
      rec(NOW_MS + 120_000, { type: 'registered', proposalId: 'aaaaaa0003', title: 't', proposalKind: 'k', source: { kind: 'deterministic', rule: 'r' }, metric: { name: 'm', direction: 'increase', runner: { kind: 'node', path: 'x.mjs' } }, predictedDelta: null }), // beyond skew
      rec(NOW_MS - OUTCOME_LEDGER_WINDOW_MS - DAY_MS, { type: 'registered', proposalId: 'aaaaaa0004', title: 't', proposalKind: 'k', source: { kind: 'deterministic', rule: 'r' }, metric: { name: 'm', direction: 'increase', runner: { kind: 'node', path: 'x.mjs' } }, predictedDelta: null }), // outside window
      { ...rec(inside + 480_000, { type: 'registered', proposalId: 'aaaaaa0005', title: 't', proposalKind: 'k', source: { kind: 'deterministic', rule: 'r' }, metric: { name: 'm', direction: 'increase', runner: { kind: 'node', path: 'x.mjs' } }, predictedDelta: null }), at: 'not-a-date' }, // undated
    ];
    const ev = foldOutcomeLedgerEvidence(records, { nowMs: NOW_MS });
    expect(ev.rows).toBe(8);
    expect(ev.outsideWindow).toBe(2);
    expect(ev.undatedRows).toBe(1);
    expect(ev.registeredRows).toBe(1);
    expect(ev.prRows).toBe(1);
    expect(ev.measuredRows).toBe(3);
    expect(ev.measuredUnknownRows).toBe(1);
    expect(ev.promotionRows).toBe(1);
    expect(ev.promotionQueuedRows).toBe(1);
    expect(ev.observedMergedRows).toBe(1);
    expect(ev.observedRevertedRows).toBe(1);
    expect(ev.measureCells).toEqual([]);
    expect(ev.promoteCells).toEqual([]);
    expect(ev.oldestAt).toBe(new Date(inside).toISOString());
    expect(ev.newestAt).toBe(new Date(inside + 420_000).toISOString());
  });

  it('groups measurement failures by reason kind and applies the recurring bars', () => {
    const records = [
      ...measureFailures('metric printed nothing', OUTCOME_LEDGER_MIN_ROWS, OUTCOME_LEDGER_MIN_DAYS, OUTCOME_LEDGER_MIN_PROPOSALS),
      // A different kind below the bars never joins a cell.
      measuredUnknown('cccccc0001', 'base', 'checkout did not land on the requested commit', NOW_MS - DAY_MS),
      measuredUnknown('cccccc0002', 'head', 'checkout did not land on the requested commit', NOW_MS - 2 * DAY_MS),
    ];
    const ev = foldOutcomeLedgerEvidence(records, { nowMs: NOW_MS });
    expect(ev.measuredUnknownRows).toBe(OUTCOME_LEDGER_MIN_ROWS + 2);
    expect(ev.measureCells).toHaveLength(1);
    const cell = ev.measureCells[0]!;
    expect(cell.key).toBe('metric-no-output');
    expect(cell.events).toBe(OUTCOME_LEDGER_MIN_ROWS);
    expect(cell.days.size).toBe(OUTCOME_LEDGER_MIN_DAYS);
    expect(cell.proposalIds.size).toBe(OUTCOME_LEDGER_MIN_PROPOSALS);
    expect(cell.reasons[0]).toMatchObject({ text: 'metric printed nothing', count: OUTCOME_LEDGER_MIN_ROWS });
  });

  it('suppresses cells under the rows, days or proposals bars', () => {
    // Enough rows but all on one UTC day.
    const oneDay = foldOutcomeLedgerEvidence(
      measureFailures('metric printed nothing', 4, 1, 4),
      { nowMs: NOW_MS },
    );
    expect(oneDay.measureCells).toEqual([]);
    // Enough rows and days but a single proposal.
    const oneProposal = foldOutcomeLedgerEvidence(
      measureFailures('metric printed nothing', 4, 2, 1),
      { nowMs: NOW_MS },
    );
    expect(oneProposal.measureCells).toEqual([]);
    // Below the row bar entirely.
    const few = foldOutcomeLedgerEvidence(
      measureFailures('metric printed nothing', OUTCOME_LEDGER_MIN_ROWS - 1, 2, 3),
      { nowMs: NOW_MS },
    );
    expect(few.measureCells).toEqual([]);
  });

  it('groups refused promotions once per touched kind and counts merge-queued as healthy', () => {
    const records = [
      ...promoteRefusals('checks not green: suite-x', OUTCOME_LEDGER_MIN_ROWS, OUTCOME_LEDGER_MIN_DAYS, OUTCOME_LEDGER_MIN_PROPOSALS),
      // An event touching two kinds counts once toward each.
      promotionRefused('dddddd0001', ['metric m is unknown (x)', 'checks not green: suite-y'], NOW_MS - 3 * DAY_MS),
      promotionRefused('dddddd0002', ['metric m is unknown (x)', 'checks not green: suite-y'], NOW_MS - 4 * DAY_MS),
      promotionRefused('dddddd0003', ['metric m is unknown (x)'], NOW_MS - 5 * DAY_MS),
      promotionQueued('dddddd0004', NOW_MS - DAY_MS),
    ];
    const ev = foldOutcomeLedgerEvidence(records, { nowMs: NOW_MS });
    expect(ev.promotionRows).toBe(OUTCOME_LEDGER_MIN_ROWS + 4);
    expect(ev.promotionQueuedRows).toBe(1);
    const keys = ev.promoteCells.map((c) => c.key);
    expect(keys).toContain('checks-red');
    expect(keys).toContain('metric-not-improved');
    const checks = ev.promoteCells.find((c) => c.key === 'checks-red')!;
    // 3 recurring + 2 multi-kind events = 5 events touching checks-red.
    expect(checks.events).toBe(OUTCOME_LEDGER_MIN_ROWS + 2);
    const metric = ev.promoteCells.find((c) => c.key === 'metric-not-improved')!;
    expect(metric.events).toBe(2 + 1);
    expect(metric.days.size).toBe(3);
  });
});

describe('outcomeLedgerBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'outcome-ledger-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  const ledgerPath = (name: string): string => join(home, name, 'outcomes.jsonl');

  /** Append real digest-chained events at the given times. */
  function writeLedger(path: string, entries: Array<{ atMs: number; event: LedgerEvent }>): void {
    for (const { atMs, event } of entries) {
      appendLedger(event, { path, now: new Date(atMs) });
    }
  }

  const failingMeasureEntries = (reason: string, count: number, days: number, proposals: number) =>
    measureFailures(reason, count, days, proposals).map((r) => ({ atMs: Date.parse(r.at), event: r }));

  const failingPromoteEntries = (reason: string, count: number, days: number, proposals: number) =>
    promoteRefusals(reason, count, days, proposals).map((r) => ({ atMs: Date.parse(r.at), event: r }));

  it('emits a measurement-failure item at the recurring bar and validates it', async () => {
    const path = ledgerPath('ledger-measure');
    writeLedger(path, failingMeasureEntries('metric printed nothing', OUTCOME_LEDGER_MIN_ROWS, OUTCOME_LEDGER_MIN_DAYS, OUTCOME_LEDGER_MIN_PROPOSALS));
    const items = await outcomeLedgerBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'self-improvement' });
    expect(item!.id).toBe('outcome-ledger-measure-metric-no-output');
    expect(item!.title).toContain('metric-no-output');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('metric printed nothing');
    expect(item!.prompt).toContain('outcomes.jsonl');
    expect(item!.prompt).toContain('phm improve outcomes');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits a promotion-refusal item at the recurring bar', async () => {
    const path = ledgerPath('ledger-promote');
    writeLedger(path, failingPromoteEntries('checks not green: suite-x', OUTCOME_LEDGER_MIN_ROWS, OUTCOME_LEDGER_MIN_DAYS, OUTCOME_LEDGER_MIN_PROPOSALS));
    const items = await outcomeLedgerBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item!.id).toBe('outcome-ledger-promote-checks-red');
    expect(item!.title).toContain('checks-red');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('checks not green');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits an integrity item when the digest chain is broken, keeping the verified prefix', async () => {
    const path = ledgerPath('ledger-broken');
    writeLedger(path, [
      { atMs: NOW_MS - 3 * DAY_MS, event: registered('aaaaaa0001') },
      { atMs: NOW_MS - 2 * DAY_MS, event: measuredUnknown('aaaaaa0001', 'base', 'metric printed nothing', NOW_MS - 2 * DAY_MS) },
      { atMs: NOW_MS - DAY_MS, event: measuredUnknown('aaaaaa0002', 'base', 'metric printed nothing', NOW_MS - DAY_MS) },
      { atMs: NOW_MS - DAY_MS + 60_000, event: measuredUnknown('aaaaaa0003', 'base', 'metric printed nothing', NOW_MS - DAY_MS + 60_000) },
    ]);
    // Forge a line past the verified prefix: valid JSON, wrong digest.
    appendFileSync(path, `${JSON.stringify({ ...rec(NOW_MS, { type: 'pr', proposalId: 'aaaaaa0004', repository: 'ashlrai/phantom', number: 7 }), prev: 'f'.repeat(64), digest: 'e'.repeat(64) })}\n`);
    const items = await outcomeLedgerBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW_MS) });
    const ids = items.map((i) => i.id);
    expect(ids).toContain('outcome-ledger-integrity');
    const integrity = items.find((i) => i.id === 'outcome-ledger-integrity')!;
    expect(validBacklogItem(integrity)).not.toBeNull();
    expect(integrity.prompt).toContain('chain-broken');
    // The verified prefix's recurring failures still fold alongside.
    expect(ids).toContain('outcome-ledger-measure-metric-no-output');
  });

  it('emits nothing for a missing ledger, healthy rows, below-bar evidence, or another repository', async () => {
    // Missing ledger: clean first run.
    expect(await outcomeLedgerBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: ledgerPath('absent'), now: new Date(NOW_MS) })).toEqual([]);

    // Healthy rows only: measured values, queued promotions, merges.
    const healthy = ledgerPath('ledger-healthy');
    writeLedger(healthy, [
      { atMs: NOW_MS - 3 * DAY_MS, event: registered('aaaaaa0001') },
      { atMs: NOW_MS - 2 * DAY_MS, event: measuredOk('aaaaaa0001', 'base', 10, NOW_MS - 2 * DAY_MS) },
      { atMs: NOW_MS - 2 * DAY_MS + 60_000, event: measuredOk('aaaaaa0001', 'head', 12, NOW_MS - 2 * DAY_MS + 60_000) },
      { atMs: NOW_MS - DAY_MS, event: promotionQueued('aaaaaa0001', NOW_MS - DAY_MS) },
      { atMs: NOW_MS - DAY_MS + 60_000, event: { type: 'observed', proposalId: 'aaaaaa0001', observation: 'merged', sha: SHA_C } },
    ]);
    expect(await outcomeLedgerBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: healthy, now: new Date(NOW_MS) })).toEqual([]);

    // Below the bars: failures on one UTC day only.
    const oneDay = ledgerPath('ledger-oneday');
    writeLedger(oneDay, measureFailures('metric printed nothing', 4, 1, 4).map((r) => ({ atMs: Date.parse(r.at), event: r })));
    expect(await outcomeLedgerBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = ledgerPath('ledger-repo');
    writeLedger(dir, failingMeasureEntries('metric printed nothing', OUTCOME_LEDGER_MIN_ROWS, OUTCOME_LEDGER_MIN_DAYS, OUTCOME_LEDGER_MIN_PROPOSALS));
    expect(await outcomeLedgerBacklogItems({ repo: 'ashlrai/other', ledgerPath: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await outcomeLedgerBacklogItems({ repo: 'AshlrAI/Phantom', ledgerPath: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('caps reason cells per axis and honors the item limit', async () => {
    const path = ledgerPath('ledger-cells');
    const entries: Array<{ atMs: number; event: LedgerEvent }> = [];
    // Four distinct recurring measure kinds — one more than the per-axis cap.
    const kinds = ['metric printed nothing', 'metric timed out', 'checkout did not land on the requested commit', 'metric value is not a finite number'];
    kinds.forEach((reason, k) => {
      for (const e of measureFailures(reason, OUTCOME_LEDGER_MIN_ROWS, OUTCOME_LEDGER_MIN_DAYS, OUTCOME_LEDGER_MIN_PROPOSALS)) {
        // Shift each kind's proposal ids apart so cells stay distinct.
        const shifted = { ...e } as LedgerRecord;
        (shifted as { proposalId: string }).proposalId = `${'eeeee'}${k}${e.proposalId.slice(6)}`.slice(0, 10);
        entries.push({ atMs: Date.parse(shifted.at), event: shifted });
      }
    });
    writeLedger(path, entries);
    const items = await outcomeLedgerBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW_MS) });
    const measureItems = items.filter((i) => i.id.startsWith('outcome-ledger-measure-'));
    expect(measureItems).toHaveLength(OUTCOME_LEDGER_MAX_CELLS_PER_AXIS);
    expect(await outcomeLedgerBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW_MS), limit: 1 })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const path = ledgerPath('ledger-stable');
    writeLedger(path, [
      ...failingMeasureEntries('metric printed nothing', OUTCOME_LEDGER_MIN_ROWS, OUTCOME_LEDGER_MIN_DAYS, OUTCOME_LEDGER_MIN_PROPOSALS),
      ...failingPromoteEntries('checks not green: suite-x', OUTCOME_LEDGER_MIN_ROWS, OUTCOME_LEDGER_MIN_DAYS, OUTCOME_LEDGER_MIN_PROPOSALS),
    ]);
    const opts = { repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW_MS) };
    const first = await outcomeLedgerBacklogItems(opts);
    const second = await outcomeLedgerBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeGreaterThanOrEqual(2);
  });

  it('appends outcome-ledger items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const path = join(home, '.ashlr', 'improve', 'outcomes.jsonl');
      writeLedger(path, [
        ...failingMeasureEntries('metric printed nothing', OUTCOME_LEDGER_MIN_ROWS, OUTCOME_LEDGER_MIN_DAYS, OUTCOME_LEDGER_MIN_PROPOSALS),
        ...failingPromoteEntries('checks not green: suite-x', OUTCOME_LEDGER_MIN_ROWS, OUTCOME_LEDGER_MIN_DAYS, OUTCOME_LEDGER_MIN_PROPOSALS),
      ]);
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const ledgerItems = first.items.filter((i) => i.id.startsWith('outcome-ledger-'));
      expect(ledgerItems.map((i) => i.id)).toEqual([
        'outcome-ledger-measure-metric-no-output',
        'outcome-ledger-promote-checks-red',
      ]);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(ledgerItems)).toBe(2);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('outcome-ledger-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('outcome-ledger-'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
