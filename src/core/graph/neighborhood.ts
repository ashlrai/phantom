import type { GraphSnapshot } from './loader.js';

export type GraphDirection = 'in' | 'out' | 'both';
const NODE_LIMIT = 500;

/** Return the induced subgraph of nodes reached by a deterministic, bounded BFS. */
export function graphNeighborhood(graph: GraphSnapshot, nodeId: string, direction: GraphDirection, depth: number) {
  const nodes = new Map<string, (typeof graph.nodes)[number]>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || nodes.has(node.id)) throw new Error('Invalid graph node');
    nodes.set(node.id, node);
  }
  if (!nodes.has(nodeId)) return null;

  const adjacency = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from)!.add(to);
  };
  for (const edge of graph.edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') throw new Error('Invalid graph edge');
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    if (direction !== 'in') add(edge.from, edge.to);
    if (direction !== 'out') add(edge.to, edge.from);
  }

  const visited = new Set([nodeId]);
  const queue = [{ id: nodeId, level: 0 }];
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    if (current.level >= depth) continue;
    for (const neighbor of [...(adjacency.get(current.id) ?? [])].sort()) {
      if (visited.has(neighbor)) continue;
      if (visited.size === NODE_LIMIT) { truncated = true; continue; }
      visited.add(neighbor);
      queue.push({ id: neighbor, level: current.level + 1 });
    }
  }

  const edges = graph.edges.filter((edge) =>
    typeof edge.from === 'string' && typeof edge.to === 'string' && visited.has(edge.from) && visited.has(edge.to));
  // Sort by endpoints and ID; equal keys retain the loader's order.
  const key = (edge: (typeof graph.edges)[number]) => [edge.from, edge.to, edge.id].map(String);
  edges.sort((a, b) => {
    const ak = key(a), bk = key(b);
    for (let i = 0; i < ak.length; i++) {
      if (ak[i]! < bk[i]!) return -1;
      if (ak[i]! > bk[i]!) return 1;
    }
    return 0;
  });
  return { nodeId, direction, depth, truncated, nodes: queue.map(({ id }) => nodes.get(id)!), edges };
}
