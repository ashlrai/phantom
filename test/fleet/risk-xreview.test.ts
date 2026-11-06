import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assessDiffForXReview } from '../../src/fleet/risk-xreview.js';
import { patch } from './risk-fixtures.js';

const identity = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };

describe('XREVIEW risk feed', () => {
  it.each([
    ['docs/guide.md', 'expedited', 'low'],
    ['src/widget.ts', 'standard', 'medium'],
    ['src/auth/login.ts', 'escalated', 'high'],
  ])('routes %s to %s review', (path, reviewPriority, risk) => {
    const diff = patch(path);
    const result = assessDiffForXReview({ ...identity, diff });
    expect(result).toMatchObject({ schema: 'xreview-risk/v1', ...identity,
      diffSha256: createHash('sha256').update(diff).digest('hex'), reviewPriority,
      assessment: { policyVersion: 'diff-risk/v1', risk } });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it.each([null, undefined, '', 'truncated patch'])('escalates missing or unreadable patch %#', (diff) => {
    expect(assessDiffForXReview({ ...identity, diff })).toMatchObject({ reviewPriority: 'escalated',
      assessment: { score: 100, measurable: false } });
  });

  it.each(['', 'main', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40)])('rejects non-full commit identity %#', (sha) => {
    expect(() => assessDiffForXReview({ ...identity, baseSha: sha, diff: patch('docs/a.md') })).toThrow('commit SHAs');
    expect(() => assessDiffForXReview({ ...identity, headSha: sha, diff: patch('docs/a.md') })).toThrow('commit SHAs');
  });

  it('accepts SHA-256 git commit identities', () => {
    expect(assessDiffForXReview({ baseSha: 'a'.repeat(64), headSha: 'b'.repeat(64), diff: patch('docs/a.md') }).reviewPriority)
      .toBe('expedited');
  });

  it('binds evidence to every base, head and diff change', () => {
    const input = { ...identity, diff: patch('docs/a.md') };
    const original = assessDiffForXReview(input);
    for (const change of [{ baseSha: 'c'.repeat(40) }, { headSha: 'c'.repeat(40) }, { diff: patch('docs/b.md') }]) {
      expect(assessDiffForXReview({ ...input, ...change })).not.toEqual(original);
    }
  });

  it('passes host test-import evidence through to the scorer', () => {
    expect(assessDiffForXReview({ ...identity, diff: patch('test/widget.test.ts'),
      testsImportingTier1: new Set(['test/widget.test.ts']) }).reviewPriority).toBe('escalated');
  });
});
