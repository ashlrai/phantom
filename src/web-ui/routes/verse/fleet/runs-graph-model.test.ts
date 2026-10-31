import { describe, expect, it } from 'vitest';
import { buildRunsGraph, describeRunsGraph, type RunsData } from './runs-graph-model.js';
import { narrowRuns } from './runs-graph-queries.js';
const minimal = (): RunsData => ({ v: 1, workers: [{ job: 'job-1' }], leaders: [{}], mergesLastHour: { count: null }, switches: [] });
const now = Date.parse('2026-10-30T12:00:00Z');
describe('runs graph', () => {
  it('handles guaranteed fields, unknown lanes and malformed optional fields', () => {
    const graph = buildRunsGraph(minimal(), now);
    expect(graph.nodes.map(n => n.kind).sort()).toEqual(['lane', 'leader', 'run']);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.find(e => e.from.startsWith('leader:'))?.inferred).toBe(true);
    expect(graph.nodes.find(n => n.kind === 'run')?.title).toContain('elapsed not reported');
    expect(narrowRuns({ ...minimal(), lanes: 'bad', leaders: [null], workers: [{ job: 'job-1', lane: 42 }] })).toEqual({ ...minimal(), leaders: [{ name: undefined, model: undefined, lane: undefined }], lanes: [], workers: [{ job: 'job-1' }], mergesLastHour: { count: null, items: [] } });
    expect(narrowRuns({ ...minimal(), workers: [{}] })).toBeNull();
  });
  it('links explicit lanes and only matching merge repositories', () => {
    const graph = buildRunsGraph({ ...minimal(), leaders: [{ name: 'Lead', lane: 'codex-personal' }],
      lanes: [{ id: 'codex-personal', running: 13, target: 32 }, { id: 'idle', running: 0, target: 2 }],
      workers: [{ job: 'a', lane: 'codex-personal', repo: 'ashlrai/phantom', model: 'codex', startedAt: '2026-10-30T11:58:00Z' }, { job: 'b', repo: 'ashlrai/other' }],
      mergesLastHour: { count: 2, items: [{ repo: 'ashlrai/phantom' }] } }, now);
    expect(graph.nodes.find(n => n.id === 'lane:codex-personal')?.label).toBe('codex-personal 13/32');
    expect(graph.nodes.some(n => n.id === 'lane:idle')).toBe(false);
    expect(graph.edges.filter(e => e.from.startsWith('leader:'))).toEqual([expect.objectContaining({ to: 'lane:codex-personal', inferred: false })]);
    expect(graph.edges.filter(e => e.to === 'merged:last-hour').map(e => e.from)).toEqual(['run:a']);
    expect(graph.nodes.find(n => n.id === 'run:a')?.title).toContain('2m elapsed');
  });
  it('orders deterministically, including leaders without names', () => {
    const data = { ...minimal(), leaders: [{ model: 'z' }, { name: 'a' }, {}], workers: [{ job: 'z', lane: 'z' }, { job: 'a', lane: 'a' }] };
    expect(buildRunsGraph(data, now)).toEqual(buildRunsGraph({ ...data, leaders: [...data.leaders].reverse(), workers: [...data.workers].reverse() }, now));
  });
  it('caps jobs at 60 and collapses overflow per lane, retaining total counts', () => {
    const graph = buildRunsGraph({ ...minimal(), workers: Array.from({ length: 66 }, (_, i) => ({ job: String(i).padStart(3, '0'), lane: i % 2 ? 'a' : 'b' })) }, now);
    expect(graph.nodes.filter(n => n.kind === 'run')).toHaveLength(60);
    expect(graph.nodes.filter(n => n.kind === 'overflow').map(n => n.label)).toEqual(['+3 more', '+3 more']);
    expect(graph.edges.every(e => graph.nodes.some(n => n.id === e.from) && graph.nodes.some(n => n.id === e.to))).toBe(true);
    expect(describeRunsGraph(graph)).toContain('66 jobs');
  });
  it('describes singular, plural and unknown counts', () => {
    const graph = buildRunsGraph({ ...minimal(), mergesLastHour: { count: 1 } }, now);
    expect(describeRunsGraph(graph)).toBe('1 leader · 1 lane · 1 job · 1 merge');
    expect(describeRunsGraph({ ...graph, counts: { leaders: 3, lanes: 4, jobs: 16, merges: 2 } })).toBe('3 leaders · 4 lanes · 16 jobs · 2 merges');
    expect(describeRunsGraph(buildRunsGraph(minimal(), now))).toContain('merges unknown');
  });
});
