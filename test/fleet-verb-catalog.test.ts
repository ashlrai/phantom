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

  it('keeps the middle segments of a placeholder-rooted path', () => {
    const source = '/**\n * `phm fleet board --leader` reads the board the tick wrote to <runs>/coordination/leader-board.json. Read-only.\n */';
    expect(extractVerbSummary(source, 'board').summary).toContain('<runs>/coordination/leader-board.json');
    expect(extractVerbSummary('/** Writes under <runs-dir>/metrics/jobs.jsonl daily. */', 'demo').summary).toContain('<runs-dir>/metrics/jobs.jsonl');
  });

  it('still strips leading segments of real paths mid-sentence', () => {
    expect(extractVerbSummary('/** Reads queue/ready.tsv and src/core/fleet/x.ts for state. */', 'demo').summary).toBe('Reads ready.tsv and x.ts for state.');
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
