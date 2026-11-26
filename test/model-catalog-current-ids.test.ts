import { describe, expect, it } from 'vitest';
import { loadVerifiedRegistry, readDocsRecords, selectVerifiedModel } from '../src/core/fleet/model-verify.js';
import {
  CLAUDE5_CATALOG_IDS, KNOWN_MODELS, MODEL_DEFAULTS_BY_TIER, canonicalModelTag, catalogFor, pickModel,
} from '../src/core/run/model-catalog.js';

describe('model catalog current ids', () => {
  it('admits only registry-verified defaults for each tier and provider', async () => {
    const opts = { now: () => Date.parse('2026-11-30'), localRegistryPath: null };
    const registry = await loadVerifiedRegistry(opts);
    const docs = await readDocsRecords(opts);
    expect(docs?.find(row => row.id === 'gemini-4-argon-high')?.status).toBe('retired');
    expect(registry.find(row => row.id === 'swe-2-1')?.status).toBe('unverified');
    for (const tiers of Object.values(MODEL_DEFAULTS_BY_TIER)) {
      expect(Object.keys(tiers).sort()).toEqual(['fast', 'frontier', 'mid', 'work']);
      for (const model of Object.values(tiers)) {
        expect(selectVerifiedModel([model], registry, docs).model, model).toBe(model);
      }
    }
    expect(MODEL_DEFAULTS_BY_TIER.claude.frontier).toBe('claude-opus-5-5');
    expect(KNOWN_MODELS.find(entry => entry.id === 'claude:claude-fable-5-2'))
      .toMatchObject({ explicitOnly: true, seatRouted: true });
  });

  it('keeps every catalog id unique', () => {
    const ids = KNOWN_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers Claude Sonnet 5.5 with its provider API id', () => {
    const sonnet = KNOWN_MODELS.find((m) => m.id === 'claude:claude-sonnet-5-5');
    expect(sonnet).toMatchObject({
      engine: 'claude', tier: 'large', apiModelId: 'claude-sonnet-5-5',
      costPerMTokIn: 2, costPerMTokOut: 10, minEffort: 2, qualityRank: 3,
    });
    // Gated like the other Claude 5 ids: no automatic path picks it yet —
    // explicitOnly keeps flag-on static picks on sonnet-5 (m320/m323 pin it).
    expect(CLAUDE5_CATALOG_IDS.has('claude:claude-sonnet-5-5')).toBe(true);
    expect(sonnet?.explicitOnly).toBe(true);
    expect(pickModel({ engine: 'claude' })?.id).not.toBe('claude:claude-sonnet-5-5');
    expect(catalogFor('claude').map((m) => m.id)).not.toContain('claude:claude-sonnet-5-5');
    expect(canonicalModelTag('claude', 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });

  it('carries every field of the merged Terra entry', () => {
    const terra = KNOWN_MODELS.find((m) => m.id === 'codex:gpt-6.1-terra');
    expect(terra).toMatchObject({
      apiModelId: 'gpt-6.1-terra', apiContextWindow: 1_050_000, toolApi: 'responses',
      contextWindowTokens: 1_050_000, relativeSpeed: 3, planAllowanceWeight: 0.5,
    });
    expect(terra?.reasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it.each([
    ['gpt-6.2-astra', 'ultra', 8, 40],
    ['gpt-6.2-sol', 'normal', 2, 10],
  ])('registers %s as an automatic Codex choice', (model, modeTier, input, output) => {
    const entry = KNOWN_MODELS.find((m) => m.id === `codex:${model}`);
    expect(entry).toMatchObject({
      engine: 'codex', apiModelId: model, modeTier,
      costPerMTokIn: input, costPerMTokOut: output,
      apiContextWindow: 1_050_000, toolApi: 'responses',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(canonicalModelTag('codex', model)).toBe(model);
    expect(catalogFor('codex').map((m) => m.id)).toContain(`codex:${model}`);
    expect(pickModel({ engine: 'codex' })?.apiModelId).toBe('gpt-6.2-sol');
  });

  it('keeps canonicalModelTag sonnet-5 spellings unchanged', () => {
    for (const spelling of ['sonnet-5', 'claude-sonnet-5', 'claude:sonnet-5', 'claude:claude-sonnet-5']) {
      expect(canonicalModelTag('claude', spelling)).toBe('sonnet-5');
    }
  });

  it.each([
    ['gemini-4-carbon', 'ultra', 4, 0.2, 20, 4, false],
    ['gemini-4-neon', 'normal', 3, 0.15, 15, 2, true],
    ['gemini-4-hydrogen', 'lite', 1.5, 0.075, 7.5, 1, true],
  ])('registers %s without making it an implicit API choice', (model, modeTier, input, cached, output, effort, fast) => {
    const entry = KNOWN_MODELS.find(m => m.id === `gemini:${model}`);
    expect(entry).toMatchObject({
      engine: 'gemini', apiModelId: model, modeTier, minEffort: effort,
      costPerMTokIn: input, costPerMTokCachedIn: cached, costPerMTokOut: output,
      apiContextWindow: 1_048_576, apiMaxOutputTokens: 65_536, explicitOnly: true,
    });
    expect(entry?.capabilities.includes('fast')).toBe(fast);
    expect(pickModel({ engine: 'gemini' })).toBeNull();
    expect(catalogFor('gemini')).toEqual([]);
  });
});
