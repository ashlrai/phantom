import { describe, expect, it } from 'vitest';
import { buildRunsGraph, filterGraphNodes, filterLabel, type RunsData } from './runs-graph-model.js';

const runs: RunsData = { v: 1, workers: [
  { job: 'RQ-PHX-LANE-1', lane: 'codex-personal', model: 'frontier' },
  { job: 'RQ-PHX-OTHER', lane: 'shared', model: 'mid' },
], leaders: [{ name: 'Captain', lane: 'shared' }], mergesLastHour: { count: 0 }, switches: [] };
const nodes = buildRunsGraph(runs, 0).nodes;
const matches = (query: string) => [...filterGraphNodes(nodes, query).matched];

describe('runs graph filter', () => {
  it('matches ids, labels, lanes, tiers and states without case sensitivity', () => {
    expect(matches('rQ-phx-lane')).toEqual(['run:RQ-PHX-LANE-1']);
    expect(matches('CAPTAIN')).toEqual([nodes.find(node => node.kind === 'leader')!.id]);
    expect(matches('PERSONAL')).toEqual(['lane:codex-personal', 'run:RQ-PHX-LANE-1']);
    expect(matches('Frontier')).toEqual(['run:RQ-PHX-LANE-1']);
    expect(matches('RUNNING')).toEqual(['run:RQ-PHX-LANE-1', 'run:RQ-PHX-OTHER']);
    expect(matches('missing')).toEqual([]);
  });
  it('matches all nodes for empty input and formats partial counts', () => {
    expect(filterGraphNodes(nodes, '')).toEqual({ matched: new Set(nodes.map(node => node.id)), total: 5 });
    expect(matches('  ')).toEqual(nodes.map(node => node.id));
    expect(filterLabel(6, 41)).toBe('6 of 41 nodes');
    expect(filterLabel(0, 41)).toBe('0 of 41 nodes');
    expect(filterLabel(41, 41)).toBe('');
  });
});
