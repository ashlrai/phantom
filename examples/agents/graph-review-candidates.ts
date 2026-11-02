/**
 * List explicit incoming review relationships without scheduling or writing work.
 * Usage: npx tsx examples/agents/graph-review-candidates.ts --agent <nodeID> [--exclude-agent <nodeID> ...]
 * Example: npx tsx examples/agents/graph-review-candidates.ts --agent agent:example --exclude-agent agent:author --exclude-agent agent:participant
 * Output is one JSON object. Ready results contain agentId, complete, sources,
 * issues and reviewers [{ reviewerId, edgeIds }], in graph edge order. Missing
 * agents return not_found with the same binding and health fields; an incomplete
 * graph cannot prove absence. Missing health fields are null.
 * With exclusions, excludedAgentIds lists unique requested IDs in argument order;
 * excludedCandidateCount counts distinct reviewers removed. Candidates and
 * exclusions do not establish independence or authorize a merge.
 * Errors: GRAPH_USAGE (exit 2), GRAPH_UNAVAILABLE, GRAPH_NODE_NOT_FOUND and
 * GRAPH_LOAD_FAILED (exit 1). Errors never include raw exception text.
 * The current default loader projects fleet inventory, not agent/reviews records.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGraph } from '../../src/core/graph/loader.js';

const usage = 'Usage: npx tsx examples/agents/graph-review-candidates.ts --agent <nodeID> [--exclude-agent <nodeID> ...]';

type Dependencies = {
  load?: typeof loadGraph;
  write?: (line: string) => void;
};

/** Returns an exit code and emits exactly one JSON object. */
export async function runGraphReviewCandidates(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (value: object, code: number): number => {
    write(JSON.stringify(value));
    return code;
  };
  const fail = (status: string, code: string, message: string, exit: number) =>
    emit({ schemaVersion: 1, status, error: { code, message } }, exit);

  let agentId: string | undefined;
  const excluded = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith('-') || (flag !== '--agent' && flag !== '--exclude-agent') ||
        (flag === '--agent' && agentId !== undefined)) {
      return fail('error', 'GRAPH_USAGE', usage, 2);
    }
    if (flag === '--agent') agentId = value;
    else excluded.add(value);
  }
  if (agentId === undefined) return fail('error', 'GRAPH_USAGE', usage, 2);
  try {
    const graph = await (deps.load ?? loadGraph)();
    if (graph.status === 'unavailable') {
      return emit({ schemaVersion: 1, status: 'unavailable', agentId,
        error: { code: 'GRAPH_UNAVAILABLE', message: 'Graph data is unavailable.' } }, 1);
    }
    if (graph.status !== 'ready' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error('Invalid graph snapshot');
    }
    const nodes = new Map<string, string>();
    for (const node of graph.nodes) {
      if (!node || typeof node.id !== 'string' || !node.id || typeof node.kind !== 'string' || nodes.has(node.id)) {
        throw new Error('Invalid graph node');
      }
      nodes.set(node.id, node.kind);
    }
    const health = { complete: graph.complete ?? null, sources: graph.sources ?? null, issues: graph.issues ?? null };
    if (nodes.get(agentId) !== 'agent') {
      return emit({ schemaVersion: 1, status: 'not_found', agentId, ...health,
        error: { code: 'GRAPH_NODE_NOT_FOUND', message: 'Agent not found in the available graph.' } }, 1);
    }
    const reviewers = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (!edge || typeof edge.id !== 'string' || !edge.id || typeof edge.from !== 'string' ||
          typeof edge.to !== 'string' || typeof edge.kind !== 'string') {
        throw new Error('Invalid graph edge');
      }
      if (edge.kind !== 'reviews' || edge.to !== agentId || nodes.get(edge.from) !== 'agent') continue;
      const edgeIds = reviewers.get(edge.from) ?? [];
      if (!edgeIds.includes(edge.id)) edgeIds.push(edge.id);
      reviewers.set(edge.from, edgeIds);
    }
    const eligible = [...reviewers].filter(([reviewerId]) => !excluded.has(reviewerId));
    return emit({ schemaVersion: 1, status: 'ready', agentId, ...health,
      ...(excluded.size ? { excludedAgentIds: [...excluded], excludedCandidateCount: reviewers.size - eligible.length } : {}),
      reviewers: eligible.map(([reviewerId, edgeIds]) => ({ reviewerId, edgeIds })) }, 0);
  } catch {
    return emit({ schemaVersion: 1, status: 'error', agentId,
      error: { code: 'GRAPH_LOAD_FAILED', message: 'Could not read graph data.' } }, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runGraphReviewCandidates(process.argv.slice(2));
}
