/**
 * List explicit incoming review relationships without scheduling or writing work.
 * Usage: npx tsx examples/agents/graph-review-candidates.ts --agent <nodeID>
 * Output is one JSON object. Ready results contain agentId, complete, sources,
 * issues and reviewers [{ reviewerId, edgeIds }], in graph edge order. Missing
 * agents return not_found with the same binding and health fields; an incomplete
 * graph cannot prove absence. Missing health fields are null.
 * Errors: GRAPH_USAGE (exit 2), GRAPH_UNAVAILABLE, GRAPH_NODE_NOT_FOUND and
 * GRAPH_LOAD_FAILED (exit 1). Errors never include raw exception text.
 * The current default loader projects fleet inventory, not agent/reviews records.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGraph } from '../../src/core/graph/loader.js';

const usage = 'Usage: npx tsx examples/agents/graph-review-candidates.ts --agent <nodeID>';

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

  if (args.length !== 2 || args[0] !== '--agent' || !args[1] || args[1].startsWith('-')) {
    return fail('error', 'GRAPH_USAGE', usage, 2);
  }
  const agentId = args[1];
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
    return emit({ schemaVersion: 1, status: 'ready', agentId, ...health,
      reviewers: [...reviewers].map(([reviewerId, edgeIds]) => ({ reviewerId, edgeIds })) }, 0);
  } catch {
    return emit({ schemaVersion: 1, status: 'error', agentId,
      error: { code: 'GRAPH_LOAD_FAILED', message: 'Could not read graph data.' } }, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runGraphReviewCandidates(process.argv.slice(2));
}
