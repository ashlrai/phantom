import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDocumentation } from '../scripts/check-documentation.mjs';

interface Move {
  id: string;
  rank: number;
  title: string;
  pillar: string;
  priority: string;
  tier: string;
  status: string;
  dependsOn: string[];
  spec?: string;
  entrypoints: string[];
  rationale: string;
  deliverable: string;
  acceptance: string[];
  validation: string[];
  ownerReviewRequired: boolean;
  nonGoals: string[];
}
const root = resolve(import.meta.dirname, '..');
const plan = JSON.parse(readFileSync(resolve(root, 'docs/plans/vision-next.json'), 'utf8')) as {
  schemaVersion: number; id: string; repo: string; status: string; asOf: string;
  sourceDocuments: string[]; objective: string; moves: Move[];
};
const byId = new Map(plan.moves.map(move => [move.id, move]));
const vision = readFileSync(resolve(root, 'docs/VISION-NEXT.md'), 'utf8');
const SPEC_DOCS = plan.moves.flatMap(move => (move.spec ? [move.spec] : []));

function ancestors(id: string, visiting = new Set<string>()): Set<string> {
  if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
  const move = byId.get(id);
  if (!move) throw new Error(`Unknown dependency ${id}`);
  const next = new Set([...visiting, id]);
  return new Set(move.dependsOn.flatMap(dep => [dep, ...ancestors(dep, next)]));
}

describe('vision-next ranked roadmap', () => {
  it('is a versioned planning-only parent with ten uniquely ranked moves', () => {
    expect(plan).toMatchObject({ schemaVersion: 1, id: 'RQ-PLAN-VISION-NEXT', repo: 'phantom', status: 'planning-only' });
    expect(plan.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(plan.objective.length).toBeGreaterThan(80);
    expect(byId.size).toBe(plan.moves.length);
    expect(plan.moves.map(move => move.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const move of plan.moves) {
      expect(move.id).toMatch(/^RQ-VN-[A-Z-]+$/);
      expect(move).toMatchObject({ tier: 'frontier', status: 'planned' });
      expect(['P1', 'P2']).toContain(move.priority);
      expect(['foundation', 'recursive-self-improvement', 'product-factory', 'composition-platform']).toContain(move.pillar);
    }
  });

  it('gives every move a rationale, deliverable, acceptance, validation and boundaries', () => {
    for (const move of plan.moves) {
      expect(move.title.trim().length, move.id).toBeGreaterThan(10);
      expect(move.rationale.length, move.id).toBeGreaterThan(120);
      expect(move.deliverable.length, move.id).toBeGreaterThan(60);
      expect(move.acceptance.length, move.id).toBeGreaterThanOrEqual(3);
      expect(move.validation.length, move.id).toBeGreaterThanOrEqual(1);
      expect(move.nonGoals.length, move.id).toBeGreaterThan(0);
      for (const text of [...move.acceptance, ...move.validation, ...move.nonGoals]) {
        expect(text.trim().length, move.id).toBeGreaterThan(20);
        expect(text, move.id).not.toMatch(/\b(TODO|TBD)\b/);
      }
      expect(typeof move.ownerReviewRequired, move.id).toBe('boolean');
    }
    // Moves that change live admission, authority evidence, self-modification
    // or enrollment must stay owner-reviewed.
    for (const id of ['RQ-VN-CONVERGE', 'RQ-VN-LADDER', 'RQ-VN-HARNESS-RSI', 'RQ-VN-PRODUCT']) {
      expect(byId.get(id)?.ownerReviewRequired, id).toBe(true);
    }
  });

  it('has an acyclic graph whose rank order is a valid build order', () => {
    const roots = plan.moves.filter(move => move.dependsOn.length === 0).map(move => move.id);
    expect(roots).toEqual(['RQ-VN-ATTEMPT-ID', 'RQ-VN-LANDED-INTENT']);
    for (const move of plan.moves) {
      expect(new Set(move.dependsOn).size, move.id).toBe(move.dependsOn.length);
      for (const dep of move.dependsOn) expect(byId.get(dep)!.rank, `${move.id} <- ${dep}`).toBeLessThan(move.rank);
      ancestors(move.id);
    }
    // Every learning or product move rests on exact attempt attribution.
    for (const move of plan.moves.filter(m => m.rank >= 4)) {
      expect(ancestors(move.id).has('RQ-VN-ATTEMPT-ID'), move.id).toBe(true);
    }
  });

  it('ships implementable specs for exactly the top three moves', () => {
    const specified = plan.moves.filter(move => move.spec).map(move => move.rank);
    expect(specified).toEqual([1, 2, 3]);
    for (const move of plan.moves.filter(m => m.spec)) {
      const spec = readFileSync(resolve(root, move.spec!), 'utf8');
      expect(spec, move.id).toContain(move.id);
      for (const heading of ['## Problem', '## Design', '## Acceptance', '## Validation']) {
        expect(spec, `${move.id} ${heading}`).toContain(heading);
      }
      expect(vision, move.id).toContain(move.spec!.replace(/^docs\//, ''));
    }
  });

  it('points at existing repository evidence and names every move in the guide', () => {
    for (const move of plan.moves) {
      expect(move.entrypoints.length, move.id).toBeGreaterThan(0);
      expect(vision, move.id).toContain(move.id);
    }
    for (const path of [...plan.sourceDocuments, ...plan.moves.flatMap(move => move.entrypoints)]) {
      expect(path).not.toMatch(/(^\/|\.\.|\\)/);
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }
  });

  it('keeps every link and anchor in the guide and specs resolvable', () => {
    const result = checkDocumentation({ root, entrypoints: ['docs/VISION-NEXT.md', ...SPEC_DOCS] });
    expect(result.errors).toEqual([]);
    expect(result.localLinks).toBeGreaterThan(10);
    expect(result.externalRequests).toBe(0);
  });

  it('is reachable from the north star', () => {
    const northStar = readFileSync(resolve(root, 'docs/NORTH-STAR.md'), 'utf8');
    expect(northStar).toContain('https://github.com/ashlrai/phantom/blob/master/docs/VISION-NEXT.md');
  });
});
