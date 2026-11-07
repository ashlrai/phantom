import { describe, expect, it } from 'vitest';
import { buildFleetVerbCatalog, extractVerbSummary } from '../src/core/fleet/fleet-verb-catalog.js';

describe('fleet verb catalog', () => {
  it('extracts matching usage with and without the prefix', () => {
    expect(extractVerbSummary("const USAGE = 'Usage: ashlr fleet demo [--json]';", 'demo').usage).toBe('ashlr fleet demo [--json]');
    expect(extractVerbSummary('const USAGE = "ashlr fleet demo";', 'demo').usage).toBe('ashlr fleet demo');
  });

  it('cleans the first sentence of a leading header', () => {
    expect(extractVerbSummary('/**\n * `src/cli/demo.ts` describes this verb. Another sentence.\n */', 'demo').summary).toBe('demo.ts describes this verb.');
  });

  it('returns nulls when no information exists', () => {
    expect(extractVerbSummary('export const x = 1;', 'demo')).toEqual({ usage: null, summary: null });
  });

  it('sorts verbs and retains unreadable sources', () => {
    expect(buildFleetVerbCatalog(['zebra', 'alpha'], () => null)).toEqual([
      { verb: 'alpha', usage: null, summary: null, effect: 'unknown' }, { verb: 'zebra', usage: null, summary: null, effect: 'unknown' },
    ]);
  });
});
