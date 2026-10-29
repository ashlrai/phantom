import { describe, expect, it } from 'vitest';
import { catalogFor, canonicalModelTag, pickModel } from '../src/core/run/model-catalog.js';

describe('current Claude router table', () => {
  it.each([
    ['claude-haiku-5-5', 'small', 0.5, 2.5],
  ])('offers %s with concrete dispatch identity and cost estimates', (model, tier, input, output) => {
    const entry = catalogFor('claude').find((row) => row.apiModelId === model);
    expect(entry).toMatchObject({
      id: `claude:${model}`, engine: 'claude', tier,
      costPerMTokIn: input, costPerMTokOut: output,
    });
    expect(canonicalModelTag('claude', model)).toBe(model);
    expect(canonicalModelTag('claude', `claude:${model}`)).toBe(model);
  });

  it('routes inexpensive trivial Claude work to Haiku 5.5', () => {
    expect(pickModel({ engine: 'claude', maxEffort: 1, preferCheap: true })?.apiModelId)
      .toBe('claude-haiku-5-5');
  });

  it('never offers Sonnet 4.5 for automatic routing', () => {
    for (const entry of catalogFor('claude')) {
      expect(`${entry.id} ${entry.apiModelId ?? ''}`).not.toMatch(/sonnet[-:]4[-.]5/);
    }
  });

  it('preserves the historical Sonnet alias identity', () => {
    expect(canonicalModelTag('claude', 'claude-sonnet-4-6')).toBe('sonnet');
  });
});
