import type { GraphSnapshot } from './loader.js';

const NODE_LIMIT = 500;
type Edge = GraphSnapshot['edges'][number];
type Route =
  | { status: 'found'; nodeIds: string[]; edges: Edge[] }
  | { status: 'not_found'; reason: 'missing_endpoint' | 'exhausted' }
  | { status: 'search_limit' };

/** Search only directed, evidenced edges between nodes present in the snapshot. */
export function graphRoutePath(graph: GraphSnapshot, source: string, target: string, kind: string, maxHops: number): Route {
  const nodes = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || nodes.has(node.id)) throw new Error('Invalid graph node');
    nodes.add(node.id);
  }
  if (!nodes.has(source) || !nodes.has(target)) return { status: 'not_found', reason: 'missing_endpoint' };
  if (source === target) return { status: 'found', nodeIds: [source], edges: [] };

  const adjacency = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') throw new Error('Invalid graph edge');
    if (edge.kind !== kind || !nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    if (typeof edge.id !== 'string') throw new Error('Invalid graph edge ID');
    const outgoing = adjacency.get(edge.from) ?? [];
    outgoing.push(edge);
    adjacency.set(edge.from, outgoing);
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  for (const edges of adjacency.values()) edges.sort((a, b) =>
    compare(a.to as string, b.to as string) || compare(a.id as string, b.id as string));

  const queue: { id: string; depth: number; previous: number; edge?: Edge }[] = [
    { id: source, depth: 0, previous: -1 },
  ];
  const visited = new Set([source]);
  const deferred = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const edge of adjacency.get(current.id) ?? []) {
      const next = edge.to as string;
      if (visited.has(next)) continue;
      if (current.depth === maxHops || visited.size === NODE_LIMIT) {
        deferred.add(next);
        continue;
      }
      visited.add(next);
      queue.push({ id: next, depth: current.depth + 1, previous: i, edge });
      if (next === target) {
        const nodeIds: string[] = [];
        const pathEdges: Edge[] = [];
        for (let index = queue.length - 1; index >= 0; index = queue[index]!.previous) {
          const step = queue[index]!;
          nodeIds.push(step.id);
          if (step.edge) pathEdges.push(step.edge);
        }
        return { status: 'found', nodeIds: nodeIds.reverse(), edges: pathEdges.reverse() };
      }
    }
  }
  return [...deferred].some((id) => !visited.has(id))
    ? { status: 'search_limit' } : { status: 'not_found', reason: 'exhausted' };
}
