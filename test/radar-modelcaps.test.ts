import { describe, expect, it } from 'vitest';
import {
  catalogFor, canonicalModelTag, CLAUDE_CHEAP_MODEL_ID,
  DEFAULT_CLAUDE_MODEL_ID, defaultStrategistModel, pickModel,
} from '../src/core/run/model-catalog.js';

describe('RADAR-MODELCAPS: Sonnet 4.5 retirement and Haiku 5.5', () => {
  it('offers the concrete cheap Claude seat with explicit request restrictions', () => {
    const model = catalogFor('claude').find(entry => entry.apiModelId === CLAUDE_CHEAP_MODEL_ID);
    expect(model).toMatchObject({
      id: 'claude:claude-haiku-5-5', tier: 'small', minEffort: 1,
      capabilities: ['fast', 'general'], seatRouted: true,
      rejectedRequestFeatures: ['budget_tokens', 'temperature', 'top_p', 'top_k', 'prefill'],
    });
    expect(pickModel({ engine: 'claude', maxEffort: 1, preferCheap: true })).toBe(model);
    expect(canonicalModelTag('claude', CLAUDE_CHEAP_MODEL_ID)).toBe('claude-haiku-5-5');
  });

  it('does not let subscription accounting win automatic cross-engine routing', () => {
    expect(pickModel({ maxEffort: 1, preferCheap: true })?.apiModelId).not.toBe(CLAUDE_CHEAP_MODEL_ID);
  });

  it('keeps current defaults and judge selection off Sonnet 4.5', () => {
    expect(DEFAULT_CLAUDE_MODEL_ID).toBe('claude-opus-5-5');
    expect(defaultStrategistModel({ foundry: { claude5: { fable: false } } })).toBe(DEFAULT_CLAUDE_MODEL_ID);
    expect(defaultStrategistModel()).not.toContain('sonnet-4-5');
    expect(catalogFor('claude').some(entry => entry.apiModelId?.startsWith('claude-sonnet-4-5'))).toBe(false);
    // Historical identities must remain stable for stored telemetry and attestations.
    expect(canonicalModelTag('claude', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(canonicalModelTag('claude', 'claude-haiku-4-5')).toBe('haiku');
  });
});
