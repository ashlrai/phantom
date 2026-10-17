/**
 * Cited lessons on the read side (learn/retro/inject.ts): a note shows the PRs and checks it was learned from that its
 * text does not already name, and a note whose every cited PR was reverted after merging is withheld.
 */
import { describe, expect, it } from 'vitest';

import { prKey } from '../src/core/improve/lesson-trial.js';
import { citedPrKeys, evidenceTag, knowledgeBlockFor, withholdReverted } from '../src/core/learn/retro/inject.js';
import type { KnowledgeEvidenceRef, KnowledgeNoteV1 } from '../src/core/learn/retro/types.js';

function note(id: string, text: string, evidence?: KnowledgeEvidenceRef[]): KnowledgeNoteV1 {
  return {
    v: 1, id, text, scope: { repo: 'ashlrai/phantom', pathGlobs: [], taskKinds: [] }, status: 'approved', retroId: null, source: 'cloud',
    createdAt: '2026-10-01T00:00:00.000Z', decidedAt: '2026-10-02T00:00:00.000Z', edited: false, hits: 0, lastHitAt: null, seen: 1, agentsMdTaskId: null,
    ...(evidence ? { evidence } : {}),
  };
}
const pr = (number: number, sha: string | null = null, repository = 'ashlrai/Phantom'): KnowledgeEvidenceRef => ({ kind: 'pr', repository, number, sha, detail: null });
const ci = (number: number, detail: string): KnowledgeEvidenceRef => ({ kind: 'ci', repository: 'ashlrai/phantom', number, sha: null, detail });
const target = { repo: 'ashlrai/phantom', paths: [], kind: null, text: 'Fix the flaky scheduler test' };

describe('cited PRs', () => {
  it('uses the same key as the outcome ledger and the lessons trial', () => {
    expect(citedPrKeys(note('kn_a', 'x', [pr(812), ci(812, 'CI Gate'), pr(9, null, 'ashlrai/locus')])))
      .toEqual([prKey('ashlrai/Phantom', 812), prKey('ashlrai/locus', 9)]);
    expect(citedPrKeys(note('kn_b', 'x', [{ kind: 'ci', repository: 'ashlrai/phantom', number: null, sha: 'abcdef1', detail: 'lint' }]))).toEqual([]);
    expect(citedPrKeys(note('kn_c', 'x'))).toEqual([]);
  });
});

describe('evidence tag', () => {
  it('names the PRs and checks the text leaves out, at most three of each', () => {
    const merged = note('kn_m', 'Run lint before opening the PR; it failed (ashlrai/phantom#812 @abcdef1).',
      [pr(812, 'abcdef1234'), ci(812, 'lint'), pr(840, '1234567890'), ci(840, 'typecheck')]);
    expect(evidenceTag(merged)).toBe(' (seen on ashlrai/Phantom#840 @1234567; checks: typecheck)');
    const many = note('kn_n', 'Keep PRs small.', [pr(1), pr(2), pr(3), pr(4)]);
    expect(evidenceTag(many)).toBe(' (seen on ashlrai/Phantom#1, ashlrai/Phantom#2, ashlrai/Phantom#3)');
  });

  it('is empty when the text already says it all, or nothing is cited', () => {
    expect(evidenceTag(note('kn_x', 'Run lint; it failed on ashlrai/phantom#812.', [pr(812), ci(812, 'lint')]))).toBe('');
    expect(evidenceTag(note('kn_y', 'Keep PRs small.'))).toBe('');
  });

  it('rides on the rendered line', () => {
    const block = knowledgeBlockFor(target, { notes: [note('kn_t', 'Keep PRs small.', [pr(840, 'abcdef1234')])], recordHits: false });
    expect(block.text).toContain('- [ashlrai/phantom] Keep PRs small. (seen on ashlrai/Phantom#840 @abcdef1)');
  });
});

describe('reverted lessons', () => {
  const reverted = note('kn_r', 'Pin the toolchain.', [pr(800)]);
  const partly = note('kn_p', 'Batch CI pushes.', [pr(800), pr(801)]);
  const uncited = note('kn_u', 'Prefer small diffs.');

  it('withholds a note only when every PR it cites was reverted', () => {
    const keys = new Set([prKey('ashlrai/phantom', 800)]);
    expect(withholdReverted([reverted, partly, uncited], () => keys).map((n) => n.id)).toEqual(['kn_p', 'kn_u']);
  });

  it('reads the reverted set only when a note cites a PR, and withholds nothing if it cannot be read', () => {
    let reads = 0;
    expect(withholdReverted([uncited], () => { reads += 1; return new Set(); })).toEqual([uncited]);
    expect(reads).toBe(0);
    expect(withholdReverted([reverted], () => { throw new Error('ledger unreadable'); })).toEqual([reverted]);
  });

  it('keeps a reverted lesson out of the prompt, and in it when no reverted set is given', () => {
    const keys = () => new Set([prKey('ashlrai/phantom', 800)]);
    expect(knowledgeBlockFor(target, { notes: [reverted, uncited], recordHits: false, revertedPrKeys: keys }).noteIds).toEqual(['kn_u']);
    expect(knowledgeBlockFor(target, { notes: [reverted, uncited], recordHits: false }).noteIds).toEqual(['kn_r', 'kn_u']);
  });
});
