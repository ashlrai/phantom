import { describe, expect, it, vi } from 'vitest';
import { runGraphReviewCandidates } from '../examples/agents/graph-review-candidates.js';
import { buildFleetGraphSeed } from '../src/core/fleet/graph-seed.js';
import { buildRegistryGraph } from '../src/core/graph/registry.js';
import type { GraphSnapshot } from '../src/core/graph/loader.js';

// Both inputs are fabricated; the default fleet loader does not yet project agents.
const registry = buildRegistryGraph({
  schema: 'fleet.v1',
  agents: ['author', 'participant', 'reviewer', 'unrelated'].map(id => ({ id })),
  mcp: [],
  edges: [
    { kind: 'reviews', from: 'author', to: 'author' },
    { kind: 'reviews', from: 'participant', to: 'author' },
    { kind: 'reviews', from: 'reviewer', to: 'author' },
    { kind: 'can-message', from: 'unrelated', to: 'author' },
  ],
}, []);
const partial = buildFleetGraphSeed({ fleet: { seats: [{ seat: 'fake-seat', lane: 'codex' }] }, seats: [] },
  { now: () => new Date('2020-01-01T00:00:00Z') });
const snapshot: GraphSnapshot = {
  status: 'ready', nodes: registry.nodes, edges: registry.edges,
  complete: partial.complete, sources: partial.sources, issues: partial.issues,
};

async function query(args: string[], graph: GraphSnapshot = snapshot) {
  const lines: string[] = [];
  const load = vi.fn(async () => graph);
  const exit = await runGraphReviewCandidates(args, { load, write: line => lines.push(line) });
  expect(lines).toHaveLength(1);
  return { exit, result: JSON.parse(lines[0]!), load };
}

const target = ['--agent', 'agent:author'];
const citedEdge = (from: string) => registry.edges.find(edge => edge.kind === 'reviews' && edge.from === from)!.id;

describe('review candidate exclusions', () => {
  it('excludes the author even when an explicit self-review edge exists', async () => {
    const { exit, result } = await query([...target, '--exclude-agent', 'agent:author']);
    expect(exit).toBe(0);
    expect(result).toEqual({
      schemaVersion: 1, status: 'ready', agentId: 'agent:author',
      complete: false, sources: partial.sources, issues: partial.issues,
      excludedAgentIds: ['agent:author'], excludedCandidateCount: 1,
      reviewers: [
        { reviewerId: 'agent:participant', edgeIds: [citedEdge('agent:participant')] },
        { reviewerId: 'agent:reviewer', edgeIds: [citedEdge('agent:reviewer')] },
      ],
    });
  });

  it('removes multiple participating agents while retaining remaining edge citations', async () => {
    const { result } = await query(['--exclude-agent', 'agent:participant', ...target,
      '--exclude-agent', 'agent:author']);
    expect(result).toMatchObject({
      excludedAgentIds: ['agent:participant', 'agent:author'], excludedCandidateCount: 2,
      reviewers: [{ reviewerId: 'agent:reviewer', edgeIds: [citedEdge('agent:reviewer')] }],
    });
  });

  it('records noncandidate and unknown IDs without removing other relationships or candidates', async () => {
    const { result } = await query([...target, '--exclude-agent', 'agent:unrelated',
      '--exclude-agent', 'agent:unknown']);
    expect(result.excludedAgentIds).toEqual(['agent:unrelated', 'agent:unknown']);
    expect(result.excludedCandidateCount).toBe(0);
    expect(result.reviewers.map((row: { reviewerId: string }) => row.reviewerId))
      .toEqual(['agent:author', 'agent:participant', 'agent:reviewer']);
  });

  it('deduplicates repeated exclusions and counts a reviewer once despite multiple citations', async () => {
    const graph: GraphSnapshot = { ...snapshot, edges: [...snapshot.edges,
      { id: 'fake-second-review-edge', kind: 'reviews', from: 'agent:participant', to: 'agent:author' }] };
    const { result } = await query([...target, '--exclude-agent', 'agent:participant',
      '--exclude-agent', 'agent:participant', '--exclude-agent', 'agent:unknown',
      '--exclude-agent', 'agent:unknown'], graph);
    expect(result).toMatchObject({ excludedAgentIds: ['agent:participant', 'agent:unknown'],
      excludedCandidateCount: 1, reviewers: [
        { reviewerId: 'agent:author', edgeIds: [citedEdge('agent:author')] },
        { reviewerId: 'agent:reviewer', edgeIds: [citedEdge('agent:reviewer')] },
      ] });
  });

  it('reports an empty eligible list as an observation with partial inventory health', async () => {
    const { exit, result } = await query([...target, '--exclude-agent', 'agent:author',
      '--exclude-agent', 'agent:participant', '--exclude-agent', 'agent:reviewer']);
    expect(exit).toBe(0);
    expect(result).toMatchObject({ status: 'ready', complete: false, sources: partial.sources,
      issues: partial.issues, excludedCandidateCount: 3, reviewers: [] });
    expect(partial.issues.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('approved');
    expect(result).not.toHaveProperty('independent');
  });

  it('leaves the original output unchanged when there are no exclusions', async () => {
    const { result } = await query(target);
    expect(result).not.toHaveProperty('excludedAgentIds');
    expect(result).not.toHaveProperty('excludedCandidateCount');
    expect(result.reviewers).toEqual(['author', 'participant', 'reviewer'].map(id => ({
      reviewerId: `agent:${id}`, edgeIds: [citedEdge(`agent:${id}`)],
    })));
  });

  it.each([
    ['--exclude-agent', 'agent:author'],
    [...target, '--exclude-agent'],
    [...target, '--exclude-agent', '--agent'],
    [...target, '--exclude-agent', ''],
    [...target, '--exclude-agent', 'agent:author', '--agent', 'agent:author'],
  ])('rejects malformed arguments without loading: %j', async (...args) => {
    const { exit, result, load } = await query(args);
    expect(exit).toBe(2);
    expect(result.error.code).toBe('GRAPH_USAGE');
    expect(load).not.toHaveBeenCalled();
  });

  it('still validates malformed edges even when their reviewer was excluded', async () => {
    const graph: GraphSnapshot = { ...snapshot, edges: [{ kind: 'reviews', from: 'agent:author', to: 'agent:author' }] };
    const { exit, result } = await query([...target, '--exclude-agent', 'agent:author'], graph);
    expect(exit).toBe(1);
    expect(result.error.code).toBe('GRAPH_LOAD_FAILED');
  });
});
