import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Job {
  id: string;
  parent: string;
  status: string;
  identity: string;
  repo: string;
  pool: string;
  tier: string;
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
const plan: Plan = JSON.parse(readFileSync(new URL('../workplans/2026-10-26-graphbus/children.json', import.meta.url), 'utf8'));
const byId = new Map(plan.jobs.map((job) => [job.id, job]));
const parents = ['RQ-GRAPH-1', 'RQ-GRAPH-2', 'RQ-BUS-1', 'RQ-BUS-2', 'RQ-BUS-3', 'RQ-BUS-4', 'RQ-BUS-5', 'RQ-GRAPH-ROUTE'];

function ancestors(id: string, active = new Set<string>()): Set<string> {
  if (active.has(id)) throw new Error(`Dependency cycle at ${id}`);
  const job = byId.get(id);
  if (!job) throw new Error(`Unknown dependency ${id}`);
  const next = new Set([...active, id]);
  return new Set(job.dependsOn.flatMap((dep) => [dep, ...ancestors(dep, next)]));
}

describe('graph/bus planning handoff', () => {
  it('covers exactly the eight requested parents with unique child identities', () => {
    expect(plan.schemaVersion).toBe(1);
    expect(plan.id).toBe('RQ-PLAN-GRAPHBUS');
    expect(plan.parents.map((p) => p.id).sort()).toEqual([...parents].sort());
    expect([...new Set(plan.jobs.map((j) => j.parent))].sort()).toEqual([...parents].sort());
    expect(byId.size).toBe(plan.jobs.length);
    for (const job of plan.jobs) expect(job.id.startsWith(job.parent)).toBe(true);
  });

  it('retains all recovered router child IDs without asserting that they are newly queued', () => {
    expect(plan.status).toBe('proposed-not-enqueued');
    expect(plan.jobs.filter((j) => j.identity === 'recovered').map((j) => j.id).sort()).toEqual([
      'RQ-BUS-1B', 'RQ-BUS-1C', 'RQ-BUS-3A', 'RQ-BUS-3B', 'RQ-BUS-4A', 'RQ-BUS-5A',
      'RQ-GRAPH-ROUTE-A', 'RQ-GRAPH-ROUTE-B',
    ].sort());
    for (const job of plan.jobs) {
      expect(job.status).toBe('proposed');
      expect(job.repo).toBe('phantom');
      expect(job.pool).toBe('codex-personal');
      expect(job.tier).toBe('frontier');
    }
  });

  it('has a closed acyclic dependency graph with no repeated edges', () => {
    for (const job of plan.jobs) {
      expect(new Set(job.dependsOn).size).toBe(job.dependsOn.length);
      expect(() => ancestors(job.id)).not.toThrow();
    }
  });

  it('keeps unavailable parent contracts blocked behind explicit recovery jobs', () => {
    expect(plan.parents.filter((p) => p.evidenceKind === 'missing').map((p) => p.id)).toEqual(['RQ-GRAPH-2', 'RQ-BUS-2']);
    for (const parent of plan.parents) {
      expect(parent.scope.length).toBeGreaterThan(30);
      if (parent.evidenceKind !== 'missing') expect(parent.source).toBeTruthy();
      else {
        expect(parent.source).toBeNull();
        expect(byId.get(`${parent.id}A`)?.dispatchGate).toBe('source-recovery');
        expect(byId.get(`${parent.id}B`)?.dispatchGate).toBe('missing-parent-contract');
        expect(ancestors(`${parent.id}B`).has(`${parent.id}A`)).toBe(true);
      }
    }
  });

  it('gives every concrete job scoped files, acceptance and executable test targets', () => {
    for (const job of plan.jobs) {
      expect(job.acceptance.length).toBeGreaterThanOrEqual(2);
      expect(job.acceptance.every((item) => item.length > 30)).toBe(true);
      if (job.dispatchGate === 'missing-parent-contract') {
        expect(job.scope).toEqual([]);
        expect(job.testFiles).toEqual([]);
      } else {
        expect(job.scope.length).toBeGreaterThan(0);
        expect(job.testFiles.length).toBeGreaterThan(0);
        for (const file of job.testFiles) expect(file).toMatch(/^test\/[a-z0-9-]+\.test\.ts$/);
      }
      for (const file of [...job.scope, ...job.testFiles]) {
        expect(file).not.toMatch(/(^\/|\.\.|\.github|CODEOWNERS|package\.json)/);
      }
    }
  });

  it('separates external wake, queue reconciliation and owner-lane prerequisites', () => {
    expect(plan.externalPrerequisites.map((p) => p.id).sort()).toEqual(['RQ-EVENTD', 'owner-lane', 'queue-reconciliation']);
    for (const job of plan.jobs) {
      expect(['queue-reconciliation', 'owner-lane', 'source-recovery', 'missing-parent-contract']).toContain(job.dispatchGate);
      expect(job.externalDependsOn).toContain('queue-reconciliation');
      for (const id of job.externalDependsOn) expect(plan.externalPrerequisites.map((p) => p.id)).toContain(id);
      if (job.id === 'RQ-BUS-1B') expect(job.externalDependsOn).toContain('RQ-EVENTD');
      if (job.dispatchGate === 'owner-lane') expect(job.externalDependsOn).toContain('owner-lane');
      if (job.scope.some((p) => p.startsWith('src/core/routing/') || /\/(dispatch-router|backpressure)\.ts$/.test(p))) {
        expect(job.dispatchGate).toBe('owner-lane');
      }
    }
  });

  it('orders durable storage before wakes and adapters and telemetry before ranking', () => {
    for (const id of ['RQ-BUS-1B', 'RQ-BUS-1C', 'RQ-BUS-3A', 'RQ-BUS-3B', 'RQ-BUS-4A']) {
      expect(ancestors(id).has('RQ-BUS-1A')).toBe(true);
    }
    for (const id of ['RQ-BUS-3A', 'RQ-BUS-3B', 'RQ-BUS-4A']) expect(ancestors(id).has('RQ-BUS-2A')).toBe(true);
    expect(ancestors('RQ-GRAPH-ROUTE-A').has('RQ-BUS-5A')).toBe(true);
    expect(ancestors('RQ-GRAPH-ROUTE-B').has('RQ-GRAPH-ROUTE-A')).toBe(true);
  });

  it('requires every other child before final cross-parent integration', () => {
    const integration = 'RQ-GRAPH-ROUTE-C';
    expect([...ancestors(integration)].sort()).toEqual(plan.jobs.filter((j) => j.id !== integration).map((j) => j.id).sort());
  });

  it('carries verification and security requirements into every child handoff', () => {
    const shared = plan.sharedAcceptance.join('\n');
    for (const required of ['temporary HOME', 'Phantom Secrets', 'Locus', 'npm run typecheck', 'npm run lint',
      'npm run check:docs', 'npx vitest run', 'BRIDGE_NOTES.md', 'toolsUsed', 'untrusted data', 'Reconcile']) {
      expect(shared).toContain(required);
    }
  });
});
