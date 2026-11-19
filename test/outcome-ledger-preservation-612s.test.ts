import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  foldRouterOutcomes,
  readLedgerFile,
  readRouterOutcomes,
  ROUTER_OUTCOME_LEDGER_LIMIT,
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
      merged: null, ci_first_pass: null, review_findings: null, cost_usd: null, wall_s: null, passk: null,
    }]);
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

  it('refuses over-limit input without parsing a truncated prefix', async () => {
    const root = runsDir();
    mkdirSync(join(root, 'metrics'));
    writeFileSync(ledgerPath(root), '');
    truncateSync(ledgerPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1); // sparse; no 16 MiB write
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'too-large', outcomes: [] });
  });

  it('enforces the byte limit on the bounded reader itself', async () => {
    const root = runsDir('{"job":"L1"}\n{"job":"L2"}\n');
    expect(await readLedgerFile(ledgerPath(root), 4)).toEqual({ state: 'too-large' });
    expect(await readLedgerFile(ledgerPath(root), 1024)).toMatchObject({ state: 'read' });
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
