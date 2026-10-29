import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import { runStatus } from './live-model.js';

/** Observation-only graph contract. Membership never implies task dependencies. */
export interface WorkspaceGraphV1 {
  schema: 'graph.v1';
  observedAt: string;
  state: FleetLiveSnapshotV1['state'];
  nodes: Array<{ id: string; kind: 'repository' | 'run'; label: string; state: string }>;
  edges: Array<{ id: string; from: string; to: string; kind: 'contains' }>;
  inbox: Array<{ id: string; nodeId: string; message: string; nextEligibleAt: string | null }>;
}

export function workspaceGraph(live: FleetLiveSnapshotV1): WorkspaceGraphV1 {
  const repositories = [...new Set(live.runs.map(run => run.repo))].sort();
  const repoId = (repo: string) => `repository:${repo}`;
  const runId = (id: string) => `run:${id}`;
  return {
    schema: 'graph.v1', observedAt: live.generatedAt, state: live.state,
    nodes: [
      ...repositories.map(repo => ({ id: repoId(repo), kind: 'repository' as const, label: repo, state: 'recorded' })),
      ...live.runs.map(run => ({ id: runId(run.id), kind: 'run' as const, label: run.title, state: runStatus(run) })),
    ],
    edges: live.runs.map(run => ({ id: runId(run.id), from: repoId(run.repo), to: runId(run.id), kind: 'contains' })),
    inbox: live.runs.flatMap(run => run.hold ? [{ id: runId(run.id), nodeId: runId(run.id), message: run.hold.reason, nextEligibleAt: run.hold.nextEligibleAt }] : []),
  };
}
