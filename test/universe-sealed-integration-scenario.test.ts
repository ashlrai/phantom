import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { artifactDigest, digest, materializeSeed } from '../src/core/universe/artifacts.js';
import * as delivery from '../src/core/universe/delivery.js';
import { deliverUniverseIntegration } from '../src/core/universe/integration-delivery.js';
import { evaluateUniverseIntegration, readUniverseIntegrationEvaluation } from '../src/core/universe/integration-evaluate.js';
import { readUniverseIntegrationPlan } from '../src/core/universe/integration-plan.js';
import { initUniverse, manifestRecord, universePath } from '../src/core/universe/store.js';
import type { UniverseManifest } from '../src/core/universe/types.js';

const branches = JSON.parse(readFileSync(new URL('./fixtures/sealed-checkout-branches-v1.json', import.meta.url), 'utf8')) as {
  publicOrderCents: number; incumbent: Record<string, number>;
  feeChange: Change; budgetChange: Change; compatibleBudgetChange: Change;
};
type Change = { path: string; value: number };
const pin = { id: 'checkout-budget-v1', digest: 'e8e7c766b12f668d7044f72791246f70122eb6e6234d3d372c32003ccbadccbd' } as const;

function remove(root: string): void {
  const writable = (path: string): void => {
    if (!lstatSync(path).isDirectory()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  writable(root);
  rmSync(root, { recursive: true, force: true });
}

it('rejects independently green changes at downstream checkout and publishes only the compatible composition', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'universe-sealed-integration-')));
  try {
    const root = join(scratch, 'store'), repo = join(scratch, 'repo');
    mkdirSync(repo, { mode: 0o700 });
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Checkout Fixture', '-c', 'user.email=checkout@example.invalid', '-C', repo, ...args], {
      encoding: 'utf8', timeout: 5_000, env: { PATH: process.env.PATH, HOME: scratch, LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
    git('init', '-q', '--template=', '--initial-branch=main');
    const save = (path: string, cents: number): void => writeFileSync(join(repo, path), `${cents}\n`);
    for (const [path, cents] of Object.entries(branches.incumbent)) save(path, cents);
    git('add', '--', ...Object.keys(branches.incumbent)); git('commit', '-qm', 'incumbent');
    const baseCommit = git('rev-parse', 'HEAD');
    const receipts = new Map<string, delivery.UniverseDeliveryReceipt>();
    const source = (universeId: string, change: Change) => {
      const branch = `codex/${universeId}`;
      git('switch', '-q', '-c', branch, baseCommit);
      save(change.path, change.value);
      git('add', '--', change.path); git('commit', '-qm', universeId);
      const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
      const cents = (path: string): number => Number(git('show', `${commit}:${path}`));
      expect(cents(change.path)).toBe(change.value);
      expect(branches.publicOrderCents + cents('fee-cents.json')).toBeLessThanOrEqual(cents('budget-cents.json'));
      const id = digest(universeId), time = '2026-01-01T00:00:00.000Z';
      const artifact = materializeSeed({ repo, revision: commit }, join(scratch, universeId));
      receipts.set(universeId, { schemaVersion: 1, id, universeId, trialId: 'local-trial', runId: 'local-run', niche: 'checkout',
        manifestDigest: digest('manifest'), comparatorDigest: digest('comparator'), artifactDigest: artifact,
        repo, branch, baseCommit, commit, tree, changedFiles: [change.path], status: 'delivered', createdAt: time, completedAt: time });
      return { universeId, deliveryId: id, commit, tree };
    };
    const fee = source('fee', branches.feeChange), budget = source('budget', branches.budgetChange);
    const compatible = source('compatible', branches.compatibleBudgetChange);
    git('switch', '-q', 'main');
    vi.spyOn(delivery, 'readUniverseDeliveries').mockImplementation((id) => ({ sourceState: 'healthy', reasons: [],
      deliveries: receipts.has(id) ? [receipts.get(id)!] : [] }));

    const manifest: UniverseManifest = { schemaVersion: 1, id: 'acceptance', name: 'Checkout acceptance',
      objective: 'Keep checkout usable after fee and budget changes', seed: { repo, revision: baseCommit },
      metric: { name: 'checkout', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxDurationMs: 10_000, trialTimeoutMs: 5_000, maxParallel: 1 },
      evaluation: { command: ['/bin/false'], timeoutMs: 5_000, integrationScenario: pin },
      variants: [{ id: 'fixture', niche: 'checkout', hypothesis: 'Update fee or budget', command: ['/bin/false'] }] };
    expect(() => initUniverse({ ...manifest, evaluation: { ...manifest.evaluation, integrationScenario: { ...pin, digest: digest('changed') } } },
      { root })).toThrow(/scenario identity or digest mismatch/);
    expect(existsSync(root)).toBe(false);
    initUniverse(manifest, { root });
    const { manifestDigest, comparatorDigest } = manifestRecord(universePath(root, manifest.id));
    const evaluate = (id: string, sources: typeof fee[]) => {
      const integration = { schemaVersion: 1, id, target: { repo, baseCommit, allowedPaths: Object.keys(branches.incumbent) }, sources };
      const plan = readUniverseIntegrationPlan(integration, { root });
      expect(plan).toMatchObject({ compositionReady: true, conflicts: [] });
      return { schemaVersion: 1, id, integration, expectedCompositionDigest: plan.compositionDigest,
        acceptance: { universeId: manifest.id, manifestDigest, comparatorDigest }, maxDurationMs: 15_000 };
    };
    const rejected = evaluate('rejected', [fee, budget]);
    const result = await evaluateUniverseIntegration(rejected, { root });
    expect(result).toMatchObject({ status: 'rejected', reason: 'rejected-by-sealed-scenario', score: 0, metrics: {} });
    const evidence = readUniverseIntegrationEvaluation(rejected, { root });
    expect(evidence.result).toEqual(result);
    expect(artifactDigest(result.artifactPath!)).toBe(result.artifactDigest);
    for (const { path, value } of [branches.feeChange, branches.budgetChange]) {
      expect(readFileSync(join(result.artifactPath!, path), 'utf8')).toBe(`${value}\n`);
    }
    await expect(deliverUniverseIntegration({ schemaVersion: 1, evaluation: rejected, expectedEvaluationDigest: evidence.resultDigest,
      branch: 'codex/rejected', maxDurationMs: 15_000 }, { root })).rejects.toThrow(/requires a verified passing evaluation/);
    expect(git('branch', '--list', 'codex/rejected')).toBe('');

    const accepted = evaluate('accepted', [fee, compatible]);
    await expect(evaluateUniverseIntegration(accepted, { root })).resolves.toMatchObject({ status: 'passed', reason: null });
    const passing = readUniverseIntegrationEvaluation(accepted, { root });
    await expect(deliverUniverseIntegration({ schemaVersion: 1, evaluation: accepted, expectedEvaluationDigest: passing.resultDigest,
      branch: 'codex/accepted', maxDurationMs: 15_000 }, { root })).resolves.toMatchObject({ status: 'delivered' });
    expect(git('show', 'codex/accepted:budget-cents.json')).toBe(String(branches.compatibleBudgetChange.value));
    expect(git('rev-parse', 'HEAD')).toBe(baseCommit);
  } finally {
    vi.restoreAllMocks();
    remove(scratch);
  }
}, 30_000);
