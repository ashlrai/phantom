import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Job {
  id: string;
  title: string;
  parent: string;
  repo: string;
  priority: string;
  tier: string;
  status: string;
  dependsOn: string[];
  capabilities: string[];
  entrypoints: string[];
  problem: string;
  deliverable: string;
  acceptance: string[];
  validation: string[];
  ownerReviewRequired: boolean;
  nonGoals: string[];
}
const root = resolve(import.meta.dirname, '..');
const plan = JSON.parse(readFileSync(resolve(root, 'docs/plans/chat-first-north-star.json'), 'utf8')) as {
  schemaVersion: number; id: string; repo: string; status: string;
  sourceDocuments: string[]; capabilities: string[]; jobs: Job[];
};
const byId = new Map(plan.jobs.map(job => [job.id, job]));

// A broken planning graph should fail before its jobs are copied into a queue.
function ancestors(id: string, visiting = new Set<string>()): Set<string> {
  if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
  const job = byId.get(id);
  if (!job) throw new Error(`Unknown dependency ${id}`);
  const next = new Set([...visiting, id]);
  return new Set(job.dependsOn.flatMap(dep => [dep, ...ancestors(dep, next)]));
}

describe('chat-first north-star planning handoff', () => {
  it('retains a versioned planning-only parent and unique queue identities', () => {
    expect(plan).toMatchObject({ schemaVersion: 1, id: 'RQ-PLAN-NORTHSTAR', repo: 'phantom', status: 'planning-only' });
    expect(byId.size).toBe(plan.jobs.length);
    expect(plan.jobs.length).toBeGreaterThan(1);
    for (const job of plan.jobs) {
      expect(job.id).toMatch(/^RQ-NS-[A-Z-]+$/);
      expect(job).toMatchObject({ parent: plan.id, repo: plan.repo, tier: 'frontier', status: 'planned' });
      expect(['P1', 'P2']).toContain(job.priority);
    }
  });

  it('requires actionable scope, acceptance, verification and authority boundaries for every child', () => {
    for (const job of plan.jobs) {
      expect(job.title.trim().length, job.id).toBeGreaterThan(10);
      expect(job.problem.length, job.id).toBeGreaterThan(40);
      expect(job.deliverable.length, job.id).toBeGreaterThan(40);
      expect(job.acceptance.length, job.id).toBeGreaterThanOrEqual(3);
      expect(job.validation.length, job.id).toBeGreaterThanOrEqual(2);
      expect(job.nonGoals.length, job.id).toBeGreaterThan(0);
      for (const text of [...job.acceptance, ...job.validation, ...job.nonGoals]) {
        expect(text.trim().length, job.id).toBeGreaterThan(20);
        expect(text, job.id).not.toMatch(/\b(TODO|TBD)\b/);
      }
      expect(typeof job.ownerReviewRequired).toBe('boolean');
    }
    expect(byId.get('RQ-NS-DELEGATE')?.ownerReviewRequired).toBe(true);
  });

  it('has a resolvable acyclic graph rooted in the shared contract', () => {
    expect(plan.jobs.filter(job => job.dependsOn.length === 0).map(job => job.id)).toEqual(['RQ-NS-CONTRACT']);
    for (const job of plan.jobs) {
      expect(new Set(job.dependsOn).size, job.id).toBe(job.dependsOn.length);
      const upstream = ancestors(job.id);
      if (job.id !== 'RQ-NS-CONTRACT') expect(upstream.has('RQ-NS-CONTRACT'), job.id).toBe(true);
    }
  });

  it('requires combined acceptance after every implementation child', () => {
    const upstream = ancestors('RQ-NS-ACCEPT');
    expect([...upstream].sort()).toEqual(plan.jobs.map(job => job.id).filter(id => id !== 'RQ-NS-ACCEPT').sort());
    expect(plan.jobs.some(job => job.dependsOn.includes('RQ-NS-ACCEPT'))).toBe(false);
  });

  it('covers the complete journey without unrecognized capability labels', () => {
    const required = ['journey', 'onboarding', 'continuity', 'context', 'delegation', 'progress', 'review', 'resources', 'composition', 'learning', 'integration'];
    expect([...plan.capabilities].sort()).toEqual([...required].sort());
    const covered = new Set(plan.jobs.flatMap(job => job.capabilities));
    expect([...covered].sort()).toEqual([...required].sort());
    for (const job of plan.jobs) expect(job.capabilities.length, job.id).toBeGreaterThan(0);
  });

  it('points to existing repository evidence and documents every queue identity', () => {
    const guide = readFileSync(resolve(root, 'docs/plans/CHAT-FIRST-NORTH-STAR.md'), 'utf8');
    for (const job of plan.jobs) {
      expect(job.entrypoints.length, job.id).toBeGreaterThan(0);
      expect(guide, job.id).toContain(job.id);
    }
    for (const path of [...plan.sourceDocuments, ...plan.jobs.flatMap(job => job.entrypoints)]) {
      expect(path).not.toMatch(/(^\/|\.\.|\\)/);
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }
  });
});
