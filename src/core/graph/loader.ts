/**
 * GRAPH-1 read boundary. Replace this stub with the GRAPH-1 loader when it lands;
 * the CLI must not fall back to unrelated knowledge or Universe graphs.
 * Records stay opaque here so the CLI preserves the loader's node/edge schema.
 */
export interface GraphSnapshot {
  status: 'ready';
  nodes: readonly Readonly<Record<string, unknown>>[];
  edges: readonly Readonly<Record<string, unknown>>[];
}

export interface GraphUnavailable {
  status: 'unavailable';
}

export type GraphLoadResult = GraphSnapshot | GraphUnavailable;

/** Read-only: no store discovery, filesystem writes, or provider calls. */
export async function loadGraph(): Promise<GraphLoadResult> {
  // Unavailable is deliberately distinct from a successfully loaded empty graph.
  return { status: 'unavailable' };
}
