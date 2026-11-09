import { describe, expect, it } from 'vitest';
import {
  parseResearchProposals, planResearchDigest, priorityForScore, renderReadyLine, scoreProposal,
  type DraftProposal,
} from '../src/core/research/proposals.js';
import { lintRestockLine } from '../src/core/portfolio/restock-lint.js';

const NOW = new Date('2026-11-08T12:00:00Z');
const lint = { isDir: () => true, reposRoot: '/tmp/fleet' };

const digest = `# Fleet research digest

## S1 — Spawn fleet model
- Checked: 2026-11-08.
- Source: [writeup](https://simonwillison.net/2026/oct/29/how-i-built-the-most-ai-pilled-company-in-the-world/)
- Takeaway: Production signals become work via a triage agent.

## S2 — Anthropic effective agents
- Checked: 2026-11-08.
- Source: [post](https://www.anthropic.com/research/building-effective-agents)

## Proposals

- RQ-TEST-ONE | S1,S2 | impact=4 effort=m confidence=high | Add triage mapping in src/core/fleet/lane-health.ts for flagged lanes. | Acceptance: npx vitest run test/lane-health.test.ts passes.
- RQ-TEST-TWO | S1 | impact=4 effort=s confidence=medium repo=phantom pool=devin tier=mid | Note a field in src/cli/fleet-eval-report.ts. | Acceptance: npm run check:docs passes.
- RQ-TEST-LOW | S2 | impact=1 effort=l confidence=low | Rejigger src/cli/queue.ts defaults. | Acceptance: npx vitest run test/queue.test.ts passes.
`;

const options = { now: NOW, digestLabel: 'fleet-digest-2026-11-08.md', lint };

describe('parseResearchProposals', () => {
  it('parses valid bullets with defaults and per-field overrides', () => {
    const { proposals, drops } = parseResearchProposals(digest);
    expect(drops).toEqual([]);
    expect(proposals.map(p => p.id)).toEqual(['RQ-TEST-ONE', 'RQ-TEST-TWO', 'RQ-TEST-LOW']);
    expect(proposals[0]).toMatchObject({ sources: ['S1', 'S2'], repo: 'phantom', pool: 'codex-personal', tier: 'work', impact: 4, effort: 'm', confidence: 'high' });
    expect(proposals[1]).toMatchObject({ pool: 'devin', tier: 'mid' });
    expect(proposals[0]!.scope).toContain('lane-health.ts');
    expect(proposals[0]!.acceptance).toContain('vitest');
  });

  it('accepts sources= field spelling', () => {
    const text = `${digest}- RQ-TEST-NAMED | sources=S1 | impact=3 effort=s confidence=low | Edit src/cli/queue.ts. | Acceptance: npm run check:docs.\n`;
    const { proposals } = parseResearchProposals(text);
    expect(proposals.at(-1)).toMatchObject({ id: 'RQ-TEST-NAMED', sources: ['S1'] });
  });

  it('drops malformed bullets with reasons', () => {
    const bad = `## Proposals\n` +
      `- NOTRQ | S1 | impact=3 effort=s confidence=high | edit src/a.ts. | Acceptance: npm test.\n` +
      `- RQ-NOSRC | | impact=3 effort=s confidence=high | edit src/a.ts. | Acceptance: npm test.\n` +
      `- RQ-BADATTR | S1 | impact=9 effort=s confidence=high | edit src/a.ts. | Acceptance: npm test.\n` +
      `- RQ-MISSING | S1 | impact=3 effort=s confidence=high | edit src/a.ts.\n` +
      `- RQ-EMDASH | S1 | impact=3 effort=s confidence=high | edit src/a.ts\u2014now. | Acceptance: npm test.\n` +
      `- RQ-DUP | S1 | impact=3 effort=s confidence=high | edit src/a.ts. | Acceptance: npm test.\n` +
      `- RQ-DUP | S1 | impact=3 effort=s confidence=high | edit src/b.ts. | Acceptance: npm test.\n`;
    const { proposals, drops } = parseResearchProposals(bad);
    expect(proposals.map(p => p.id)).toEqual(['RQ-DUP']);
    const reasons = drops.map(d => d.reasons.join(','));
    expect(reasons.join(' ')).toMatch(/bad-id/);
    expect(reasons.join(' ')).toMatch(/missing-sources/);
    expect(reasons.join(' ')).toMatch(/bad-attr:impact/);
    expect(reasons.join(' ')).toMatch(/missing-acceptance/);
    expect(reasons.join(' ')).toMatch(/unsafe-scope/);
    expect(reasons.join(' ')).toMatch(/duplicate-id/);
    expect(drops.every(d => d.stage === 'parse' || (d.stage === 'dedup' && d.reasons[0] === 'duplicate-id'))).toBe(true);
  });
});

describe('scoring and rendering', () => {
  const draft: DraftProposal = {
    id: 'RQ-X', sources: ['S1'], repo: 'phantom', pool: 'codex-personal', tier: 'work',
    impact: 4, effort: 'm', confidence: 'high',
    scope: 'Edit src/a.ts.', acceptance: 'npm test.', line: 1,
  };

  it('computes impact x confidence - effort deterministically', () => {
    expect(scoreProposal(draft)).toBe(3.5);
    expect(scoreProposal({ ...draft, confidence: 'medium' })).toBe(1.9);
    expect(scoreProposal({ ...draft, confidence: 'low', effort: 'l' })).toBe(0.2);
    expect(scoreProposal({ ...draft, impact: 5, effort: 's' })).toBe(5);
  });

  it('maps score to priority, never P0', () => {
    expect(priorityForScore(5)).toBe('P1');
    expect(priorityForScore(4)).toBe('P1');
    expect(priorityForScore(2.9)).toBe('P2');
    expect(priorityForScore(2)).toBe('P2');
    expect(priorityForScore(1.9)).toBe('P3');
  });

  it('renders a READY line that passes the admission lint', () => {
    const scored = { ...draft, score: 3.5, priority: 'P2' };
    const line = renderReadyLine(scored, 'digest.md');
    expect(line).toBe('- READY RQ-X (P2, pool=codex-personal, tier=work, repo=phantom, after none, research-digest): Edit src/a.ts. Acceptance: npm test. Provenance: digest.md S1; score 3.5.');
    const verdict = lintRestockLine(line, 1, lint);
    expect('candidate' in verdict).toBe(true);
  });
});

describe('planResearchDigest', () => {
  it('admits scored proposals above min-score, sorted by score', () => {
    const plan = planResearchDigest(digest, options);
    expect(plan.ok).toBe(true);
    expect(plan.candidates).toBe(3);
    expect(plan.proposals.map(p => p.id)).toEqual(['RQ-TEST-ONE', 'RQ-TEST-TWO']);
    expect(plan.proposals[0]!.score).toBe(3.5);
    expect(plan.proposals[0]!.priority).toBe('P2');
    expect(plan.drops.some(d => d.stage === 'score' && d.id === 'RQ-TEST-LOW')).toBe(true);
    expect(plan.sources.total).toBe(2);
  });

  it('drops proposals citing unknown sources', () => {
    const text = `${digest}- RQ-TEST-GHOST | S9 | impact=5 effort=s confidence=high | Edit src/a.ts. | Acceptance: npm test.\n`;
    const plan = planResearchDigest(text, options);
    expect(plan.drops).toContainEqual(expect.objectContaining({ id: 'RQ-TEST-GHOST', reasons: ['unknown-source:S9'] }));
  });

  it('dedups job ids already in the queue or shipped corpus', () => {
    const queue = '- READY RQ-TEST-ONE (P2, pool=codex-personal, tier=work, repo=phantom): existing work on src/a.ts.';
    const plan = planResearchDigest(digest, { ...options, queue });
    expect(plan.proposals.map(p => p.id)).toEqual(['RQ-TEST-TWO']);
    expect(plan.drops).toContainEqual(expect.objectContaining({ id: 'RQ-TEST-ONE', stage: 'dedup', reasons: ['duplicate-id'] }));
    const shippedPlan = planResearchDigest(digest, { ...options, shipped: ['RQ-TEST-TWO merged in #4100'] });
    expect(shippedPlan.drops).toContainEqual(expect.objectContaining({ id: 'RQ-TEST-TWO', stage: 'dedup', reasons: ['duplicate-id'] }));
  });

  it('dedups overlapping scope text against corpus and earlier proposals', () => {
    const queue = '- READY RQ-OTHER (P2, pool=x, tier=work, repo=phantom): Add triage mapping in src/core/fleet/lane-health.ts for flagged lanes done earlier.';
    const plan = planResearchDigest(digest, { ...options, queue });
    const hit = plan.drops.find(d => d.id === 'RQ-TEST-ONE');
    expect(hit).toMatchObject({ stage: 'dedup', reasons: ['overlap'], match: { origin: 'queue', line: 1 } });
    const doubled = `${digest}- RQ-TEST-COPY | S1 | impact=5 effort=s confidence=high | Add triage mapping in src/core/fleet/lane-health.ts for flagged lanes. | Acceptance: npx vitest run.\n`;
    const plan2 = planResearchDigest(doubled, options);
    expect(plan2.drops).toContainEqual(expect.objectContaining({ id: 'RQ-TEST-COPY', stage: 'dedup', reasons: ['overlap'], match: expect.objectContaining({ origin: 'digest' }) }));
  });

  it('reports lint rejects as drops with reasons', () => {
    const text = `${digest}- RQ-TEST-GH | S1 | impact=5 effort=s confidence=high | Edit .github/workflows/ci.yml. | Acceptance: npm test.\n`;
    const plan = planResearchDigest(text, options);
    expect(plan.drops).toContainEqual(expect.objectContaining({ id: 'RQ-TEST-GH', stage: 'lint', reasons: expect.arrayContaining(['github-protected']) }));
  });

  it('bounds output by limit and honors min-score', () => {
    expect(planResearchDigest(digest, { ...options, limit: 1 }).proposals).toHaveLength(1);
    expect(planResearchDigest(digest, { ...options, minScore: 4 }).proposals).toHaveLength(0);
    expect(planResearchDigest(digest, { ...options, limit: 0 }).proposals).toHaveLength(0);
  });
});
