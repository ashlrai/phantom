/**
 * Committed research digests under docs/research/fleet-digest-*.md are live
 * inputs to `phm fleet research-digest`. Guard them against silent rot: every
 * proposal bullet parses, every S-source record is well formed, every
 * proposal survives scoring/dedup/admission lint, and every repo path a
 * proposal names actually exists (so a digest cannot queue work against a
 * hallucinated file).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHarnessDigest } from '../src/core/learn/harness-digest-reader.js';
import { parseResearchProposals, planResearchDigest } from '../src/core/research/proposals.js';

const ROOT = join(__dirname, '..');
const RESEARCH_DIR = join(ROOT, 'docs', 'research');
const DIGESTS = readdirSync(RESEARCH_DIR).filter(name => /^fleet-digest-\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort();
// Fixed clock after every committed digest date; staleness is irrelevant here.
const NOW = new Date('2026-12-31T00:00:00Z');
const lint = { isDir: () => true, reposRoot: '/nonexistent-fleet-root' };
// Repo-relative paths named in a proposal scope, e.g. src/core/fleet/x.ts.
const REPO_PATH = /\b(?:src|test|docs|scripts|bin|contrib)\/[A-Za-z0-9_./-]*[A-Za-z0-9_]\.[a-z]{2,4}\b/g;

describe('source heading recognition', () => {
  it('ignores prose sections starting with S but still flags malformed source ids', () => {
    const text = [
      '## S1 — Real source', '- Checked: 2026-11-16.', '- Source: [x](https://example.test/1)',
      '## Signals', '- trend', '## Summary', 'text', '## Selected',
      '## S2', '## Sx — Bad id', '## S3 —',
    ].join('\n');
    const digest = parseHarnessDigest(text, NOW);
    expect(digest.sources.map(source => source.id)).toEqual(['S1']);
    expect(digest.issues).toEqual([
      { id: 'S2', code: 'malformed_id' }, { id: 'Sx', code: 'malformed_id' }, { id: 'S3', code: 'malformed_id' },
    ]);
  });
});

describe('committed research digests', () => {
  it('finds at least one fleet digest', () => {
    expect(DIGESTS.length).toBeGreaterThan(0);
  });

  describe.each(DIGESTS)('%s', name => {
    const text = readFileSync(join(RESEARCH_DIR, name), 'utf8');

    it('has well-formed source records with no issues', () => {
      const digest = parseHarnessDigest(text, NOW);
      expect(digest.sources.length).toBeGreaterThan(0);
      expect(digest.issues).toEqual([]);
    });

    it('parses every proposal bullet and admits each through the plan', () => {
      const { proposals, drops } = parseResearchProposals(text);
      expect(drops).toEqual([]);
      expect(proposals.length).toBeGreaterThan(0);
      const plan = planResearchDigest(text, { now: NOW, digestLabel: name, lint, limit: 20, minScore: 0 });
      expect(plan.drops).toEqual([]);
      expect(plan.proposals.map(p => p.id).sort()).toEqual(proposals.map(p => p.id).sort());
    });

    it('names only repo paths that exist', () => {
      const { proposals } = parseResearchProposals(text);
      for (const proposal of proposals) {
        const paths = [...proposal.scope.matchAll(REPO_PATH)].map(match => match[0]);
        expect(paths.length, `${proposal.id} names no repo path`).toBeGreaterThan(0);
        // A proposal may name one new file to create; at least one path must already exist.
        expect(paths.some(path => existsSync(join(ROOT, path))), `${proposal.id}: ${paths.join(', ')}`).toBe(true);
      }
    });
  });
});
