import { describe, expect, it } from 'vitest';
import {
  CLAUDE5_CATALOG_IDS, KNOWN_MODELS, canonicalModelTag, catalogFor, pickModel,
} from '../src/core/run/model-catalog.js';

describe('model catalog current ids', () => {
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

  it('keeps canonicalModelTag sonnet-5 spellings unchanged', () => {
    for (const spelling of ['sonnet-5', 'claude-sonnet-5', 'claude:sonnet-5', 'claude:claude-sonnet-5']) {
      expect(canonicalModelTag('claude', spelling)).toBe('sonnet-5');
    }
  });
});
