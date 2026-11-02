import { describe, expect, it } from 'vitest';
import { buildRunsGraph, nodeAction, type RunsData } from './runs-graph-model.js';

const runs: RunsData = {
  v: 1, workers: [{ job: 'RQ-PHX-FOO', lane: 'codex', repo: 'ashlrai/phantom' }], leaders: [{ name: 'Leader' }],
  lanes: [{ id: 'codex', running: 1, target: 2 }], mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 1719 }] }, switches: [],
};
const graph = buildRunsGraph(runs, 0);
const merge = graph.nodes.find(node => node.data?.number === 1719)!;

describe('selected node actions', () => {
  it('maps jobs, lanes, and individual merges to their actions', () => {
    expect(nodeAction(graph, 'run:RQ-PHX-FOO', runs)).toEqual({ kind: 'log', job: 'RQ-PHX-FOO' });
    expect(nodeAction(graph, 'lane:codex', runs)).toEqual({ kind: 'lanes', lane: 'codex' });
    expect(nodeAction(graph, merge.id, runs)).toEqual({ kind: 'pr', url: 'https://github.com/ashlrai/phantom/pull/1719', label: 'Open PR #1719' });
    expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'run:RQ-PHX-FOO', to: merge.id })]));
  });
  it('has no action for leaders, overflow, aggregate merges, or missing nodes', () => {
    const leader = graph.nodes.find(node => node.kind === 'leader')!;
    const overflowRuns = { ...runs, workers: Array.from({ length: 61 }, (_, i) => ({ job: `JOB-${i}`, lane: 'codex' })) };
    const overflowGraph = buildRunsGraph(overflowRuns, 0);
    const overflow = overflowGraph.nodes.find(node => node.kind === 'overflow')!;
    expect(nodeAction(graph, leader.id, runs)).toBeNull();
    expect(nodeAction(overflowGraph, overflow.id, overflowRuns)).toBeNull();
    expect(nodeAction(graph, 'merged:last-hour', runs)).toBeNull();
    expect(nodeAction(graph, null, runs)).toBeNull();
    expect(nodeAction(graph, 'missing', runs)).toBeNull();
  });
  it('rejects invalid jobs, repositories and PR numbers', () => {
    const badRuns = { ...runs, workers: [{ job: '../bad', lane: 'codex' }] };
    expect(nodeAction(buildRunsGraph(badRuns, 0), 'run:../bad', badRuns)).toBeNull();
    for (const [repo, number] of [['evil.com/a/b', 1], ['../phantom', 1], ['ashlrai/phantom', 0], ['ashlrai/phantom', 1.5], ['ashlrai/phantom', Number.MAX_SAFE_INTEGER + 1]] as const) {
      const badGraph = { ...graph, nodes: [{ ...merge, data: { repo, number } }] };
      expect(nodeAction(badGraph, merge.id, runs)).toBeNull();
    }
  });
});
