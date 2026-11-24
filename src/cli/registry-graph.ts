import { readRegistryGraph, type GraphStatusOptions } from '../core/graph/status.js';

/** Render an explicitly selected registry snapshot without invoking the live loader. */
export async function cmdRegistryGraph(options: GraphStatusOptions, json: boolean): Promise<number> {
  try {
    const graph = await readRegistryGraph(options);
    console.log(json ? JSON.stringify(graph, null, 2) : [
      `graph.v1: ${graph.complete ? 'complete' : 'incomplete'} registry projection`,
      `Sources: fleet ${graph.sources.fleet}; seats ${graph.sources.seats}`,
      `${graph.nodes.length} nodes; ${graph.edges.length} edges`,
      ...graph.nodes.map(node => `  ${node.id} (${node.kind})`),
      ...graph.edges.map(edge => `  ${edge.from} --${edge.kind}--> ${edge.to}`),
      ...graph.issues.map(issue => `Issue: ${issue.source} ${issue.code}`),
      'Declarations and catalogs only; no execution authority or health claim.',
    ].join('\n'));
    return graph.complete ? 0 : 1;
  } catch {
    // Read failures may carry private paths or input fragments.
    if (json) console.log(JSON.stringify({ error: 'Graph sources unavailable' }));
    else console.error('Graph sources unavailable');
    return 1;
  }
}
