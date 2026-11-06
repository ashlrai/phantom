import { describe, expect, it } from 'vitest';
import { isJobDetail, publishFacts } from './worker-log-model.js';

describe('publish facts', () => {
  it('preserves the server values without changing their contents', () => {
    const facts = { testLine: 'TEST  vitest\n12 passed', sensitive: ['src/cli/desktop.ts', 'other.ts'] };
    expect(publishFacts(facts)).toEqual(facts);
  });

  it('uses null for missing and wrongly typed fields', () => {
    expect(publishFacts(undefined)).toEqual({ testLine: null, sensitive: null });
    expect(publishFacts({})).toEqual({ testLine: null, sensitive: null });
    expect(publishFacts({ testLine: 12, sensitive: 'path' })).toEqual({ testLine: null, sensitive: null });
    expect(publishFacts({ testLine: null, sensitive: ['path', 1] })).toEqual({ testLine: null, sensitive: null });
  });

  it('treats an empty sensitive list as absent', () => {
    expect(publishFacts({ testLine: null, sensitive: [] })).toEqual({ testLine: null, sensitive: null });
  });

  it('keeps the wire contract validation for malformed publish fields', () => {
    expect(isJobDetail({ schema: 'fleet.job.v1', publish: { testLine: 12 } })).toBe(false);
    expect(isJobDetail({ schema: 'fleet.job.v1', publish: { sensitive: ['path', 1] } })).toBe(false);
  });
});
