/**
 * Read-only inventory query: npx tsx examples/agents/graph-delegation-path.ts --from NODE_ID --to NODE_ID
 * Writes one schemaVersion 1 JSON object. Success is `ready` with nodeIds and edgeIds;
 * `not_found` (GRAPH_NODE_NOT_FOUND), `no_path` (GRAPH_NO_PATH), and `unavailable`
 * (GRAPH_UNAVAILABLE) exit 1. GRAPH_LOAD_FAILED also exits 1; GRAPH_USAGE exits 2.
 * Available results include complete, sources, and issues (null when unknown).
 * Inventory is not execution authority: this example never launches or delegates work.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGraph } from '../../src/core/graph/loader.js';

const usage = 'Usage: npx tsx examples/agents/graph-delegation-path.ts --from NODE_ID --to NODE_ID';

type Dependencies = {
  load?: typeof loadGraph;
  write?: (line: string) => void;
};

/** Write exactly one JSON result and return an exit code without terminating the caller. */
export async function runGraphDelegationPath(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (value: object, exit: number) => { write(JSON.stringify(value)); return exit; };
  const fail = (status: string, code: string, message: string, exit: number) =>
    emit({ schemaVersion: 1, status, error: { code, message } }, exit);

  let from: string | undefined;
  let to: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (!value || !value.trim() || value.startsWith('--')) return fail('error', 'GRAPH_USAGE', usage, 2);
    if (arg === '--from' && from === undefined) from = value;
    else if (arg === '--to' && to === undefined) to = value;
    else return fail('error', 'GRAPH_USAGE', usage, 2);
    i++;
  }
  if (!from || !to) return fail('error', 'GRAPH_USAGE', usage, 2);

  try {
    const graph = await (deps.load ?? loadGraph)();
    if (graph.status === 'unavailable') return fail('unavailable', 'GRAPH_UNAVAILABLE', 'Graph inventory is unavailable.', 1);
    if (graph.status !== 'ready' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Invalid graph');
    const nodes = new Set<string>();
    for (const node of graph.nodes) {
      if (!node || typeof node.id !== 'string' || nodes.has(node.id)) throw new Error('Invalid node');
      nodes.add(node.id);
    }
    const adjacency = new Map<string, { to: string; id: string }[]>();
    for (const edge of graph.edges) {
      if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') throw new Error('Invalid edge');
      if (edge.kind !== 'can-delegate') continue;
      if (typeof edge.id !== 'string') throw new Error('Invalid delegation edge');
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
      const outgoing = adjacency.get(edge.from) ?? [];
      outgoing.push({ to: edge.to, id: edge.id });
      adjacency.set(edge.from, outgoing);
    }
    const provenance = { complete: graph.complete ?? null, sources: graph.sources ?? null, issues: graph.issues ?? null };
    const missingNodeIds = [...new Set([from, to].filter((id) => !nodes.has(id)))];
    if (missingNodeIds.length) return emit({ schemaVersion: 1, status: 'not_found', from, to, missingNodeIds,
      ...provenance, error: { code: 'GRAPH_NODE_NOT_FOUND', message: 'Node not found in the available graph.' } }, 1);

    // Enqueue each existing node at most once; adjacency retains loader edge order.
    const previous = new Map<string, { node: string; edge: string } | null>([[from, null]]);
    const queue = [from];
    for (let i = 0; i < queue.length && !previous.has(to); i++) {
      const current = queue[i]!;
      for (const edge of adjacency.get(current) ?? []) {
        if (previous.has(edge.to)) continue;
        previous.set(edge.to, { node: current, edge: edge.id });
        queue.push(edge.to);
      }
    }
    if (!previous.has(to)) return emit({ schemaVersion: 1, status: 'no_path', from, to, ...provenance,
      error: { code: 'GRAPH_NO_PATH', message: 'No delegation path exists in the available graph.' } }, 1);
    const nodeIds = [to];
    const edgeIds: string[] = [];
    let current = to;
    while (current !== from) {
      const step = previous.get(current)!;
      if (!step) throw new Error('Invalid path');
      edgeIds.push(step.edge);
      current = step.node;
      nodeIds.push(current);
    }
    return emit({ schemaVersion: 1, status: 'ready', from, to, nodeIds: nodeIds.reverse(),
      edgeIds: edgeIds.reverse(), ...provenance }, 0);
  } catch {
    // Loader and serialization errors may contain private information.
    return fail('error', 'GRAPH_LOAD_FAILED', 'Could not read graph data.', 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runGraphDelegationPath(process.argv.slice(2));
}
