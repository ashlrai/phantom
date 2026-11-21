import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  authorityRevertedPrKeys,
  foldRouteDecisionWorkClasses,
  foldRouterOutcomes,
  foldSpendCosts,
  readLedgerFile,
  readLedgerTail,
  readRouterOutcomes,
  ROUTER_OUTCOME_LEDGER_LIMIT,
  type RouterOutcomeEvidenceRow,
} from '../src/core/router/outcomes.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runsDir(ledger?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ledger-612s-'));
  roots.push(root);
  if (ledger !== undefined) {
    mkdirSync(join(root, 'metrics'));
    writeFileSync(join(root, 'metrics', 'jobs.jsonl'), ledger);
  }
  return root;
}

const ledgerPath = (root: string) => join(root, 'metrics', 'jobs.jsonl');
const spendPath = (root: string) => join(root, 'metrics', 'api-spend.jsonl');

function writeSpend(root: string, text: string): void {
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(spendPath(root), text);
}

const marketPath = (root: string) => join(root, 'metrics', 'work-market.jsonl');

function writeMarket(root: string, rows: object[]): void {
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(marketPath(root), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

/** A work-market.v1 route_decision row in the dispatcher's own shape. */
const decision = (job: string, workClass: string, ts: number, extra: Record<string, unknown> = {}): object => ({
  schema: 'work-market.v1', event: 'route_decision', job,
  chosen_lane: 'alpha', preferred_lane: 'alpha', work_class: workClass,
  override: null, rejected_lanes: [], reason_codes: [], ts, ...extra,
});

function ashlarDir(scores?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'ledger-612s-eval-'));
  roots.push(root);
  if (scores !== undefined) {
    mkdirSync(join(root, 'eval', 'passk'), { recursive: true });
    writeFileSync(join(root, 'eval', 'passk', 'lane-scores.json'), typeof scores === 'string' ? scores : JSON.stringify(scores));
  }
  return root;
}

const laneScores = (lanes: unknown[]) => ({
  schema: 'eval.lane-scores.v1', generatedAt: '2026-11-19T00:00:00Z', reportId: 'r1', k: 3, trials: 9, lanes,
});
const scoreRow = (lane: string, model: string, passPowK: number | null) => ({
  lane, model, tasks: 3, trials: 9, passes: 6, pass1: 2 / 3, ci95: null, passAtK: 0.9, passPowK,
});

describe('router outcome ledger (612S preservation)', () => {
  it('folds mixed valid and malformed rows and tolerates blanks', () => {
    const text = [
      '{"job":"J1","lane":"alpha","model":"m1","tier":"work","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      'not json',
      '',
      '[1,2]',
      '42',
      '{"job":"J2","lane":"beta"}',
    ].join('\n');
    const fold = foldRouterOutcomes(text);
    expect(fold.malformed_rows).toBe(3);
    expect(fold.unattached_rows).toBe(0);
    expect(fold.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2']);
    expect(fold.outcomes[0]).toMatchObject({ schema: 'router.outcome.v1', lane: 'alpha', model: 'm1', tier: 'work', merged: true, passk: null });
  });

  it('joins a PR URL to its job only through an exact, unambiguous claim', () => {
    const text = [
      '{"job":"J1","pr_url":"https://github.com/o/r/pull/1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"pr_url":"https://github.com/o/r/pull/1","cost_usd":2.5}',
      '{"job":"J2","pr_url":"https://github.com/o/r/pull/2","phase":"CLOSED"}',
      '{"pr_url":"https://github.com/o/r/pull/9","phase":"MERGED"}',
    ].join('\n');
    const fold = foldRouterOutcomes(text);
    const j1 = fold.outcomes.find(o => o.job_id === 'J1');
    expect(j1).toMatchObject({ merged: true, cost_usd: 2.5 });
    expect(fold.outcomes.find(o => o.job_id === 'J2')).toMatchObject({ merged: false });
    // PR 9 has no job identity anywhere: counted as unattached, never attached to a guess.
    expect(fold.unattached_rows).toBe(1);
    expect(fold.outcomes).toHaveLength(2);
  });

  it('refuses to attach URL-only rows when two jobs claim the same PR', () => {
    const text = [
      '{"job":"A","pr_url":"https://github.com/o/r/pull/7"}',
      '{"job":"B","pr_url":"https://github.com/o/r/pull/7"}',
      '{"pr_url":"https://github.com/o/r/pull/7","phase":"MERGED","cost_usd":9}',
    ].join('\n');
    const fold = foldRouterOutcomes(text);
    expect(fold.ambiguous_urls).toBe(1);
    expect(fold.unattached_rows).toBe(1);
    for (const o of fold.outcomes) {
      expect(o.merged).toBeNull();
      expect(o.cost_usd).toBeNull();
    }
  });

  it('keeps unknown measurements null and does not infer merge from VERIFIED, CI, or a PR URL', () => {
    const fold = foldRouterOutcomes('{"job":"U1","phase":"VERIFIED","pr_url":"https://github.com/o/r/pull/3","ci_first_pass":"yes","cost_usd":-1}\n');
    expect(fold.outcomes).toEqual([{
      schema: 'router.outcome.v1', job_id: 'U1', lane: null, model: null, tier: null, work_class: null,
      merged: null, reverted: null, ci_first_pass: null, review_findings: null, cost_usd: null, wall_s: null,
      empty: null, exit_code: null, failure_class: null, passk: null,
    }]);
  });

  it('folds revert evidence from every recorded dialect, sticky-true', () => {
    const fold = foldRouterOutcomes([
      '{"job":"V1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"V1","event":"revert","ts":"2026-11-02T00:00:00Z"}',
      '{"job":"V1","reverted":false,"ts":"2026-11-03T00:00:00Z"}',
      '{"job":"V2","phase":"MERGED","reverted":true}',
      '{"job":"V3","phase":"MERGED","reverted":false}',
      '{"job":"V4","outcome":"reverted"}',
      '{"job":"V5","state":"REVERTED"}',
      '{"job":"V6","kind":"reverted"}',
      '{"job":"V7","reverted_at":"2026-11-04T00:00:00Z"}',
      '{"job":"V8","revertedAt":"2026-11-04T00:00:00Z"}',
      '{"job":"V9","phase":"MERGED"}',
      '{"job":"V10","event":"revert_coverage","repo":"o/r"}',
      '{"job":"V11","event":"revert-failed"}',
      '{"job":"V12","reverted_at":"not-a-date"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // A recorded revert is never contradicted by a later reverted:false.
    expect(byId.get('V1')).toMatchObject({ merged: true, reverted: true });
    expect(byId.get('V2')).toMatchObject({ merged: true, reverted: true });
    // Explicit reverted:false stands only with no positive evidence.
    expect(byId.get('V3')).toMatchObject({ merged: true, reverted: false });
    for (const id of ['V4', 'V5', 'V6', 'V7', 'V8']) expect(byId.get(id)?.reverted).toBe(true);
    // No evidence stays unknown; coverage markers and failed reverts are not reverts.
    expect(byId.get('V9')?.reverted).toBeNull();
    expect(byId.get('V10')?.reverted).toBeNull();
    expect(byId.get('V11')?.reverted).toBeNull();
    expect(byId.get('V12')?.reverted).toBeNull();
  });

  it('attaches a revert event to its job through an unambiguous PR URL only', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","pr_url":"https://github.com/o/r/pull/1","phase":"MERGED"}',
      '{"pr_url":"https://github.com/o/r/pull/1","event":"revert"}',
      '{"job":"A","pr_url":"https://github.com/o/r/pull/7"}',
      '{"job":"B","pr_url":"https://github.com/o/r/pull/7"}',
      '{"pr_url":"https://github.com/o/r/pull/7","event":"revert"}',
      '{"pr_url":"https://github.com/o/r/pull/9","event":"revert"}',
    ].join('\n'));
    expect(fold.outcomes.find(o => o.job_id === 'J1')).toMatchObject({ merged: true, reverted: true });
    // The ambiguous PR's revert row attaches to neither claimant.
    for (const id of ['A', 'B']) expect(fold.outcomes.find(o => o.job_id === id)?.reverted).toBeNull();
    // A revert row with no job or PR claim is unattached, never guessed.
    expect(fold.unattached_rows).toBe(2);
  });

  it('preserves measured zero and false instead of coercing them to null', () => {
    const text = [
      '{"job":"Z1","merged":false,"ci_first_pass":false,"cost_usd":0,"wall_s":0,"review_findings":{"fixed":0,"rejected":0,"ignored":0}}',
    ].join('\n');
    const [o] = foldRouterOutcomes(text).outcomes;
    expect(o).toMatchObject({ merged: false, ci_first_pass: false, cost_usd: 0, wall_s: 0, review_findings: { fixed: 0, rejected: 0, ignored: 0 } });
  });

  it('rejects non-integer or negative review counts instead of recording them', () => {
    const [o] = foldRouterOutcomes('{"job":"R1","review_findings":{"fixed":1.5,"rejected":0,"ignored":0}}').outcomes;
    expect(o!.review_findings).toBeNull();
  });

  it('folds finish-row productivity verdicts, newest explicit value wins', () => {
    const fold = foldRouterOutcomes([
      '{"job":"F1","event":"finish","empty":true,"exit_code":1,"failure_class":"quota","wall_s":10}',
      '{"job":"F1","event":"finish","empty":false,"exit_code":0,"wall_s":20}',
      '{"job":"F2","event":"finish","empty":false,"exit_code":-9,"failureClass":"authentication"}',
      '{"job":"F3","event":"finish","empty":"yes","exit_code":"1","failure_class":"Not A Label!"}',
      '{"job":"F4","event":"claim"}',
      '{"job":"F5","exitCode":3}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // The newest finish row wins per field; an explicit empty:false and exit 0 are measured values.
    expect(byId.get('F1')).toMatchObject({ empty: false, exit_code: 0, failure_class: 'quota', wall_s: 20 });
    // Negative signal exits stay recorded; the camelCase alias joins too.
    expect(byId.get('F2')).toMatchObject({ empty: false, exit_code: -9, failure_class: 'authentication' });
    // Wrong types and out-of-shape labels are skipped, never coerced or recorded raw.
    expect(byId.get('F3')).toMatchObject({ empty: null, exit_code: null, failure_class: null });
    expect(byId.get('F4')).toMatchObject({ empty: null, exit_code: null, failure_class: null });
    expect(byId.get('F5')).toMatchObject({ exit_code: 3 });
  });

  it('reads the real folder and filters by lane', async () => {
    const root = runsDir([
      '{"job":"A1","lane":"alpha","phase":"MERGED"}',
      '{"job":"B1","lane":"beta","phase":"CLOSED"}',
      'junk',
    ].join('\n'));
    const all = await readRouterOutcomes({ runsDir: root });
    expect(all.state).toBe('read');
    expect(all.path).toBe(ledgerPath(root));
    expect(all.malformed_rows).toBe(1);
    expect(all.outcomes.map(o => o.job_id)).toEqual(['A1', 'B1']);

    const alpha = await readRouterOutcomes({ runsDir: root, lane: 'alpha' });
    expect(alpha.outcomes.map(o => o.job_id)).toEqual(['A1']);
    expect(alpha.state).toBe('read');
  });

  it('distinguishes a missing ledger from a readable empty one', async () => {
    const missing = await readRouterOutcomes({ runsDir: runsDir() });
    expect(missing).toMatchObject({ state: 'missing', outcomes: [], malformed_rows: 0 });

    const empty = await readRouterOutcomes({ runsDir: runsDir('') });
    expect(empty).toMatchObject({ state: 'read', outcomes: [], malformed_rows: 0 });
  });

  it('reports a directory at the ledger path as not-file, not as empty', async () => {
    const root = runsDir();
    mkdirSync(ledgerPath(root), { recursive: true }); // metrics/jobs.jsonl exists as a directory
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'not-file', outcomes: [] });
  });

  it('rejects a symlinked ledger and never follows it', async () => {
    const root = runsDir();
    const target = join(root, 'real.jsonl');
    writeFileSync(target, '{"job":"S1","phase":"MERGED"}\n');
    mkdirSync(join(root, 'metrics'));
    symlinkSync(target, ledgerPath(root));
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'unreadable', outcomes: [] });
  });

  it('reads the retained tail of an over-limit ledger instead of refusing it', async () => {
    const root = runsDir();
    mkdirSync(join(root, 'metrics'));
    writeFileSync(ledgerPath(root), '');
    truncateSync(ledgerPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1); // sparse; no 16 MiB write
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', truncated: true, outcomes: [] });
  });

  it('folds rows inside the retained tail and drops the cut first line', async () => {
    const root = runsDir();
    mkdirSync(join(root, 'metrics'));
    // One oversized first line fills the whole bound; only the rows after it
    // survive the tail window, and the cut line prefix is never parsed.
    const pad = 'x'.repeat(ROUTER_OUTCOME_LEDGER_LIMIT);
    writeFileSync(ledgerPath(root), `${pad}\n{"job":"T1","phase":"MERGED"}\n{"job":"T2","phase":"CLOSED"}\n`);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result.state).toBe('read');
    expect(result.truncated).toBe(true);
    expect(result.malformed_rows).toBe(0);
    expect(result.outcomes.map(o => o.job_id)).toEqual(['T1', 'T2']);
    expect(result.outcomes[0]).toMatchObject({ merged: true });
    expect(result.outcomes[1]).toMatchObject({ merged: false });
  });

  it('reports truncated=false when the ledger fits the bound', async () => {
    const root = runsDir('{"job":"S1","phase":"MERGED"}\n');
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', truncated: false });
    expect(result.outcomes.map(o => o.job_id)).toEqual(['S1']);
  });

  it('enforces the byte limit on the bounded reader itself', async () => {
    const root = runsDir('{"job":"L1"}\n{"job":"L2"}\n');
    expect(await readLedgerFile(ledgerPath(root), 4)).toEqual({ state: 'too-large' });
    expect(await readLedgerFile(ledgerPath(root), 1024)).toMatchObject({ state: 'read' });
  });

  it('tail-reads whole lines only and flags coverage honestly', async () => {
    const root = runsDir('aaaa\nbbbb\ncccc\n');
    // 15-byte file; a truncated window always drops its first line because it
    // may be a cut suffix — here 'bbbb' is dropped even though it looks whole.
    expect(await readLedgerTail(ledgerPath(root), 10)).toEqual({ state: 'read', text: 'cccc\n', truncated: true });
    // A window starting mid-line drops the partial 'bbbb' suffix the same way.
    expect(await readLedgerTail(ledgerPath(root), 9)).toEqual({ state: 'read', text: 'cccc\n', truncated: true });
    // File fits the bound: whole text, no truncation.
    expect(await readLedgerTail(ledgerPath(root), 15)).toEqual({ state: 'read', text: 'aaaa\nbbbb\ncccc\n', truncated: false });
    expect(await readLedgerTail(ledgerPath(root))).toMatchObject({ state: 'read', truncated: false });
  });

  it('tail reader yields empty text when the window holds no newline', async () => {
    const root = runsDir('x'.repeat(20)); // one unterminated line, no '\n'
    expect(await readLedgerTail(ledgerPath(root), 10)).toEqual({ state: 'read', text: '', truncated: true });
  });

  it('tail reader keeps the same file refusals as the whole-file reader', async () => {
    expect(await readLedgerTail(join(runsDir(), 'metrics', 'jobs.jsonl'))).toEqual({ state: 'missing' });
    const dirRoot = runsDir();
    mkdirSync(ledgerPath(dirRoot), { recursive: true });
    expect(await readLedgerTail(ledgerPath(dirRoot))).toEqual({ state: 'not-file' });
    const linkRoot = runsDir();
    const target = join(linkRoot, 'real.jsonl');
    writeFileSync(target, '{"job":"S1"}\n');
    mkdirSync(join(linkRoot, 'metrics'));
    symlinkSync(target, ledgerPath(linkRoot));
    expect(await readLedgerTail(ledgerPath(linkRoot))).toEqual({ state: 'unreadable' });
  });

  it('leaves fixtures byte-identical and unmodified by reads', async () => {
    const ledger = '{"job":"F1","phase":"MERGED","cost_usd":1}\nnoise\n';
    const root = runsDir(ledger);
    const before = statSync(ledgerPath(root));
    await readRouterOutcomes({ runsDir: root });
    await readRouterOutcomes({ runsDir: root, lane: 'x' });
    expect(readFileSync(ledgerPath(root), 'utf8')).toBe(ledger);
    const after = statSync(ledgerPath(root));
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('requires an absolute runs directory', async () => {
    await expect(readRouterOutcomes({ runsDir: 'relative/runs' })).rejects.toThrow(RangeError);
  });
});

describe('router outcome pass^k join', () => {
  it('fold resolves passk only through an exact lane+model match', () => {
    const fold = foldRouterOutcomes(
      [
        '{"job":"A","lane":"l1","model":"m1"}',
        '{"job":"B","lane":"l1"}',
        '{"job":"C","model":"m1"}',
        '{"job":"D","lane":"l2","model":"m2"}',
        '{"job":"E","lane":"l1","model":"m1"}',
      ].join('\n'),
      { passkFor: (lane, model) => (lane === 'l1' && model === 'm1' ? 0.5 : lane === 'l2' ? Number.NaN : null) },
    );
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('A')?.passk).toBe(0.5);
    expect(byId.get('E')?.passk).toBe(0.5);
    // Non-finite resolver output and unmatched pairs stay null, never fabricated.
    expect(byId.get('D')?.passk).toBeNull();
    expect(byId.get('B')?.passk).toBeNull();
    expect(byId.get('C')?.passk).toBeNull();
  });

  it('attaches the lane+model pass^k score from a healthy projection', async () => {
    const root = runsDir('{"job":"J1","lane":"devin","model":"swe-2","phase":"MERGED"}\n{"job":"J2","lane":"devin","model":"other","phase":"MERGED"}\n');
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlarDir(laneScores([scoreRow('devin', 'swe-2', 0.42)])) });
    expect(result.eval_state).toBe('healthy');
    expect(result.outcomes.find(o => o.job_id === 'J1')?.passk).toBe(0.42);
    expect(result.outcomes.find(o => o.job_id === 'J2')?.passk).toBeNull();
  });

  it('leaves passk null and reports eval_state when the projection is missing or degraded', async () => {
    const root = runsDir('{"job":"J1","lane":"devin","model":"swe-2"}\n');
    const missing = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlarDir() });
    expect(missing).toMatchObject({ state: 'read', eval_state: 'missing' });
    expect(missing.outcomes[0]?.passk).toBeNull();

    const degraded = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlarDir('{not json') });
    expect(degraded).toMatchObject({ state: 'read', eval_state: 'degraded' });
    expect(degraded.outcomes[0]?.passk).toBeNull();
  });

  it('refuses a duplicated lane+model pair but keeps unambiguous rows', async () => {
    const root = runsDir('{"job":"J1","lane":"devin","model":"swe-2"}\n{"job":"J2","lane":"claude","model":"opus"}\n');
    const evalRoot = ashlarDir(laneScores([scoreRow('devin', 'swe-2', 0.4), scoreRow('devin', 'swe-2', 0.9), scoreRow('claude', 'opus', 0.7)]));
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: evalRoot });
    expect(result.eval_state).toBe('healthy');
    expect(result.outcomes.find(o => o.job_id === 'J1')?.passk).toBeNull();
    expect(result.outcomes.find(o => o.job_id === 'J2')?.passk).toBe(0.7);
  });

  it('keeps passk null when the matched row has no pass^k value', async () => {
    const root = runsDir('{"job":"J1","lane":"devin","model":"swe-2"}\n');
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlarDir(laneScores([scoreRow('devin', 'swe-2', null)])) });
    expect(result.eval_state).toBe('healthy');
    expect(result.outcomes[0]?.passk).toBeNull();
  });

  it('requires an absolute ashlarDir when given', async () => {
    await expect(readRouterOutcomes({ runsDir: runsDir(''), ashlarDir: 'relative/ashlr' })).rejects.toThrow(RangeError);
  });
});

describe('router outcome spend join', () => {
  it('folds api-spend rows into per-job USD sums with the fleet spend contract', () => {
    const costs = foldSpendCosts([
      '{"ts":"2026-11-02T08:00:00Z","job":"J1","cost_usd":1.25}',
      '{"ts":"2026-11-02T09:00:00Z","job":"J1","model":"m","usd":0.5}',
      '{"timestamp":"2026-11-02T10:00:00Z","job_id":"J2","cost":0.25}',
      '{"ts":"2026-11-02T11:00:00Z","id":"J3","cost_usd":0}',
      '{"ts":"2026-11-02T12:00:00Z","job":"J4","cost_estimated":true,"cost_usd":0.75}',
      '{"ts":"2026-11-02T13:00:00Z","model":"m","cost_usd":9}',
      '{"ts":"2026-11-02T14:00:00Z","job":"J5"}',
      '{"ts":"2026-11-02T15:00:00Z","job":"J6","cost_usd":-1}',
      'not json',
      '[1,2]',
      '',
    ].join('\n'));
    expect(costs.get('J1')).toBeCloseTo(1.75);
    expect(costs.get('J2')).toBe(0.25);
    // A reported zero is evidence; estimated costs still report a USD figure.
    expect(costs.get('J3')).toBe(0);
    expect(costs.get('J4')).toBe(0.75);
    // No job id, no cost, invalid cost: never counted.
    expect(costs.has('J5')).toBe(false);
    expect(costs.has('J6')).toBe(false);
    expect(costs.size).toBe(4);
  });

  it('populates cost_usd from spend rows only where the jobs fold left it null', async () => {
    const root = runsDir([
      '{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","phase":"CLOSED","cost_usd":2,"ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J3","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J4","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    writeSpend(root, [
      '{"job":"J1","cost_usd":1.25}',
      '{"job":"J1","usd":0.5}',
      '{"job":"J2","cost_usd":9}',
      '{"job":"J3","model":"m"}',
      '{"job":"J-UNKNOWN","cost_usd":7}',
      '{"cost_usd":3}',
    ].join('\n'));
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result.state).toBe('read');
    expect(result.spend_state).toBe('read');
    expect(result.spend_truncated).toBe(false);
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    // Spend sum fills the null; the explicit ledger cost wins over spend.
    expect(byId.get('J1')?.cost_usd).toBeCloseTo(1.75);
    expect(byId.get('J2')?.cost_usd).toBe(2);
    // Calls with no reported cost stay unknown, never zero; spend rows for
    // jobs outside the jobs window never create outcomes.
    expect(byId.get('J3')?.cost_usd).toBeNull();
    expect(byId.get('J4')?.cost_usd).toBeNull();
    expect(result.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2', 'J3', 'J4']);
  });

  it('accepts usd/cost aliases on jobs rows as explicit cost evidence', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED","cost":0.4}\n{"job":"J2","phase":"MERGED","usd":0.6}\n');
    writeSpend(root, '{"job":"J1","cost_usd":5}\n');
    const result = await readRouterOutcomes({ runsDir: root });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.cost_usd).toBe(0.4);
    expect(byId.get('J2')?.cost_usd).toBe(0.6);
  });

  it('degrades the spend source independently of the jobs fold', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    // No api-spend.jsonl at all: spend_state reports missing, cost stays null.
    const missing = await readRouterOutcomes({ runsDir: root });
    expect(missing).toMatchObject({ state: 'read', spend_state: 'missing', spend_truncated: false });
    expect(missing.outcomes[0]?.cost_usd).toBeNull();

    // A symlinked spend ledger is refused like the jobs ledger.
    const target = join(root, 'real-spend.jsonl');
    writeFileSync(target, '{"job":"J1","cost_usd":1}\n');
    symlinkSync(target, spendPath(root));
    const linked = await readRouterOutcomes({ runsDir: root });
    expect(linked).toMatchObject({ state: 'read', spend_state: 'unreadable' });
    expect(linked.outcomes[0]?.cost_usd).toBeNull();
  });

  it('still reports spend health when the jobs ledger itself is missing', async () => {
    const root = runsDir();
    writeSpend(root, '{"job":"J1","cost_usd":1}\n');
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'missing', spend_state: 'read', spend_truncated: false, outcomes: [] });
  });

  it('flags a cut spend tail so joined costs read as lower bounds', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    writeSpend(root, '');
    // Sparse file past the bound: the retained window holds no whole line.
    truncateSync(spendPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', spend_state: 'read', spend_truncated: true });
    expect(result.outcomes[0]?.cost_usd).toBeNull();
  });
});

describe('router outcome work_class join', () => {
  it('folds route_decision rows to each job\'s latest recorded work_class', () => {
    const classes = foldRouteDecisionWorkClasses([
      JSON.stringify(decision('J1', 'bulk', 100)),
      JSON.stringify(decision('J1', 'judgment', 200)),   // newer decision wins
      JSON.stringify(decision('J1', 'standard', 150)),  // older than the newest: ignored
      JSON.stringify(decision('J2', 'standard', 100, { chosen_lane: null, reason_codes: ['no_runnable_lane'] })),
      JSON.stringify({ schema: 'work-market.v1', event: 'posture', ts: 300, lanes: {} }),
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'J3', ts: 100 }), // no work_class
      JSON.stringify(decision('J4', 'bad class!', 100)),
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'J5', work_class: 'bulk', ts: 'not-a-number' }),
      JSON.stringify(decision('J6', 'bulk', 100, { schema: 'other.v9' })),
      'not json',
      '',
    ].join('\n'));
    expect(classes.get('J1')).toBe('judgment');
    expect(classes.get('J2')).toBe('standard');
    expect(classes.has('J3')).toBe(false);
    expect(classes.has('J4')).toBe(false);
    expect(classes.has('J5')).toBe(false);
    expect(classes.has('J6')).toBe(false);
    expect(classes.size).toBe(2);
  });

  it('fills work_class from route decisions only where jobs rows recorded none', async () => {
    const root = runsDir([
      '{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","lane":"beta","phase":"CLOSED","work_class":"docs","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J3","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    writeMarket(root, [
      decision('J1', 'bulk', 100),
      decision('J2', 'bulk', 100),   // explicit jobs-row class wins over the market join
      decision('J3', 'judgment', 100),
      decision('J-UNDECIDED', 'bulk', 100), // no jobs outcome: never creates one
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', market_state: 'read', market_truncated: false });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.work_class).toBe('bulk');
    expect(byId.get('J2')?.work_class).toBe('docs');
    expect(byId.get('J3')?.work_class).toBe('judgment');
    expect(result.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2', 'J3']);
  });

  it('keeps work_class null and reports market_state when the market ledger is absent or refused', async () => {
    const missing = await readRouterOutcomes({ runsDir: runsDir('{"job":"J1","phase":"MERGED"}\n') });
    expect(missing).toMatchObject({ state: 'read', market_state: 'missing', market_truncated: false });
    expect(missing.outcomes[0]?.work_class).toBeNull();

    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    const target = join(root, 'real-market.jsonl');
    writeFileSync(target, JSON.stringify(decision('J1', 'bulk', 100)) + '\n');
    symlinkSync(target, marketPath(root));
    const linked = await readRouterOutcomes({ runsDir: root });
    expect(linked).toMatchObject({ state: 'read', market_state: 'unreadable' });
    expect(linked.outcomes[0]?.work_class).toBeNull();
  });

  it('still reports market health when the jobs ledger itself is missing', async () => {
    const root = runsDir();
    writeMarket(root, [decision('J1', 'bulk', 100)]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'missing', market_state: 'read', market_truncated: false, outcomes: [] });
  });

  it('flags a cut market tail so joined classes read as newest-bytes coverage', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    writeFileSync(marketPath(root), '');
    truncateSync(marketPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', market_state: 'read', market_truncated: true });
    expect(result.outcomes[0]?.work_class).toBeNull();
  });
});

describe('router outcome authority revert join', () => {
  /** Evidence rows in the authority ledger's index shape (structural subset). */
  const ev = (kind: string, landingId: string | null, revertsLandingId?: string | null): RouterOutcomeEvidenceRow =>
    revertsLandingId === undefined ? { kind, landingId } : { kind, landingId, revertsLandingId };

  const MERGE = 'ashlrai/phantom#42@abc123def456';
  const REVERT = 'ashlrai/phantom#43@fff000aaa111';

  it('resolves a revert:landed row to its merge landing\'s PR key', () => {
    const keys = authorityRevertedPrKeys([
      ev('merge:landed', MERGE),
      ev('merge:landed', 'ashlrai/phantom#7@000000000000'),
      ev('revert:landed', REVERT, MERGE),
      ev('post-merge:result', MERGE, null),
      ev('revert:failed', 'ashlrai/phantom#9@111111111111', null),
    ]);
    expect([...keys]).toEqual(['ashlrai/phantom#42']);
  });

  it('ignores malformed landing ids, missing targets and reverts of non-merge landings', () => {
    const keys = authorityRevertedPrKeys([
      ev('merge:landed', 'not-a-landing-id'),
      ev('merge:landed', null),
      ev('merge:landed', 'ashlrai/phantom#42'),        // no @sha suffix: unparseable
      ev('revert:landed', REVERT),                       // no revertsLandingId
      ev('revert:landed', REVERT, null),                 // explicit null target
      ev('revert:landed', REVERT, 'ashlrai/phantom#99@deadbeef0000'), // targets no merge row
      ev('revert:landed', REVERT, 'unparseable'),        // target never entered the merge map
      ev('post-merge:result', MERGE, MERGE),             // wrong kind carrying a target
    ]);
    expect(keys.size).toBe(0);
  });

  it('marks a job reverted through its unambiguous canonical PR claim only', () => {
    const keys = authorityRevertedPrKeys([ev('merge:landed', MERGE), ev('revert:landed', REVERT, MERGE)]);
    const fold = foldRouterOutcomes([
      '{"job":"J1","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/7"}',
      '{"job":"J3","phase":"MERGED","pr_url":"https://github.com/other/repo/pull/42"}',
      '{"job":"J4","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42/"}',
      '{"job":"J5","phase":"MERGED","url":"https://github.com/AshlrAI/Phantom/pull/42"}',
      '{"job":"J6","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42?x=1"}',
      '{"job":"J7","phase":"MERGED","pr":"https://github.com/ashlrai/phantom/issues/42"}',
    ].join('\n'), { revertedPrKeys: keys });
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // Canonical claim (any url alias) + case-insensitive repo: marked.
    expect(byId.get('J1')?.reverted).toBe(true);
    expect(byId.get('J4')?.reverted).toBe(true);
    expect(byId.get('J5')?.reverted).toBe(true);
    // Different PR, different repo, non-canonical or non-pull URL: untouched.
    for (const id of ['J2', 'J3', 'J6', 'J7']) expect(byId.get(id)?.reverted).toBeNull();
  });

  it('never marks through an ambiguous PR claim or a foreign row', () => {
    const keys = authorityRevertedPrKeys([ev('merge:landed', MERGE), ev('revert:landed', REVERT, MERGE)]);
    const fold = foldRouterOutcomes([
      '{"job":"A","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}',
      '{"job":"B","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}',
      '{"job":"C","phase":"MERGED"}',
      '{"job":"C","pr_url":"https://github.com/ashlrai/phantom/pull/42"}', // third claimant of the same URL
      '{"job":"D","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/43"}',
      '{"job":"D","pr_url":"https://github.com/ashlrai/phantom/pull/42"}',  // fourth claimant on a foreign row
    ].join('\n'), { revertedPrKeys: keys });
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // Four jobs claim pull/42, so none is marked — contested evidence stays unknown.
    for (const id of ['A', 'B', 'C', 'D']) expect(byId.get(id)?.reverted).toBeNull();
    expect(fold.ambiguous_urls).toBe(1);
  });

  it('authority revert evidence is sticky-true over reverted:false', () => {
    const keys = authorityRevertedPrKeys([
      ev('merge:landed', MERGE), ev('revert:landed', REVERT, MERGE),
      ev('merge:landed', 'ashlrai/phantom#7@000000000000'),
      ev('revert:landed', 'ashlrai/phantom#8@111111111111', 'ashlrai/phantom#7@000000000000'),
    ]);
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}',
      '{"job":"J1","reverted":false,"ts":"2026-11-03T00:00:00Z"}',
      '{"job":"J2","phase":"MERGED","reverted":false,"pr_url":"https://github.com/ashlrai/phantom/pull/7"}',
    ].join('\n'), { revertedPrKeys: keys });
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // A later reverted:false cannot undo the verified revert.
    expect(byId.get('J1')?.reverted).toBe(true);
    // Same row carries explicit false and the reverted claim: verified evidence wins.
    expect(byId.get('J2')?.reverted).toBe(true);
  });

  it('leaves reverted untouched when no join is supplied or the PR was never reverted', () => {
    const text = '{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}\n';
    // No option: pure jobs-ledger fold, reverted stays unknown.
    expect(foldRouterOutcomes(text).outcomes[0]?.reverted).toBeNull();
    // Empty key set: the join ran but found nothing.
    expect(foldRouterOutcomes(text, { revertedPrKeys: new Set() }).outcomes[0]?.reverted).toBeNull();
    // A different PR's revert does not leak onto this job.
    const other = authorityRevertedPrKeys([ev('merge:landed', 'ashlrai/phantom#7@000000000000'), ev('revert:landed', 'ashlrai/phantom#8@111111111111', 'ashlrai/phantom#7@000000000000')]);
    expect(foldRouterOutcomes(text, { revertedPrKeys: other }).outcomes[0]?.reverted).toBeNull();
  });

  it('readRouterOutcomes joins injected authority evidence and honours null', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}\n{"job":"J2","phase":"MERGED"}\n');
    const evidence = [ev('merge:landed', MERGE), ev('revert:landed', REVERT, MERGE)];
    const joined = await readRouterOutcomes({ runsDir: root, authorityEvidence: evidence });
    const byId = new Map(joined.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.reverted).toBe(true);
    expect(byId.get('J2')?.reverted).toBeNull();

    // null skips the join entirely: same ledger, no authority mark.
    const skipped = await readRouterOutcomes({ runsDir: root, authorityEvidence: null });
    expect(skipped.outcomes.find(o => o.job_id === 'J1')?.reverted).toBeNull();
  });
});
