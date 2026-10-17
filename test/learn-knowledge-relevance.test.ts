/**
 * Lesson selection past the scope match (relevance scoring and selectKnowledge in learn/retro/inject.ts).
 * The benchmark fixture holds 60 approved notes, 50 tuning tasks and 50 validation tasks written by a second author
 * who saw only the notes. The rule was chosen on tuning tasks; the validation numbers below were measured once.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { KNOWLEDGE_INJECT_MAX_NOTES, relevanceTerms, scopeMatches, scoreKnowledge, selectKnowledge, stem } from '../src/core/learn/retro/inject.js';
import type { KnowledgeNoteV1, KnowledgeScope, KnowledgeTarget, TaskKind } from '../src/core/learn/retro/types.js';

function note(id: string, text: string, scope: Partial<KnowledgeScope> = {}): KnowledgeNoteV1 {
  return {
    v: 1, id, text, scope: { repo: null, pathGlobs: [], taskKinds: [], ...scope }, status: 'approved', retroId: null, source: 'fleet',
    createdAt: '2026-09-01T00:00:00.000Z', decidedAt: '2026-09-02T00:00:00.000Z', edited: false, hits: 0, lastHitAt: null, seen: 1, agentsMdTaskId: null,
  };
}

interface BenchTask { id: string; text: string; repo: string | null; paths: string[]; kind: TaskKind | null; relevant: string[] }
const bench = JSON.parse(readFileSync(new URL('./fixtures/lessons-bench.json', import.meta.url), 'utf8')) as {
  notes: Array<{ id: string; text: string; scope: KnowledgeScope }>; tuning: BenchTask[]; validation: BenchTask[];
};
const pool = bench.notes.map((n) => note(n.id, n.text, n.scope));

/** Recall of relevant notes and notes served per task, as the daemon and cloud briefs call it (no paths, no kind) or with both. */
function measure(tasks: BenchTask[], shape: 'brief' | 'full', select: (target: KnowledgeTarget) => KnowledgeNoteV1[]) {
  let found = 0, relevant = 0, served = 0;
  for (const task of tasks) {
    const target: KnowledgeTarget = shape === 'brief'
      ? { repo: task.repo, paths: [], kind: null, text: task.text }
      : { repo: task.repo, paths: task.paths, kind: task.kind, text: task.text };
    const ids = new Set(select(target).map((n) => n.id));
    found += task.relevant.filter((id) => ids.has(id)).length;
    relevant += task.relevant.length;
    served += ids.size;
  }
  return { recall: found / relevant, perTask: served / tasks.length };
}
const scopeOnly = (target: KnowledgeTarget) => pool.filter((n) => scopeMatches(n.scope, target));

describe('relevance terms', () => {
  it('stems inflections together and splits identifiers and paths', () => {
    expect(stem('importers')).toBe(stem('importer'));
    expect(stem('pinned')).toBe(stem('pinning'));
    expect([...relevanceTerms('crates/phantom-vault/src/kdf.rs')]).toEqual(expect.arrayContaining(['crat', 'phantom', 'vault', 'kdf', 'rs']));
    expect([...relevanceTerms('looksLikeSecret in the .env')]).toEqual(expect.arrayContaining(['look', 'secret', 'env']));
    expect(relevanceTerms('the and of it 2026').size).toBe(0);
  });

  it('a stem every note shares weighs less than one only this note uses, and one rare stem scores 1', () => {
    const notes = [note('kn_a', 'Clippy lint warnings fail CI'), note('kn_b', 'CI caches cargo builds'), note('kn_c', 'CI runs on macOS')];
    const scored = scoreKnowledge(notes, { repo: null, paths: [], kind: null, text: 'Fix the clippy CI job' });
    const byId = Object.fromEntries(scored.map((s) => [s.note.id, s.score]));
    expect(byId.kn_a).toBeGreaterThan(byId.kn_b);
    expect(byId.kn_b).toBe(byId.kn_c);
    expect(scoreKnowledge([note('kn_x', 'argon2 parameters')], { repo: null, paths: [], kind: null, text: 'raise argon2 cost' })[0].score).toBe(1);
  });
});

describe('selectKnowledge past the scope match', () => {
  const crowd = Array.from({ length: 12 }, (_, i) => note(`kn_crowd${String(i).padStart(2, '0')}`, `General advice number ${i} about release notes wording.`));

  it('a few matching notes, or no task text, keep the scope-only behavior', () => {
    const few = crowd.slice(0, KNOWLEDGE_INJECT_MAX_NOTES);
    expect(selectKnowledge(few, { repo: null, paths: [], kind: null, text: 'Fix the parser' })).toHaveLength(KNOWLEDGE_INJECT_MAX_NOTES);
    expect(selectKnowledge(crowd, { repo: null, paths: [], kind: null })).toHaveLength(crowd.length);
  });

  it('many matching notes: only notes about the task, at most the cap, evidence first', () => {
    const argon = note('kn_argon', 'Argon2id memory cost changes need a migration path for older vaults.');
    const kinded = note('kn_kinded', 'Prefer small diffs.', { taskKinds: ['fix'] });
    const picked = selectKnowledge([...crowd, argon, kinded], { repo: null, paths: [], kind: 'fix', text: 'Raise the Argon2id memory cost' });
    expect(picked.map((n) => n.id)).toEqual(['kn_kinded', 'kn_argon']);
    const topics = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
    const relevant = topics.map((word, i) => note(`kn_topic${String(i).padStart(2, '0')}`, `Lesson about ${word}.`));
    expect(selectKnowledge(relevant, { repo: null, paths: [], kind: null, text: topics.join(' ') })).toHaveLength(KNOWLEDGE_INJECT_MAX_NOTES);
  });

  it('a brief with no paths yet still gets a path-scoped note whose words are about it', () => {
    const vault = note('kn_vault', 'Keep the legacy Argon2 parameters readable.', { repo: 'ashlrai/phantom-secrets', pathGlobs: ['crates/phantom-vault/**'] });
    const target: KnowledgeTarget = { repo: 'ashlrai/phantom-secrets', paths: [], kind: null, text: 'Raise Argon2 memory cost in the vault' };
    expect(scopeMatches(vault.scope, target)).toBe(false);
    expect(selectKnowledge([vault], target).map((n) => n.id)).toEqual(['kn_vault']);
    expect(selectKnowledge([vault], { ...target, text: 'Rewrite the README intro' })).toEqual([]);
    expect(selectKnowledge([vault], { ...target, repo: 'ashlrai/locus' })).toEqual([]);
  });

  it('never serves a note that is not approved', () => {
    const pending = { ...note('kn_pending', 'Argon2 memory cost note'), status: 'pending' as const };
    expect(selectKnowledge([...crowd, pending], { repo: null, paths: [], kind: null, text: 'Argon2 memory cost' })).toEqual([]);
  });
});

describe('lessons benchmark', () => {
  it('validation, as briefs are written (no paths, no kind): more relevant lessons with a quarter of the notes', () => {
    const before = measure(bench.validation, 'brief', scopeOnly);
    const after = measure(bench.validation, 'brief', (t) => selectKnowledge(pool, t));
    // Measured once on 2026-10-17: scope-only 0.700 recall at 23.3 notes per task; selected 0.800 at 6.2.
    expect(before.recall).toBeCloseTo(0.7, 3);
    expect(after.recall).toBeGreaterThanOrEqual(0.8);
    expect(after.recall).toBeGreaterThan(before.recall);
    expect(after.perTask).toBeLessThanOrEqual(6.5);
    expect(before.perTask).toBeGreaterThan(23);
  });

  it('validation with paths and kind known, and both shapes on tuning, stay within the measured floors', () => {
    const full = measure(bench.validation, 'full', (t) => selectKnowledge(pool, t));
    expect(full.recall).toBeGreaterThanOrEqual(0.98);
    expect(full.perTask).toBeLessThanOrEqual(6.5);
    const tuningBrief = measure(bench.tuning, 'brief', (t) => selectKnowledge(pool, t));
    expect(tuningBrief.recall).toBeGreaterThanOrEqual(0.8);
    expect(tuningBrief.recall).toBeGreaterThan(measure(bench.tuning, 'brief', scopeOnly).recall);
    const tuningFull = measure(bench.tuning, 'full', (t) => selectKnowledge(pool, t));
    expect(tuningFull.recall).toBeGreaterThanOrEqual(0.9);
    expect(tuningFull.perTask).toBeLessThanOrEqual(6);
  });
});
