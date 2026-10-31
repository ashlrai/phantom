/**
 * GRAPH-1 read boundary over the fleet inventory public projection;
 * the CLI must not fall back to unrelated knowledge or Universe graphs.
 * Records stay opaque here so the CLI preserves the loader's node/edge schema.
 */
import { seedFleetGraph, type FleetGraphSeedV1 } from '../fleet/graph-seed.js';

export interface GraphSnapshot {
  status: 'ready';
  complete?: boolean;
  sources?: FleetGraphSeedV1['sources'];
  issues?: FleetGraphSeedV1['issues'];
  nodes: readonly Readonly<Record<string, unknown>>[];
  edges: readonly Readonly<Record<string, unknown>>[];
}

export interface GraphUnavailable {
  status: 'unavailable';
}

export type GraphLoadResult = GraphSnapshot | GraphUnavailable;

/** Read-only: no store discovery, filesystem writes, or provider calls. */
export async function loadGraph(read: () => Promise<FleetGraphSeedV1> = seedFleetGraph): Promise<GraphLoadResult> {
  let seed: FleetGraphSeedV1;
  try {
    seed = await read();
  } catch {
    return { status: 'unavailable' };
  }
  // The synthetic root alone is not evidence. A loaded, valid empty inventory
  // is evidence; absent sources or wholly rejected input are not.
  const hasRecords = seed.nodes.some((node) => node.kind !== 'fleet');
  const validEmptyInventory = seed.sources.fleetJson.state === 'loaded' && seed.complete;
  if (!hasRecords && !validEmptyInventory) return { status: 'unavailable' };
  return {
    status: 'ready',
    nodes: seed.nodes.map((node) => ({ ...node })),
    edges: seed.edges.map((edge) => ({ ...edge })),
    complete: seed.complete,
    sources: seed.sources,
    issues: seed.issues,
  };
}
