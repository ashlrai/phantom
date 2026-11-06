import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Job {
  id: string;
  parent: string;
  component: string;
  status: string;
  identity: string;
  repo: string;
  pool: string;
  tier: string;
  priority: string;
  dependsOn: string[];
  externalDependsOn: string[];
  dispatchGate: string;
  scope: string[];
  acceptance: string[];
  testFiles: string[];
}
interface Plan {
  schemaVersion: number;
  id: string;
  status: string;
  parents: { id: string; evidenceKind: string; source: string | null; scope: string }[];
  externalPrerequisites: { id: string; acceptance: string }[];
  sharedAcceptance: string[];
  jobs: Job[];
}
const plan: Plan = JSON.parse(readFileSync(new URL('../workplans/2026-10-26-queue-network/children.json', import.meta.url), 'utf8'));
const byId = new Map(plan.jobs.map((job) => [job.id, job]));

function ancestors(id: string, active = new Set<string>()): Set<string> {
  if (active.has(id)) throw new Error(`Dependency cycle at ${id}`);
  const job = byId.get(id);
  if (!job) throw new Error(`Unknown dependency ${id}`);
  const next = new Set([...active, id]);
  return new Set(job.dependsOn.flatMap((dep) => [dep, ...ancestors(dep, next)]));
}

describe('queue-network planning handoff', () => {
  it('splits the RQ-PLAN-QUEUE parent into 8-20 children with unique identities', () => {
    expect(plan.schemaVersion).toBe(1);
    expect(plan.id).toBe('RQ-PLAN-QUEUE');
    expect(plan.status).toBe('proposed-not-enqueued');
    expect(plan.parents.map((p) => p.id)).toEqual(['RQ-PLAN-QUEUE']);
    expect(plan.jobs.length).toBeGreaterThanOrEqual(8);
    expect(plan.jobs.length).toBeLessThanOrEqual(20);
    expect(byId.size).toBe(plan.jobs.length);
    for (const job of plan.jobs) {
      expect(job.parent).toBe('RQ-PLAN-QUEUE');
      expect(job.id).toMatch(/^RQ-QN-\d{2}$/);
      expect(job.status).toBe('proposed');
      expect(job.identity).toBe('proposed');
      expect(job.repo).toBe('phantom');
      expect(job.pool).toBe('codex-cmp');
      expect(job.tier).toBe('frontier');
      expect(['P0', 'P1', 'P2']).toContain(job.priority);
    }
  });

  it('covers every component named in the parent task', () => {
    const components = new Set(plan.jobs.map((job) => job.component));
    for (const required of ['schema', 'emitters', 'estimator', 'controller', 'lp-bandit', 'desktop-graph', 'tests']) {
      expect(components.has(required), `missing component ${required}`).toBe(true);
    }
  });

  it('has a closed acyclic dependency graph with no repeated edges', () => {
    for (const job of plan.jobs) {
      expect(new Set(job.dependsOn).size).toBe(job.dependsOn.length);
      expect(job.dependsOn).not.toContain(job.id);
      expect(() => ancestors(job.id)).not.toThrow();
    }
  });

  it('gives every job scoped files, substantive acceptance and executable test targets', () => {
    for (const job of plan.jobs) {
      expect(job.acceptance.length).toBeGreaterThanOrEqual(2);
      expect(job.acceptance.every((item) => item.length > 30)).toBe(true);
      expect(job.scope.length).toBeGreaterThan(0);
      expect(job.testFiles.length).toBeGreaterThan(0);
      for (const file of job.testFiles) {
        expect(file).toMatch(/^(test\/[a-z0-9-]+\.test\.ts|src\/web-ui\/.+\.test\.tsx)$/);
      }
      for (const file of [...job.scope, ...job.testFiles]) {
        expect(file).not.toMatch(/(^\/|\.\.|\.github|CODEOWNERS|package\.json|CHANGELOG)/);
      }
    }
  });

  it('orders contract before observation, observation before estimation, and estimation before advisory surfaces', () => {
    expect(byId.get('RQ-QN-01')?.dependsOn).toEqual([]);
    for (const id of ['RQ-QN-02', 'RQ-QN-03']) expect(ancestors(id).has('RQ-QN-01')).toBe(true);
    expect(ancestors('RQ-QN-04').has('RQ-QN-03')).toBe(true);
    for (const id of ['RQ-QN-05', 'RQ-QN-07', 'RQ-QN-10']) expect(ancestors(id).has('RQ-QN-04')).toBe(true);
    for (const id of ['RQ-QN-06', 'RQ-QN-08']) expect(ancestors(id).has('RQ-QN-05')).toBe(true);
    for (const id of ['RQ-QN-06', 'RQ-QN-08']) expect(ancestors(id).has('RQ-QN-02')).toBe(true);
    expect(ancestors('RQ-QN-09').has('RQ-QN-08')).toBe(true);
    for (const id of ['RQ-QN-03', 'RQ-QN-06', 'RQ-QN-07']) expect(ancestors('RQ-QN-11').has(id)).toBe(true);
  });

  it('requires every other child before final shadow integration', () => {
    const integration = 'RQ-QN-12';
    expect([...ancestors(integration)].sort()).toEqual(plan.jobs.filter((j) => j.id !== integration).map((j) => j.id).sort());
  });

  it('separates queue reconciliation, owner-lane and flag-rollout prerequisites', () => {
    expect(plan.externalPrerequisites.map((p) => p.id).sort()).toEqual(['flag-rollout', 'owner-lane', 'queue-reconciliation']);
    const known = plan.externalPrerequisites.map((p) => p.id);
    for (const job of plan.jobs) {
      expect(['queue-reconciliation', 'owner-lane']).toContain(job.dispatchGate);
      expect(job.externalDependsOn).toContain('queue-reconciliation');
      for (const id of job.externalDependsOn) expect(known).toContain(id);
      if (job.dispatchGate === 'owner-lane') {
        expect(job.externalDependsOn).toContain('owner-lane');
        expect(job.externalDependsOn).toContain('flag-rollout');
      }
      if (job.scope.some((p) => /\/(dispatch-router|backpressure)\.ts$/.test(p))) {
        expect(job.dispatchGate).toBe('owner-lane');
      }
    }
    // Only the integration job may touch protected dispatch seams.
    for (const job of plan.jobs) {
      if (job.id === 'RQ-QN-12') continue;
      expect(job.scope.every((p) => !/\/(dispatch-router|backpressure)\.ts$/.test(p))).toBe(true);
    }
  });

  it('keeps the model advisory and metadata-only across the whole backlog', () => {
    const shared = plan.sharedAcceptance.join('\n');
    for (const required of ['temporary HOME', 'Phantom Secrets', 'Locus', 'npm run typecheck', 'npm run lint',
      'npm run check:docs', 'npx vitest run', 'BRIDGE_NOTES.md', 'toolsUsed', 'metadata-only', 'advisory',
      'flag-off', 'Reconcile']) {
      expect(shared).toContain(required);
    }
    const parentScope = plan.parents[0]?.scope ?? '';
    for (const named of ['schema', 'emitters', 'estimator', 'controller', 'LP/bandit', 'desktop graph', 'tests']) {
      expect(parentScope.toLowerCase()).toContain(named.toLowerCase());
    }
  });
});
