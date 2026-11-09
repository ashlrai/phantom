/** Dry-run release sequencing over reported observations. No effect authority. */
import { buildEcosystemReleasePlan } from '../ecosystem/release-plan.js';

/** The planner's reviewed workflow paths are descriptions, not dispatch instructions. */
export function planReleaseDispatch(snapshot: unknown, nowMs: number, registry: unknown, repository: string) {
  return planReleaseDispatchFromPlan(buildEcosystemReleasePlan(snapshot, nowMs, registry), repository);
}

/** Project an already validated ecosystem plan without retaining caller-owned data. */
export function planReleaseDispatchFromPlan(plan: ReturnType<typeof buildEcosystemReleasePlan>, repository: string) {
  if (!/^ashlrai\/[a-z0-9][a-z0-9-]*$/.test(repository)) throw new Error('Invalid repository');
  const repo = plan.repositories.find(row => row.repository === repository);
  if (!repo) throw new Error('Repository not in release plan');
  // Never echo caller-supplied blocker text, which could contain sensitive data.
  const ownerBlockers = new Set(repo.ownership?.blockers ?? []);
  const holds = (items: string[]) => [...new Set(items.map(item => ownerBlockers.has(item) ? 'owner-hold' : item))].sort();
  const stages = repo.tasks.map(task => ({
    id: task.id.slice(repository.length + 1),
    dependsOn: task.dependsOn.map(dep => dep.slice(repository.length + 1)),
    workflow: task.workflow,
    purpose: task.purpose,
    status: task.status,
    holds: holds(task.holds),
  }));
  return {
    schema: 'phantom-release-dispatch-dry-run/v1' as const,
    dryRun: true as const, executable: false as const, releaseAuthorized: false as const,
    evidenceBasis: plan.evidenceBasis, observedAt: plan.observedAt, plannedAt: plan.plannedAt,
    repository: repo.repository, sourceSha: repo.sourceSha, version: repo.version,
    reviewedContract: repo.reviewedContract, holds: holds(repo.holds), stages,
    next: stages.find(stage => stage.status === 'pending-independent-verification')?.id ?? null,
    limitations: ['Reported observations are not verified evidence or a grant.',
      'Version changes, tagging, build, publication, verification and announcements require their existing sanctioned paths and independent authorization.'],
  };
}
