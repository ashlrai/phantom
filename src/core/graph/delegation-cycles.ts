import type { GraphSnapshot } from './loader.js';

interface DelegationEdge { id: string; from: string; to: string; kind: 'can-delegate' }

/** Find cyclic strongly connected components without recursion or changing the snapshot. */
export function delegationCycles(graph: GraphSnapshot) {
  const nodes = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || nodes.has(node.id)) throw new Error('Invalid graph node');
    nodes.add(node.id);
  }
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const edges: DelegationEdge[] = [];
  for (const edge of graph.edges) {
    if (edge?.kind !== 'can-delegate') continue;
    if (typeof edge.id !== 'string' || typeof edge.from !== 'string' || typeof edge.to !== 'string'
      || !nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error('Invalid delegation edge');
    edges.push({ id: edge.id, from: edge.from, to: edge.to, kind: 'can-delegate' });
    if (!forward.has(edge.from)) forward.set(edge.from, []);
    if (!reverse.has(edge.to)) reverse.set(edge.to, []);
    forward.get(edge.from)!.push(edge.to);
    reverse.get(edge.to)!.push(edge.from);
  }

  // Iterative Kosaraju traversal avoids overflowing the stack on long chains.
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of nodes) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stack = [{ id, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const next = forward.get(frame.id)?.[frame.next++];
      if (next !== undefined) {
        if (!seen.has(next)) { seen.add(next); stack.push({ id: next, next: 0 }); }
      } else { order.push(frame.id); stack.pop(); }
    }
  }
  seen.clear();
  const components: { nodeIds: string[]; edges: DelegationEdge[] }[] = [];
  const componentByNode = new Map<string, number>();
  for (const id of order.reverse()) {
    if (seen.has(id)) continue;
    const nodeIds: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const current = stack.pop()!;
      nodeIds.push(current);
      componentByNode.set(current, components.length);
      for (const next of reverse.get(current) ?? []) {
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    components.push({ nodeIds: nodeIds.sort(), edges: [] });
  }
  for (const edge of edges) {
    const index = componentByNode.get(edge.from)!;
    if (index === componentByNode.get(edge.to)) components[index]!.edges.push(edge);
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return components.filter(component => component.nodeIds.length > 1 || component.edges.length > 0)
    .map(component => ({ ...component, edges: component.edges.sort((a, b) =>
      compare(a.from, b.from) || compare(a.to, b.to) || compare(a.id, b.id)) }))
    .sort((a, b) => compare(a.nodeIds[0]!, b.nodeIds[0]!));
}
