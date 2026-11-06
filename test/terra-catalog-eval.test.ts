import { describe, expect, it } from 'vitest';
import { score } from '../benchmarks/terra-eval.mjs';
import { KNOWN_MODELS, catalogFor, pickModel } from '../src/core/run/model-catalog.js';
import { codexModelOptions } from '../src/core/verse/model-windows.js';
import { resourceQuotaBuckets, sharesResourceQuota, validateResourceQuotaScope } from '../src/core/resources/quota-scope.js';
import type { ResourceWorker } from '../src/core/resources/pool-policy.js';

const worker = (model: string, quotaScope: ResourceWorker['quotaScope']): ResourceWorker => ({
  id: model, provider: 'codex', model, quotaScope, maxConcurrent: 1, reservePercent: 10,
  maxTasksPerWindow: 1, taskWindowMs: 60_000, priority: 1,
});

describe('Terra catalog and quota', () => {
  it('records API limits without silently changing automatic selection', () => {
    const model = KNOWN_MODELS.find(m => m.id === 'codex:gpt-6.1-terra');
    expect(model).toMatchObject({ tier: 'mid', costPerMTokIn: 1, costPerMTokOut: 5,
      apiModelId: 'gpt-6.1-terra', apiContextWindow: 1_050_000, toolApi: 'responses', explicitOnly: true });
    expect(catalogFor('codex')).not.toContain(model);
    expect(pickModel({ engine: 'codex', preferCheap: true })?.id).not.toBe(model?.id);
  });
  it('uses the seat catalog for native windows, not API context as a CLI promise', () => {
    const [option] = codexModelOptions([{ slug: 'gpt-6.1-terra', displayName: 'Terra', visibility: 'list',
      contextWindow: 272_000, maxContextWindow: 872_000, effectiveContextWindowPercent: 95,
      autoCompactTokenLimit: null, priority: 1 }]);
    expect(option).toMatchObject({ id: 'gpt-6.1-terra', contextWindow: 258_400, windowSource: 'provider-catalog',
      expansive: { providerWindow: 872_000 } });
  });
  it('shares General quota and preserves conservative unmapped and Spark behavior', () => {
    const terra = worker('gpt-6.1-terra', 'codex-general-v1');
    expect(resourceQuotaBuckets(terra)).toEqual(['codex']);
    expect(sharesResourceQuota(terra, worker('gpt-6-astra', 'codex-general-v1'))).toBe(true);
    expect(sharesResourceQuota(terra, worker('gpt-5.3-codex-spark', 'codex-spark-v1'))).toBe(false);
    expect(sharesResourceQuota(terra, worker('unknown', undefined))).toBe(true);
    expect(() => validateResourceQuotaScope('codex', 'gpt-6.1-terra', 'codex-spark-v1')).toThrow();
    expect(() => validateResourceQuotaScope('claude', 'gpt-6.1-terra', 'codex-general-v1')).toThrow();
  });
});

describe('offline Terra evaluation', () => {
  it('scores complete paired results and refuses missing, duplicate, or mislabeled trials', () => {
    const rows = [
      ...['sol', 'terra'].flatMap(arm => [['coding-boundary', '10'], ['coding-regression', 'B'],
        ['visual-verifier', 'FAIL'], ['computer-verifier', 'FAIL'], ['visual-pass', 'PASS'],
        ['computer-pass', 'PASS'], ['triage', 'P1']].map(([caseId, answer]) => ({
        arm, model: arm === 'sol' ? 'gpt-6.1-sol' : 'gpt-6.1-terra', effort: 'medium', caseId, answer,
        trial: 1, elapsedMs: 10, inputTokens: 20, outputTokens: 1 }))),
      { arm: 'terra-none', model: 'gpt-6.1-terra', effort: 'none', caseId: 'triage', answer: '', trial: 1,
        elapsedMs: 11, inputTokens: 20, outputTokens: 0 },
    ];
    const result = score({ trials: 1, results: rows });
    expect(result[0]!.lanes.visual).toMatchObject({ passed: 2, total: 2 });
    expect(result[1]!.lanes.computer).toMatchObject({ passed: 2, total: 2 });
    expect(result[2]!.lanes.triage).toMatchObject({ passed: 0, total: 1 });
    expect(() => score({ trials: 1, results: rows.slice(1) })).toThrow('Incomplete');
    expect(() => score({ trials: 1, results: [...rows, rows[0]] })).toThrow('Invalid');
    expect(() => score({ trials: 1, results: [{ ...rows[0], effort: 'none' }, ...rows.slice(1)] })).toThrow('Invalid');
  });
});
