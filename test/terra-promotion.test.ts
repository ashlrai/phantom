import { describe, expect, it } from 'vitest';
import {
  codexArmPriors, codexModelForTier, evaluateTerraPromotion,
  selectCostAwareModel, TERRA_EXPERIMENT_ID, type TerraExperimentJob,
  type EngineScoreMap,
} from '../src/core/run/learned-router.js';
import {
  CODEX_TERRA_MODEL_ID, CODEX_ASTRA_MODEL_ID, DEFAULT_CODEX_MODEL_ID,
  KNOWN_MODELS, type ModelRoutingTier,
} from '../src/core/run/model-catalog.js';
import { requestTokenEvidence } from '../src/core/run/token-evidence.js';

function jobs(arm: 'terra' | 'sol', merges: number, count = 10, tokens = 100): TerraExperimentJob[] {
  return Array.from({ length: count }, (_, index) => ({
    jobId: `TEST-${arm}-${index}`, experiment: TERRA_EXPERIMENT_ID, tier: 'work', arm,
    completed: true, merged: index < merges,
    usage: { tokensIn: tokens, tokensOut: 0, tokenEvidence: requestTokenEvidence('reported', tokens, 0) },
  }));
}

const winning = (): TerraExperimentJob[] => [...jobs('terra', 8), ...jobs('sol', 6)];

describe('Terra experiment promotion', () => {
  it('promotes better merge rate and tokens per merge after ten jobs per arm', () => {
    expect(evaluateTerraPromotion(winning())).toMatchObject({
      eligible: true, reason: 'promote',
      terra: { jobs: 10, merges: 8, tokens: 1000, tokensPerMerge: 125 },
      sol: { jobs: 10, merges: 6, tokens: 1000 },
    });
    const prior = codexArmPriors('work', winning());
    expect(prior[0]!.model).toBe(CODEX_TERRA_MODEL_ID);
    expect(prior.find(entry => entry.model === CODEX_TERRA_MODEL_ID)!.reward)
      .toBeGreaterThan(codexArmPriors('work').find(entry => entry.model === CODEX_TERRA_MODEL_ID)!.reward);
  });

  it('allows exactly equal tokens per merge', () => {
    expect(evaluateTerraPromotion([...jobs('terra', 8, 10, 80), ...jobs('sol', 6, 10, 60)]).eligible).toBe(true);
  });

  it.each([
    ['thin Terra', [...jobs('terra', 8, 9), ...jobs('sol', 6)], 'insufficient-jobs'],
    ['thin Sol', [...jobs('terra', 8), ...jobs('sol', 6, 9)], 'insufficient-jobs'],
    ['tied merge rate', [...jobs('terra', 6), ...jobs('sol', 6)], 'merge-rate-not-better'],
    ['worse merge rate', [...jobs('terra', 5), ...jobs('sol', 6)], 'merge-rate-not-better'],
    ['more tokens per merge', [...jobs('terra', 8, 10, 200), ...jobs('sol', 6)], 'tokens-per-merge-worse'],
    ['no baseline merges', [...jobs('terra', 8), ...jobs('sol', 0)], 'no-merges'],
  ] as const)('does not promote %s', (_name, rows, reason) => {
    expect(evaluateTerraPromotion(rows)).toMatchObject({ eligible: false, reason });
  });

  it('counts failed-job tokens, preventing survivorship bias', () => {
    const rows = winning();
    rows[9]!.usage = { tokensIn: 10000, tokensOut: 0, tokenEvidence: requestTokenEvidence('reported', 10000, 0) };
    expect(evaluateTerraPromotion(rows).reason).toBe('tokens-per-merge-worse');
  });

  it('deduplicates identical job observations and rejects contradictory ones', () => {
    const rows = winning();
    expect(evaluateTerraPromotion([...rows, rows[0]!]).terra.jobs).toBe(10);
    expect(evaluateTerraPromotion([...rows, { ...rows[0]!, merged: false }]).reason).toBe('invalid-evidence');
    expect(evaluateTerraPromotion([...rows, { ...rows[0]!, arm: 'sol' }]).reason).toBe('invalid-evidence');
    expect(evaluateTerraPromotion(Array.from({ length: 10 }, () => rows[0]!)).eligible).toBe(false);
  });

  it.each(['estimated', 'reserved', 'unknown'] as const)('rejects %s token provenance', basis => {
    const rows = winning();
    rows[0]!.usage.tokenEvidence = requestTokenEvidence(basis, 100, 0);
    expect(evaluateTerraPromotion(rows).reason).toBe('invalid-evidence');
  });

  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER])('fails closed on invalid or overflowing token count %s', tokens => {
    const rows = winning();
    rows[0]!.usage = { tokensIn: tokens, tokensOut: 0, tokenEvidence: requestTokenEvidence('reported', tokens, 0) };
    expect(evaluateTerraPromotion(rows).reason).toBe('invalid-evidence');
  });

  it('rejects absent usage, missing provenance and unfinished cohort members', () => {
    const rows = winning();
    delete rows[0]!.usage.tokenEvidence;
    expect(evaluateTerraPromotion(rows).reason).toBe('invalid-evidence');
    expect(evaluateTerraPromotion([...winning(), { ...winning()[0]!, jobId: 'TEST-pending', completed: false }]).reason).toBe('invalid-evidence');
  });

  it('does not combine experiments or tiers and does not mutate its inputs', () => {
    const rows = winning();
    const before = JSON.stringify(rows);
    expect(evaluateTerraPromotion(rows.map(row => ({ ...row, experiment: 'TEST-unrelated' }))).eligible).toBe(false);
    expect(evaluateTerraPromotion(rows.map(row => ({ ...row, tier: 'mid' }))).eligible).toBe(false);
    codexArmPriors('work', rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('Codex allowance priors', () => {
  it.each([
    ['fast', CODEX_TERRA_MODEL_ID], ['mid', CODEX_TERRA_MODEL_ID],
    ['computer', CODEX_TERRA_MODEL_ID], ['work', DEFAULT_CODEX_MODEL_ID],
    ['frontier', CODEX_ASTRA_MODEL_ID],
  ] satisfies [ModelRoutingTier, string][])('defaults %s to %s', (tier, model) => {
    expect(codexModelForTier(tier)).toBe(model);
  });

  it('keeps promotion work-only and never feeds observations into static defaults', () => {
    expect(codexArmPriors('frontier', winning())).toEqual(codexArmPriors('frontier'));
    expect(codexArmPriors('computer', winning())).toEqual(codexArmPriors('computer'));
    codexArmPriors('work', winning());
    expect(codexModelForTier('work')).toBe(DEFAULT_CODEX_MODEL_ID);
  });

  const candidates = KNOWN_MODELS.filter(entry =>
    [CODEX_TERRA_MODEL_ID, DEFAULT_CODEX_MODEL_ID, CODEX_ASTRA_MODEL_ID].includes(entry.apiModelId ?? ''));
  const scores = (terra: number, sol: number, astra: number, samples = 10): EngineScoreMap => new Map(
    [CODEX_TERRA_MODEL_ID, DEFAULT_CODEX_MODEL_ID, CODEX_ASTRA_MODEL_ID].map((model, index) => {
      const key = `codex:${model}`;
      return [key, { key, engine: 'codex', model, score: [terra, sol, astra][index]!, samples }];
    }),
  );

  it('competes on measured reward per allowance after the quality floor', () => {
    expect(selectCostAwareModel(candidates, scores(0.7, 0.9, 1), { minShipRate: 0.7 })?.apiModelId).toBe(CODEX_TERRA_MODEL_ID);
    expect(selectCostAwareModel(candidates, scores(0.3, 0.9, 1), { minShipRate: 0.2 })?.apiModelId).toBe(DEFAULT_CODEX_MODEL_ID);
    expect(selectCostAwareModel(candidates, scores(0.4, 0.9, 1), { minShipRate: 0.7 })?.apiModelId).toBe(DEFAULT_CODEX_MODEL_ID);
  });

  it('does not infer learned evidence from priors or thin samples', () => {
    expect(selectCostAwareModel(candidates, new Map(), { minShipRate: 0.7 })).toBeNull();
    expect(selectCostAwareModel(candidates, scores(1, 1, 1, 1), { minShipRate: 0.7 })).toBeNull();
    expect(selectCostAwareModel(candidates, scores(NaN, NaN, NaN), { minShipRate: 0.7 })).toBeNull();
  });
});
