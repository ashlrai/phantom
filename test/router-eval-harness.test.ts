/**
 * RQ-SELFOPT-EVAL-HARNESS: the offline router-eval regression benchmark.
 *
 * Reruns the `logged` policy over the frozen router day in
 * benchmarks/router-eval/jobs.jsonl and requires the committed baseline.json
 * to reproduce exactly — this suite is what carries the harness into the
 * daily master run. Challenger policies pin the counterfactual/unobserved
 * honesty rules; malformed-input and CLI tests guard the seams.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_ROUTER_POLICIES,
  builtinRouterPolicy,
  evaluateRouterPolicy,
  formatRouterEvalMarkdown,
  parseRouterEvalDataset,
  wilsonInterval,
  type RouterEvalReport,
  type RouterPolicy,
} from '../src/core/eval/router-eval.js';
import { cmdEvalRouter } from '../src/cli/eval-router.js';

const DIR = fileURLToPath(new URL('../benchmarks/router-eval/', import.meta.url));
const JOBS = readFileSync(`${DIR}jobs.jsonl`, 'utf8');
const BASELINE = JSON.parse(readFileSync(`${DIR}baseline.json`, 'utf8')) as RouterEvalReport;

function evaluate(policy: string) {
  const ds = parseRouterEvalDataset(JOBS);
  return evaluateRouterPolicy(ds, builtinRouterPolicy(policy, ds.jobs)!);
}

describe('frozen router-eval dataset', () => {
  it('parses the committed day: 1 meta line, 45 validated job lines', () => {
    const ds = parseRouterEvalDataset(JOBS);
    expect(ds.jobs).toHaveLength(45);
    expect(ds.meta.id).toBe('router-eval-2026-10-26');
    expect(Object.keys(ds.meta.arms ?? {})).toHaveLength(6);
    expect(ds.jobs.filter((j) => j.outcome === 'held')).toHaveLength(2);
    expect(ds.jobs.filter((j) => j.outcome === 'pending')).toHaveLength(1);
    expect(ds.jobs.filter((j) => j.arms !== undefined)).toHaveLength(13);
  });

  it.each([
    ['duplicate job id', (l: object) => `${JSON.stringify(l)}\n${JSON.stringify(l)}`],
    ['unknown outcome', (l: object) => JSON.stringify({ ...l, outcome: 'shipped' })],
    ['held with a chosen arm', (l: object) => JSON.stringify({ ...l, outcome: 'held' })],
    ['chosen outside candidates', (l: object) => JSON.stringify({ ...l, chosen: 'elsewhere' })],
    ['arm entry outside candidates', (l: object) => JSON.stringify({ ...l, arms: { elsewhere: { outcome: 'merged' } } })],
    ['counterfactual contradicting the record', (l: object) => JSON.stringify({ ...l, arms: { 'local-qwen': { outcome: 'merged' }, 'codex-cmp': { outcome: 'closed' } } })],
    ['non-terminal counterfactual', (l: object) => JSON.stringify({ ...l, arms: { 'local-qwen': { outcome: 'held' }, 'codex-cmp': { outcome: 'merged' } } })],
    ['negative cost', (l: object) => JSON.stringify({ ...l, costUsd: -1 })],
    ['fractional tokens', (l: object) => JSON.stringify({ ...l, tokens: 1.5 })],
    ['duplicate meta line', (l: object) => `{"v":1,"kind":"meta","id":"a"}\n{"v":1,"kind":"meta","id":"b"}\n${JSON.stringify(l)}`],
    ['meta after jobs', (l: object) => `${JSON.stringify(l)}\n{"v":1,"kind":"meta","id":"late"}`],
    ['unsupported version', (l: object) => JSON.stringify({ ...l, v: 2 })],
  ])('rejects %s', (_name, mutate) => {
    const line = { v: 1, id: 'J1', pool: 'local-qwen', candidates: ['local-qwen', 'codex-cmp'], chosen: 'local-qwen', outcome: 'closed', costUsd: 0 };
    expect(() => parseRouterEvalDataset(mutate(line))).toThrowError(/jobs\.jsonl:\d+:/);
  });

  it('rejects a counterfactual metric that disagrees with the record', () => {
    const line = { v: 1, id: 'J1', candidates: ['a', 'b'], chosen: 'a', outcome: 'merged', costUsd: 2, arms: { a: { outcome: 'merged', costUsd: 3 } } };
    expect(() => parseRouterEvalDataset(JSON.stringify(line))).toThrow('contradicts');
  });
});

describe('logged policy — the committed baseline', () => {
  it('reproduces benchmarks/router-eval/baseline.json exactly', () => {
    const ds = parseRouterEvalDataset(JOBS);
    const report = evaluateRouterPolicy(ds, builtinRouterPolicy('logged', ds.jobs)!, { includeDecisions: true });
    expect(report).toEqual(BASELINE);
  });

  it('reports the headline metrics with intervals over the resolved cohort', () => {
    const report = evaluate('logged');
    expect(report.coverage).toEqual({ jobs: 45, changed: 0, rejected: 0, observed: 42, unobserved: 0, held: 2, pending: 1, resolved: 42 });
    expect(report.mergeRate).toEqual({ value: 29 / 42, ci95: wilsonInterval(29, 42), n: 42 });
    expect(report.mergeRate.ci95![0]).toBeLessThan(report.mergeRate.value!);
    expect(report.mergeRate.ci95![1]).toBeGreaterThan(report.mergeRate.value!);
    expect(report.costPerMergedPrUsd.value).toBeCloseTo(2.55, 2);
    expect(report.wallTimeMsMean.value).toBeCloseTo(3_060_000, -5);
    expect(report.perArm.map((a) => a.arm)).toEqual(['codex-cmp', 'codex-personal', 'devin', 'local-qwen', 'prompt:adaptive']);
  });

  it('is deterministic across replays (seeded bootstrap, no clock)', () => {
    expect(evaluate('logged')).toEqual(evaluate('logged'));
    expect(formatRouterEvalMarkdown(evaluate('logged'))).toContain('Merge rate | 69.0%');
  });
});

describe('challenger policies', () => {
  it('strict-pool overrides the router: counterfactual where frozen, unobserved elsewhere', () => {
    const report = evaluate('strict-pool');
    expect(report.coverage).toEqual({ jobs: 45, changed: 7, rejected: 0, observed: 38, unobserved: 6, held: 0, pending: 1, resolved: 38 });
    const ds = parseRouterEvalDataset(JOBS);
    const withDecisions = evaluateRouterPolicy(ds, builtinRouterPolicy('strict-pool', ds.jobs)!, { includeDecisions: true });
    expect(withDecisions.decisions!.filter((d) => d.resolution === 'counterfactual').map((d) => d.id)).toEqual(['RQ-006']);
    expect(withDecisions.decisions!.filter((d) => d.resolution === 'unobserved').map((d) => d.id))
      .toEqual(['RQ-015', 'RQ-023', 'RQ-041', 'RQ-042', 'RQ-043', 'RQ-044']);
  });

  it('cheapest pays less per merged PR on the frozen counterfactual surface', () => {
    const report = evaluate('cheapest');
    expect(report.coverage).toEqual({ jobs: 45, changed: 24, rejected: 0, observed: 30, unobserved: 15, held: 0, pending: 0, resolved: 30 });
    // Prompt arms are replayable too: both bake-offs land on prompt:plain.
    const ds = parseRouterEvalDataset(JOBS);
    const withDecisions = evaluateRouterPolicy(ds, builtinRouterPolicy('cheapest', ds.jobs)!, { includeDecisions: true });
    const prompts = withDecisions.decisions!.filter((d) => d.id === 'RQ-041' || d.id === 'RQ-042');
    expect(prompts.map((d) => d.replayed)).toEqual(['prompt:plain', 'prompt:plain']);
    expect(report.costPerMergedPrUsd.value!).toBeLessThan(BASELINE.costPerMergedPrUsd.value!);
    expect(report.costPerMergedPrUsd.value!).toBeCloseTo(2.139, 3);
  });

  it('hold-all observes nothing and reports nulls, never fabricated zeros', () => {
    const report = evaluate('hold-all');
    expect(report.coverage.observed).toBe(0);
    expect(report.mergeRate.value).toBeNull();
    expect(report.costPerMergedPrUsd.value).toBeNull();
    expect(report.wallTimeMsMean.value).toBeNull();
  });

  it('rejects a policy decision outside the recorded candidates', () => {
    const rogue: RouterPolicy = { name: 'rogue', decide: () => ({ arm: 'not-a-candidate' }) };
    const report = evaluateRouterPolicy(parseRouterEvalDataset(JOBS), rogue);
    expect(report.coverage.rejected).toBe(45);
    expect(report.coverage.observed).toBe(0);
  });

  it('runs an arbitrary caller policy through the same seam', () => {
    const onlyLocal: RouterPolicy = {
      name: 'only-local',
      decide: (job, catalog) => {
        const local = job.candidates.find((arm) => catalog[arm]?.tier === 'local');
        return local ? { arm: local } : { arm: null, reason: 'no local seat' };
      },
    };
    const ds = parseRouterEvalDataset(JOBS);
    const report = evaluateRouterPolicy(ds, onlyLocal, { includeDecisions: true });
    expect(report.decisions!.filter((d) => d.replayed === 'local-qwen'))
      .toHaveLength(ds.jobs.filter((j) => j.candidates.includes('local-qwen')).length);
    expect(report.coverage.rejected).toBe(0);
    expect(report.decisions!.filter((d) => d.reason === 'no local seat').length).toBeGreaterThan(0);
  });
});

describe('confidence intervals', () => {
  it('Wilson bounds degenerate cohorts and stay inside [0, 1]', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    const [lo, hi] = wilsonInterval(0, 10)!;
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(wilsonInterval(42, 42)![1]).toBeCloseTo(1, 12);
  });

  it('bootstrap CIs bracket the point estimate and honor a degenerate ratio', () => {
    const report = evaluate('logged');
    for (const key of ['costPerMergedPrUsd', 'tokensPerMergedPr', 'wallTimeMsMean'] as const) {
      const m = report[key];
      expect(m.ci95![0]).toBeLessThanOrEqual(m.value!);
      expect(m.ci95![1]).toBeGreaterThanOrEqual(m.value!);
      expect(m.n).toBeGreaterThan(0);
    }
    // A cohort of one cannot support a bootstrap interval.
    const single = parseRouterEvalDataset(JSON.stringify({ v: 1, id: 'J1', candidates: ['a'], chosen: 'a', outcome: 'merged', costUsd: 1, wallTimeMs: 1000 }));
    const r = evaluateRouterPolicy(single, builtinRouterPolicy('logged', single.jobs)!);
    expect(r.wallTimeMsMean.ci95).toBeNull();
    expect(r.costPerMergedPrUsd.ci95).toBeNull();
  });
});

describe('phm eval router CLI', () => {
  function harness() {
    const writes = new Map<string, string>();
    const outs: string[] = [];
    const errs: string[] = [];
    const deps = {
      readFile: (path: string) => readFileSync(path, 'utf8'),
      writeFile: (path: string, text: string) => { writes.set(path, text); },
      out: (t: string) => outs.push(t),
      err: (t: string) => errs.push(t),
    };
    return { writes, outs, errs, deps };
  }

  it('--check reproduces the committed baseline (the daily gate)', async () => {
    const h = harness();
    expect(await cmdEvalRouter(['--dataset', `${DIR}jobs.jsonl`, '--decisions', '--check', `${DIR}baseline.json`], h.deps)).toBe(0);
    expect(h.outs[0]).toContain("policy 'logged' reproduces the baseline");
    expect(h.errs).toEqual([]);
  });

  it('--check exits 1 and names the drift on a tampered baseline', async () => {
    const h = harness();
    const tampered = { ...BASELINE, mergeRate: { ...BASELINE.mergeRate, value: 0.5 } };
    const readFile = (path: string) => path.endsWith('baseline.json') ? JSON.stringify(tampered) : readFileSync(path, 'utf8');
    expect(await cmdEvalRouter(['--dataset', `${DIR}jobs.jsonl`, '--check', 'baseline.json'], { ...h.deps, readFile })).toBe(1);
    expect(h.errs[0]).toContain('router-eval regression');
    expect(h.errs[0]).toContain('mergeRate');
    const h2 = harness();
    const readGarbage = (path: string) => path.endsWith('baseline.json') ? '{"not":"a report"}' : readFileSync(path, 'utf8');
    expect(await cmdEvalRouter(['--dataset', `${DIR}jobs.jsonl`, '--check', 'baseline.json'], { ...h2.deps, readFile: readGarbage })).toBe(1);
    expect(h2.errs[0]).toContain('router-eval regression');
  });

  it('prints markdown by default, JSON with --json, and honors --write', async () => {
    const h = harness();
    expect(await cmdEvalRouter(['--dataset', `${DIR}jobs.jsonl`, '--write', 'out.json'], h.deps)).toBe(0);
    expect(h.outs[0]).toContain('# Router eval report');
    expect(JSON.parse(h.writes.get('out.json')!).policy).toBe('logged');
    const h2 = harness();
    expect(await cmdEvalRouter(['--dataset', `${DIR}jobs.jsonl`, '--policy', 'cheapest', '--json'], h2.deps)).toBe(0);
    expect(JSON.parse(h2.outs[0]).policy).toBe('cheapest');
  });

  it('lists policies, rejects unknown ones and validates usage', async () => {
    const h = harness();
    expect(await cmdEvalRouter(['--policy', 'list'], h.deps)).toBe(0);
    expect(h.outs[0]).toBe(BUILTIN_ROUTER_POLICIES.join('\n'));
    expect(await cmdEvalRouter([], h.deps)).toBe(2);
    expect(await cmdEvalRouter(['--dataset', `${DIR}jobs.jsonl`, '--policy', 'nope'], h.deps)).toBe(2);
    expect(await cmdEvalRouter(['--dataset'], h.deps)).toBe(2);
    expect(await cmdEvalRouter(['--dataset', `${DIR}jobs.jsonl`, '--dataset', 'x'], h.deps)).toBe(2);
    expect(await cmdEvalRouter(['--help'], h.deps)).toBe(0);
    expect(await cmdEvalRouter(['--dataset', `${DIR}jobs.jsonl`, '--bogus'], h.deps)).toBe(2);
  });

  it('fails closed on an unreadable dataset and a missing baseline', async () => {
    const h = harness();
    const readFile = () => { throw new Error('nope'); };
    expect(await cmdEvalRouter(['--dataset', 'x.jsonl'], { ...h.deps, readFile })).toBe(1);
    expect(h.errs[0]).toContain('could not read or parse');
    const h2 = harness();
    const readDatasetOnly = (path: string) => { if (path === 'missing.json') throw new Error('nope'); return readFileSync(path, 'utf8'); };
    expect(await cmdEvalRouter(['--dataset', `${DIR}jobs.jsonl`, '--check', 'missing.json'], { ...h2.deps, readFile: readDatasetOnly })).toBe(1);
    expect(h2.errs[0]).toContain('could not read the baseline');
  });
});
