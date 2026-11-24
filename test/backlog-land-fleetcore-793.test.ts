import { describe, expect, it } from 'vitest';
import { fleetOrgMap, type FleetOrgMap } from '../src/core/fleet/org-map.js';
import { fleetOrgTree, type OrgTreeJob } from '../src/core/fleet/org-tree.js';
import type { FleetSessionV1, FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';

const AT = '2026-11-22T12:00:00Z';
const PR = 'https://github.com/example/fixture/pull/42';
function session(job: string, extra: Partial<FleetSessionV1> = {}): FleetSessionV1 {
  return {
    job, lane: 'codex-personal', repo: 'fixture', model: null, tier: 'work',
    status: 'running', live: 'yes', batchId: null, pid: null, exitCode: null,
    timedOut: false, enqueuedAt: null, claimedAt: null, launchedAt: null,
    startedAt: AT, finishedAt: null, elapsedSeconds: 0, durationSeconds: null,
    queueWaitSeconds: null, tokensTotal: null, wallSeconds: null, diffLines: null,
    outcome: null, prUrl: null, ...extra,
  };
}
function map(rows: FleetSessionV1[], recent: FleetSessionV1[] = []): FleetOrgMap {
  const sessions: FleetSessionsV1 = {
    schema: 'fleet.sessions.v1', generatedAt: AT, sourceState: 'healthy',
    runsDirPresent: true, dispatcher: null,
    sources: { runDir: 'healthy', ready: 'healthy', claimed: 'healthy', precheck: 'healthy', status: 'healthy', metrics: 'healthy', live: 'healthy' },
    sessions: rows, recent, truncated: false, malformed: 0,
    counts: { queued: 0, parked: 0, launching: 0, running: rows.length, publishing: 0, exited: 0, stale: 0 },
  };
  return fleetOrgMap(null, { sessions, now: Date.parse(AT) });
}
const jobs = (graph: FleetOrgMap): OrgTreeJob[] => fleetOrgTree(graph).lanes.flatMap(lane => lane.jobs);

describe('preserved organization-tree PR contract (#8352)', () => {
  it('carries each session URL through the map and JSON tree, including published jobs', () => {
    const graph = map([session('RQ-A', { prUrl: PR }), session('RQ-B')], [
      session('RQ-DONE', { status: 'finished', published: true, live: 'no', prUrl: PR + '0' }),
    ]);
    expect(graph.nodes.find(node => node.jobId === 'RQ-A')?.prUrl).toBe(PR);
    const rows = JSON.parse(JSON.stringify(jobs(graph))) as OrgTreeJob[];
    expect(rows.map(row => [row.id, row.prUrl, row.state])).toEqual([
      ['RQ-A', PR, 'running'], ['RQ-B', null, 'running'], ['RQ-DONE', PR + '0', 'done'],
    ]);
  });

  it('serializes explicit unknown URLs for older maps without deriving a link from job facts', () => {
    const graph = map([session('RQ-42', { repo: 'example/fixture' })]);
    const node = graph.nodes.find(row => row.jobId === 'RQ-42')!;
    delete node.prUrl; // Older map servers omit this additive field.
    const [row] = jobs(graph);
    expect(row.prUrl).toBeNull();
    expect(JSON.parse(JSON.stringify(row))).toHaveProperty('prUrl', null);
    expect(row.repo).toBe('example/fixture');
    expect(row.id).toBe('RQ-42');
  });
});
