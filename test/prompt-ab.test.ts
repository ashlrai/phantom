/**
 * RQ-SELFOPT-PROMPT-OPT: prompt-variant A/B engine, promotion gate, registry
 * store, CLI and pulse-dashboard tests.
 *
 * The committed benchmark (benchmarks/prompt-ab/) is the anchor: `docs` is
 * the promoted class (adaptive wins with disjoint Wilson intervals), `tests`
 * is held on significance, `secrets` on data. Synthetic inline datasets pin
 * the gate's other verdicts; the store and pulse section use temp dirs and
 * module mocks — nothing touches the real home directory.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseRouterEvalDataset, type RouterEvalDataset } from '../src/core/eval/router-eval.js';
import {
  evaluatePromptExperiment,
  formatPromptAbMarkdown,
  promotionsRegistry,
} from '../src/core/eval/prompt-ab.js';
import {
  loadPromptPromotions,
  mergePromotions,
  promptPromotionsPath,
  savePromptPromotions,
  type PromptPromotionsRegistry,
} from '../src/core/eval/prompt-promotions.js';
import {
  assignPromptVariant,
  classifyPromptJob,
  parsePromptExperimentSpec,
  promptVariant,
  renderPrompt,
  type PromptExperimentSpec,
} from '../src/core/eval/prompt-variants.js';
import { cmdEvalPrompts } from '../src/cli/eval-prompts.js';

const BENCH_DIR = fileURLToPath(new URL('../benchmarks/prompt-ab/', import.meta.url));
const JOBS = readFileSync(join(BENCH_DIR, 'jobs.jsonl'), 'utf8');
const SPEC = JSON.parse(readFileSync(join(BENCH_DIR, 'experiment.json'), 'utf8')) as PromptExperimentSpec;
const COMMITTED_PROMOTIONS = JSON.parse(readFileSync(join(BENCH_DIR, 'promotions.json'), 'utf8')) as PromptPromotionsRegistry;

const dataset = () => parseRouterEvalDataset(JOBS);
const spec = () => parsePromptExperimentSpec(SPEC);
const view = (over: Partial<import('../src/core/eval/router-eval.js').PolicyJobView> = {}): import('../src/core/eval/router-eval.js').PolicyJobView =>
  ({ id: 'J1', task: 'docs link audit', candidates: [], ...over });

// ---------------------------------------------------------------------------
// Experiment spec parsing
// ---------------------------------------------------------------------------

describe('parsePromptExperimentSpec', () => {
  it('accepts the committed spec', () => {
    const s = spec();
    expect(s.id).toBe('prompt-ab-2026-10-28');
    expect(s.classes.map((c) => c.id)).toEqual(['docs', 'tests', 'secrets']);
  });

  it.each([
    ['non-object', 42],
    ['unsupported version', { v: 2, id: 'x', classes: [{ id: 'c', control: 'a', challengers: ['b'] }] }],
    ['missing id', { v: 1, classes: [{ id: 'c', control: 'a', challengers: ['b'] }] }],
    ['empty classes', { v: 1, id: 'x', classes: [] }],
    ['class without id', { v: 1, id: 'x', classes: [{ control: 'a', challengers: ['b'] }] }],
    ['class without control', { v: 1, id: 'x', classes: [{ id: 'c', challengers: ['b'] }] }],
    ['class without challengers', { v: 1, id: 'x', classes: [{ id: 'c', control: 'a', challengers: [] }] }],
    ['control listed as challenger', { v: 1, id: 'x', classes: [{ id: 'c', control: 'a', challengers: ['a'] }] }],
    ['duplicate class id', { v: 1, id: 'x', classes: [{ id: 'c', control: 'a', challengers: ['b'] }, { id: 'c', control: 'a', challengers: ['b'] }] }],
    ['bad task regex', { v: 1, id: 'x', classes: [{ id: 'c', match: { task: '([' }, control: 'a', challengers: ['b'] }] }],
    ['bad gate value', { v: 1, id: 'x', classes: [{ id: 'c', control: 'a', challengers: ['b'] }], gate: { minResolvedPerArm: -1 } }],
  ])('rejects %s', (_name, value) => {
    expect(() => parsePromptExperimentSpec(value)).toThrowError(/prompt-ab spec/);
  });
});

describe('classifyPromptJob', () => {
  it('matches by case-insensitive task regex', () => {
    expect(classifyPromptJob(view({ task: 'DOCS Link Audit' }), spec())).toBe('docs');
    expect(classifyPromptJob(view({ task: 'ci shard rebalance' }), spec())).toBe('tests');
    expect(classifyPromptJob(view({ task: 'secrets shape lint' }), spec())).toBe('secrets');
  });

  it('returns null for unmatched jobs and honors first-match precedence', () => {
    expect(classifyPromptJob(view({ task: 'fleet pause' }), spec())).toBeNull();
    const s = parsePromptExperimentSpec({
      v: 1, id: 'x', classes: [
        { id: 'first', match: { task: 'docs' }, control: 'a', challengers: ['b'] },
        { id: 'second', match: { task: 'docs|audit' }, control: 'a', challengers: ['b'] },
      ],
    });
    expect(classifyPromptJob(view({ task: 'docs audit' }), s)).toBe('first');
  });

  it('honors match.task on a spec object that never passed through the parser', () => {
    // Regression: the builtin experiment constant once shipped without compiled
    // taskRe, so every job silently classified into the first class.
    const raw = JSON.parse(JSON.stringify(SPEC)) as PromptExperimentSpec;
    expect(classifyPromptJob(view({ task: 'secrets rotation' }), raw)).toBe('secrets');
    expect(classifyPromptJob(view({ task: 'unrelated chore' }), raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Prompt variants and live assignment
// ---------------------------------------------------------------------------

describe('prompt variants', () => {
  it('renders the plain control as the bare task line', () => {
    const job = view({ task: 'fix the flake' });
    expect(renderPrompt('prompt:plain', job)).toBe('fix the flake');
  });

  it('renders the adaptive challenger with context and an acceptance contract', () => {
    const out = renderPrompt('prompt:adaptive', view({ task: 'fix the flake', repo: 'phantom', tier: 'standard', priority: 'P1' }));
    expect(out).toContain('fix the flake');
    expect(out).toContain('repo phantom');
    expect(out).toContain('Acceptance:');
    expect(out).toContain('Verify before reporting done');
  });

  it('rejects an unknown variant arm', () => {
    expect(() => renderPrompt('prompt:nope', view())).toThrowError(/unknown prompt variant/);
    expect(promptVariant('prompt:nope')).toBeUndefined();
  });
});

describe('assignPromptVariant', () => {
  it('is deterministic per job id and spreads across the experiment arms', () => {
    const jobs = Array.from({ length: 40 }, (_, i) => view({ id: `J-${i}`, task: 'docs audit' }));
    const arms = jobs.map((j) => assignPromptVariant(j, spec()).arm);
    expect(new Set(arms)).toEqual(new Set(['prompt:plain', 'prompt:adaptive']));
    for (const j of jobs) {
      expect(assignPromptVariant(j, spec()).arm).toBe(assignPromptVariant(j, spec()).arm);
    }
  });

  it('routes a promoted class to its winner', () => {
    const registry: PromptPromotionsRegistry = {
      schemaVersion: 1, generatedAt: 'x', experimentId: 'e', dataset: { sha256: 's', jobs: 0 },
      classes: ['docs'],
      promoted: [{
        classId: 'docs', experimentId: 'e', variant: 'prompt:adaptive', control: 'prompt:plain',
        before: { value: 0.3, ci95: [0.1, 0.5], n: 30 }, after: { value: 0.8, ci95: [0.6, 0.9], n: 27 },
        liftPoints: 0.5, costPerMergedPrBefore: 1.7, costPerMergedPrAfter: 1.1,
        decidedAt: 'x', datasetSha256: 's',
      }],
      held: [],
    };
    const a = assignPromptVariant(view({ task: 'docs audit' }), spec(), registry);
    expect(a).toMatchObject({ arm: 'prompt:adaptive', classId: 'docs', mode: 'promoted' });
  });

  it('returns arm=null outside every class', () => {
    expect(assignPromptVariant(view({ task: 'unmatched work' }), spec())).toMatchObject({ arm: null, classId: null, mode: 'none' });
  });
});

// ---------------------------------------------------------------------------
// The committed benchmark — one promoted variant with before/after numbers
// ---------------------------------------------------------------------------

describe('frozen prompt-A/B benchmark', () => {
  const report = evaluatePromptExperiment(dataset(), spec(), { now: '2026-10-28T00:00:00.000Z' });

  it('parses 65 lines into the declared classes', () => {
    expect(report.classes.map((c) => [c.classId, c.jobs])).toEqual([['docs', 31], ['tests', 27], ['secrets', 7]]);
  });

  it('promotes prompt:adaptive for docs on a significant lift', () => {
    const docs = report.classes.find((c) => c.classId === 'docs')!;
    expect(docs.winner).toBe('prompt:adaptive');
    const challenger = docs.challengers[0]!;
    expect(challenger.verdict).toBe('promoted');
    // Before/after numbers: 33.3% -> 77.8% merge rate, disjoint intervals.
    expect(docs.control.mergeRate.value).toBeCloseTo(1 / 3, 4);
    expect(challenger.eval.mergeRate.value).toBeCloseTo(21 / 27, 4);
    expect(challenger.liftPoints).toBeCloseTo(21 / 27 - 1 / 3, 4);
    expect(challenger.eval.mergeRate.ci95![0]).toBeGreaterThan(docs.control.mergeRate.ci95![1]);
  });

  it('holds tests (not significant) and secrets (insufficient data)', () => {
    const tests = report.classes.find((c) => c.classId === 'tests')!;
    expect(tests.winner).toBeNull();
    expect(tests.challengers[0]!.verdict).toBe('not-significant');
    const secrets = report.classes.find((c) => c.classId === 'secrets')!;
    expect(secrets.challengers[0]!.verdict).toBe('insufficient-data');
  });

  it('reproduces the committed promotions registry exactly (verdicts and numbers)', () => {
    const decidedAt = COMMITTED_PROMOTIONS.promoted[0]!.decidedAt;
    const registry = promotionsRegistry(evaluatePromptExperiment(dataset(), spec(), { now: decidedAt }));
    expect(registry.promoted).toHaveLength(1);
    expect(registry.promoted[0]).toMatchObject(COMMITTED_PROMOTIONS.promoted[0]!);
    expect(registry.held).toEqual(COMMITTED_PROMOTIONS.held);
    expect(registry.classes).toEqual(COMMITTED_PROMOTIONS.classes);
  });

  it('renders the before/after dashboard table', () => {
    const md = formatPromptAbMarkdown(report);
    expect(md).toContain('## docs — promoted `prompt:adaptive`');
    expect(md).toContain('| docs | prompt:adaptive | 33.3% (n=30) | 77.8% (n=27) | +44.4 pts |');
    expect(md).toContain('held — not significant');
    expect(md).toContain('held — insufficient data');
  });
});

// ---------------------------------------------------------------------------
// Gate verdicts on synthetic cohorts
// ---------------------------------------------------------------------------

function line(id: string, task: string, chosen: string | null, outcome: string, arms?: Record<string, { outcome: string; costUsd?: number }>) {
  return JSON.stringify({
    v: 1, id, task, candidates: ['prompt:plain', 'prompt:adaptive'], chosen, outcome,
    costUsd: chosen === 'prompt:plain' ? 0.5 : 0.9,
    ...(arms ? { arms } : {}),
  });
}

function ds(lines: string[]): RouterEvalDataset {
  return parseRouterEvalDataset(lines.join('\n'));
}

const oneClassSpec = (gate: Record<string, number> = {}) => parsePromptExperimentSpec({
  v: 1, id: 't', classes: [{ id: 'c', match: { task: 'docs' }, control: 'prompt:plain', challengers: ['prompt:adaptive'] }],
  gate,
});

describe('promotion gate', () => {
  it('verdict no-lift when the challenger loses outright', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      // plain merges 80%, adaptive 20% — challenger clearly worse.
      const plain = i % 5 < 4 ? 'merged' : 'closed';
      const adaptive = i % 5 === 0 ? 'merged' : 'closed';
      const chosen = i % 2 === 0 ? 'prompt:adaptive' : 'prompt:plain';
      lines.push(line(`L${i}`, 'docs thing', chosen, chosen === 'prompt:plain' ? plain : adaptive,
        { 'prompt:plain': { outcome: plain }, 'prompt:adaptive': { outcome: adaptive } }));
    }
    const report = evaluatePromptExperiment(ds(lines), oneClassSpec());
    expect(report.classes[0]!.challengers[0]!.verdict).toBe('no-lift');
    expect(report.promotions).toHaveLength(0);
  });

  it('verdict thin-coverage when unobserved decisions exceed the cap', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      const chosen = i % 2 === 0 ? 'prompt:adaptive' : 'prompt:plain';
      // No arms table at all: every changed decision is unobserved (~50%).
      lines.push(line(`L${i}`, 'docs thing', chosen, 'merged'));
    }
    const report = evaluatePromptExperiment(ds(lines), oneClassSpec());
    expect(report.classes[0]!.challengers[0]!.verdict).toBe('thin-coverage');
  });

  it('verdict cost-regression when the challenger wins but blows the cost guardrail', () => {
    const lines: string[] = [];
    for (let i = 0; i < 24; i++) {
      const plain = i % 3 === 0 ? 'merged' : 'closed';
      const adaptive = i % 5 !== 0 ? 'merged' : 'closed';
      const chosen = i % 2 === 0 ? 'prompt:adaptive' : 'prompt:plain';
      lines.push(JSON.stringify({
        v: 1, id: `L${i}`, task: 'docs thing', candidates: ['prompt:plain', 'prompt:adaptive'],
        chosen, outcome: chosen === 'prompt:plain' ? plain : adaptive,
        costUsd: chosen === 'prompt:plain' ? 0.5 : 9,
        arms: {
          'prompt:plain': { outcome: plain, costUsd: 0.5 },
          'prompt:adaptive': { outcome: adaptive, costUsd: 9 },
        },
      }));
    }
    const report = evaluatePromptExperiment(ds(lines), oneClassSpec());
    expect(report.classes[0]!.challengers[0]!.verdict).toBe('cost-regression');
  });

  it('verdict insufficient-data below the resolved minimum', () => {
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      const chosen = i % 2 === 0 ? 'prompt:adaptive' : 'prompt:plain';
      lines.push(line(`L${i}`, 'docs thing', chosen, 'merged', {
        'prompt:plain': { outcome: 'merged' }, 'prompt:adaptive': { outcome: 'merged' },
      }));
    }
    const report = evaluatePromptExperiment(ds(lines), oneClassSpec());
    expect(report.classes[0]!.challengers[0]!.verdict).toBe('insufficient-data');
  });
});

// ---------------------------------------------------------------------------
// Promotions store
// ---------------------------------------------------------------------------

describe('prompt-promotions store', () => {
  it('saves and loads a registry round-trip under an isolated root', () => {
    const root = mkdtempSync(join(tmpdir(), 'prompt-ab-store-'));
    const registry = promotionsRegistry(evaluatePromptExperiment(dataset(), spec(), { now: '2026-10-28T00:00:00.000Z' }));
    const file = savePromptPromotions(registry, { rootDir: root });
    expect(file).toBe(promptPromotionsPath({ rootDir: root }));
    expect(loadPromptPromotions({ rootDir: root })).toEqual(registry);
  });

  it('returns null for absent or malformed files', () => {
    const root = mkdtempSync(join(tmpdir(), 'prompt-ab-store-'));
    expect(loadPromptPromotions({ rootDir: root })).toBeNull();
  });

  it('merges a new experiment over covered classes only', () => {
    const prior: PromptPromotionsRegistry = {
      schemaVersion: 1, generatedAt: 'a', experimentId: 'old', dataset: { sha256: 'x', jobs: 1 },
      classes: ['docs', 'other'],
      promoted: [
        { classId: 'docs', experimentId: 'old', variant: 'prompt:plain', control: 'prompt:adaptive', before: { value: 0.5, ci95: null, n: 10 }, after: { value: 0.6, ci95: null, n: 10 }, liftPoints: 0.1, costPerMergedPrBefore: 1, costPerMergedPrAfter: 1, decidedAt: 'a', datasetSha256: 'x' },
        { classId: 'other', experimentId: 'old', variant: 'prompt:adaptive', control: 'prompt:plain', before: { value: 0.5, ci95: null, n: 10 }, after: { value: 0.9, ci95: null, n: 10 }, liftPoints: 0.4, costPerMergedPrBefore: 1, costPerMergedPrAfter: 1, decidedAt: 'a', datasetSha256: 'x' },
      ],
      held: [{ classId: 'other', variant: 'prompt:weird', verdict: 'no-lift' }],
    };
    const next = promotionsRegistry(evaluatePromptExperiment(dataset(), spec(), { now: 'b' }));
    const merged = mergePromotions(prior, next);
    // docs took the new record; `other` was not covered and kept its winner.
    expect(merged.promoted.map((p) => p.classId).sort()).toEqual(['docs', 'other']);
    expect(merged.promoted.find((p) => p.classId === 'docs')!.experimentId).toBe('prompt-ab-2026-10-28');
    expect(merged.promoted.find((p) => p.classId === 'other')!.experimentId).toBe('old');
    expect(merged.held.some((h) => h.classId === 'other')).toBe(true); // uncovered classes keep their records
    expect(merged.held.some((h) => h.classId === 'tests')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cliDeps() {
  const out: string[] = [];
  const err: string[] = [];
  const writes = new Map<string, string>();
  const saved: PromptPromotionsRegistry[] = [];
  return {
    deps: {
      readFile: (p: string) => writes.has(p) ? writes.get(p)! : readFileSync(p, 'utf8'),
      writeFile: (p: string, t: string) => { writes.set(p, t); },
      loadRegistry: () => null as PromptPromotionsRegistry | null,
      saveRegistry: (r: PromptPromotionsRegistry) => { saved.push(r); return '/tmp/promotions.json'; },
      out: (t: string) => { out.push(t); },
      err: (t: string) => { err.push(t); },
      now: '2026-10-28T00:00:00.000Z',
    },
    out, err, writes, saved,
  };
}

const DS = join(BENCH_DIR, 'jobs.jsonl');
const SP = join(BENCH_DIR, 'experiment.json');
const PROMOTIONS = join(BENCH_DIR, 'promotions.json');

describe('phm eval prompts', () => {
  it('prints the promotion dashboard with before/after numbers', async () => {
    const { deps, out } = cliDeps();
    const code = await cmdEvalPrompts(['--dataset', DS, '--spec', SP], deps);
    expect(code).toBe(0);
    expect(out[0]).toContain('## docs — promoted `prompt:adaptive`');
    expect(out[0]).toContain('33.3% (n=30) | 77.8% (n=27)');
  });

  it('--write emits the promotions registry artifact', async () => {
    const { deps, writes } = cliDeps();
    await cmdEvalPrompts(['--dataset', DS, '--spec', SP, '--write', '/tmp/p.json', '--json'], deps);
    const written = JSON.parse(writes.get('/tmp/p.json')!) as PromptPromotionsRegistry;
    expect(written.promoted[0]!.variant).toBe('prompt:adaptive');
  });

  it('--promote saves the registry through the store seam', async () => {
    const { deps, saved } = cliDeps();
    await cmdEvalPrompts(['--dataset', DS, '--spec', SP, '--promote', '--json'], deps);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.promoted[0]!.classId).toBe('docs');
  });

  it('--check reproduces the committed promotions file and fails on drift', async () => {
    const { deps, out, err } = cliDeps();
    expect(await cmdEvalPrompts(['--dataset', DS, '--spec', SP, '--check', PROMOTIONS], deps)).toBe(0);
    expect(out[0]).toContain('1 promoted, 2 held');
    const tampered = join(tmpdir(), 'promotions-tampered.json');
    deps.writeFile(tampered, JSON.stringify({ ...COMMITTED_PROMOTIONS, promoted: [] }));
    expect(await cmdEvalPrompts(['--dataset', DS, '--spec', SP, '--check', tampered], deps)).toBe(1);
    expect(err.at(-1)).toContain('prompt-promotion regression');
  });

  it('rejects bad usage and unreadable datasets', async () => {
    const { deps, err } = cliDeps();
    expect(await cmdEvalPrompts([], deps)).toBe(2);
    expect(await cmdEvalPrompts(['--dataset', DS, '--bogus'], deps)).toBe(2);
    expect(await cmdEvalPrompts(['--dataset', '/nonexistent.jsonl'], deps)).toBe(1);
    expect(err.join('')).toContain('--dataset is required');
  });

  it('uses the builtin spec when --spec is absent', async () => {
    const { deps, out } = cliDeps();
    const code = await cmdEvalPrompts(['--dataset', DS], deps);
    expect(code).toBe(0);
    expect(out[0]).toContain('prompt-ab-default');
  });
});

// The phm pulse "Prompt variants" section is exercised in
// test/pulse-prompt-variants.test.ts — the prompt-promotions module mock it
// needs is file-scoped, so it lives apart from the real-store tests above.
