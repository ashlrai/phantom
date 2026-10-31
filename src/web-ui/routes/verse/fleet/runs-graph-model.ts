import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import type { WorkspaceGraphV1 } from './workspace-graph.js';

export interface RunsData {
  v: 1;
  workers: Array<{ job: string; lane?: string; model?: string; startedAt?: string; repo?: string }>;
  leaders: Array<{ name?: string; lane?: string; model?: string }>;
  lanes?: Array<{ id: string; running: number; target: number }>;
  mergesLastHour: { count: number | null; items?: Array<{ repo?: string; number?: number }> };
  switches: string[];
}
type Node = { id: string; kind: 'leader' | 'lane' | 'run' | 'merged' | 'overflow'; label: string; state: string; title: string; data?: { lane?: string; tier?: string; repo?: string; number?: number } };
export interface RunsGraphModel extends Omit<WorkspaceGraphV1, 'nodes' | 'edges'> {
  nodes: Node[];
  edges: Array<WorkspaceGraphV1['edges'][number] & { title: string; inferred: boolean }>;
  counts: { leaders: number; lanes: number; jobs: number; merges: number | null };
}
const sorted = <T extends { id: string }>(items: T[]): T[] => items.sort((a, b) => a.id.localeCompare(b.id));

export function buildRunsGraph(runs: RunsData, now: number): RunsGraphModel {
  const nodes: Node[] = [];
  const edges: RunsGraphModel['edges'] = [];
  const laneId = (lane?: string) => lane ? `lane:${lane}` : 'unknown-lane';
  const lanes = new Map((runs.lanes ?? []).filter(lane => lane.running > 0).map(lane => [laneId(lane.id), lane.id]));
  for (const worker of runs.workers) lanes.set(laneId(worker.lane), worker.lane ?? 'unknown lane');
  const add = (id: string, kind: Node['kind'], label: string, state: string, title = label, data?: Node['data']) => nodes.push({ id, kind, label, state, title, ...(data ? { data } : {}) });
  const link = (from: string, to: string, inferred = false) => edges.push({ id: JSON.stringify([from, to]), from, to, kind: 'contains', inferred, title: `${from} → ${to}${inferred ? ' (inferred)' : ''}` });
  for (const [id, name] of lanes) {
    const lane = runs.lanes?.find(item => laneId(item.id) === id);
    add(id, 'lane', lane ? `${name} ${lane.running}/${lane.target}` : name, 'recorded', undefined, { lane: name });
  }
  // Sort before assigning duplicate ordinals so producer ordering cannot move nodes.
  const leaders = runs.leaders.map(leader => ({ ...leader, id: JSON.stringify([leader.name ?? null, leader.model ?? null, leader.lane ?? null]) }));
  sorted(leaders).forEach((leader, index) => {
    const id = `leader:${leader.id}:${index}`;
    add(id, 'leader', leader.name ?? leader.model ?? 'Leader', 'recorded', undefined, { lane: leader.lane });
    const matched = leader.lane && lanes.has(laneId(leader.lane));
    for (const lane of lanes.keys()) if (!matched || lane === laneId(leader.lane)) link(id, lane, !matched);
  });
  const merges = (runs.mergesLastHour.items ?? []).filter(item => item.repo !== undefined && item.number !== undefined)
    .map(item => ({ ...item, id: `merged:${JSON.stringify([item.repo, item.number])}` }));
  const uniqueMerges = [...new Map(merges.map(item => [item.id, item])).values()];
  const workers = sorted(runs.workers.map(worker => ({ ...worker, id: `run:${worker.job}` })));
  const overflow = new Map<string, number>();
  workers.forEach((worker, index) => {
    const lane = laneId(worker.lane);
    if (index >= 60) { overflow.set(lane, (overflow.get(lane) ?? 0) + 1); return; }
    const elapsed = worker.startedAt ? now - Date.parse(worker.startedAt) : NaN;
    const title = `${worker.job} · ${worker.lane ?? 'unknown lane'} · ${worker.model ?? 'model not reported'} · ${Number.isFinite(elapsed) ? `${Math.floor(Math.max(0, elapsed) / 60_000)}m elapsed` : 'elapsed not reported'}`;
    add(worker.id, 'run', worker.job, 'running', title, { lane: worker.lane, tier: worker.model });
    link(lane, worker.id);
    if ((runs.mergesLastHour.count ?? 0) > 0 && worker.repo && runs.mergesLastHour.items?.some(item => item.repo === worker.repo)) {
      link(worker.id, 'merged:last-hour');
      for (const merge of uniqueMerges) if (merge.repo === worker.repo) link(worker.id, merge.id);
    }
  });
  for (const [lane, count] of overflow) {
    const id = `overflow:${lane}`;
    add(id, 'overflow', `+${count} more`, 'running', undefined, { lane: lanes.get(lane) }); link(lane, id);
  }
  if ((runs.mergesLastHour.count ?? 0) > 0) {
    add('merged:last-hour', 'merged', `Merged last hour · ${runs.mergesLastHour.count}`, 'merged');
    for (const merge of uniqueMerges) add(merge.id, 'merged', `${merge.repo} #${merge.number}`, 'merged', undefined, { repo: merge.repo, number: merge.number });
  }
  return { schema: 'graph.v1', observedAt: new Date(now).toISOString(), state: 'running', nodes: sorted(nodes), edges: sorted(edges), inbox: [],
    counts: { leaders: leaders.length, lanes: lanes.size, jobs: workers.length, merges: runs.mergesLastHour.count } };
}

export function filterGraphNodes(nodes: RunsGraphModel['nodes'], query: string): { matched: Set<string>; total: number } {
  const term = query.trim().toLowerCase();
  return { matched: new Set(nodes.filter(node => [node.id, node.label, node.data?.lane, node.data?.tier, node.state]
    .some(value => value?.toLowerCase().includes(term))).map(node => node.id)), total: nodes.length };
}

export function filterLabel(matched: number, total: number): string {
  return matched === total ? '' : `${matched} of ${total} nodes`;
}

export function describeRunsGraph(graph: RunsGraphModel): string {
  const { leaders, lanes, jobs, merges } = graph.counts;
  return [[leaders, 'leader'], [lanes, 'lane'], [jobs, 'job'], [merges, 'merge']].map(([count, word]) =>
    count === null ? 'merges unknown' : `${count} ${word}${count === 1 ? '' : 's'}`).join(' · ');
}

/** The renderer's current contract only knows repository/run and contains. */
export function runsWorkspaceGraph(graph: RunsGraphModel): WorkspaceGraphV1 {
  return { ...graph, nodes: graph.nodes.map(node => ({ ...node, kind: node.kind === 'leader' || node.kind === 'lane' ? 'repository' : 'run', state: `${node.kind} · ${node.state}` })) };
}

export function nodeAction(graph: RunsGraphModel, selectedId: string | null, runs: RunsData):
  { kind: 'log'; job: string } | { kind: 'pr'; url: string; label: string } | { kind: 'lanes'; lane: string } | null {
  const node = graph.nodes.find(item => item.id === selectedId);
  if (!node) return null;
  if (node.kind === 'run') {
    const worker = runs.workers.find(item => `run:${item.job}` === node.id);
    return worker && JOB_ID_RE.test(worker.job) ? { kind: 'log', job: worker.job } : null;
  }
  if (node.kind === 'lane' && node.data?.lane) return { kind: 'lanes', lane: node.data.lane };
  if (node.kind === 'merged') {
    const { repo, number } = node.data ?? {};
    if (repo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) && !repo.split('/').some(part => part === '.' || part === '..')
      && typeof number === 'number' && Number.isSafeInteger(number) && number > 0) {
      return { kind: 'pr', url: `https://github.com/${repo}/pull/${number}`, label: `Open PR #${number}` };
    }
  }
  return null;
}
