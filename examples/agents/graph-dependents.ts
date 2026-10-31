#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadGraph, type GraphLoadResult } from '../../src/core/graph/loader.js';
import { graphNeighborhood } from '../../src/core/graph/neighborhood.js';

const usage = 'Usage: npx tsx examples/agents/graph-dependents.ts --node ID --depth 1..4';

type Dependencies = {
  load?: () => Promise<GraphLoadResult>;
  write?: (line: string) => void;
};

/** Print one JSON result; return a process exit code without terminating the caller. */
export async function runGraphDependents(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? ((line: string) => console.log(line));
  const fail = (code: string, message: string, exitCode: number) => {
    write(JSON.stringify({ schemaVersion: 1, status: 'error', error: { code, message } }));
    return exitCode;
  };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    write(usage);
    return 0;
  }
  let nodeId: string | undefined;
  let depth: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--node' && nodeId === undefined && value && !value.startsWith('--')) {
      nodeId = value;
      i++;
    } else if (arg === '--depth' && depth === undefined && value && /^[1-4]$/.test(value)) {
      depth = Number(value);
      i++;
    } else {
      return fail('GRAPH_USAGE', usage, 2);
    }
  }
  if (!nodeId || !nodeId.trim() || depth === undefined) return fail('GRAPH_USAGE', usage, 2);

  try {
    const graph = await (deps.load ?? loadGraph)();
    if (graph.status === 'unavailable') {
      return fail('GRAPH_UNAVAILABLE', 'Graph inventory is unavailable.', 1);
    }
    if (graph.status !== 'ready' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error('Invalid graph snapshot');
    }
    const neighborhood = graphNeighborhood(graph, nodeId, 'out', depth);
    if (!neighborhood) return fail('GRAPH_NODE_NOT_FOUND', 'Graph node not found.', 1);
    write(JSON.stringify({
      schemaVersion: 1, status: 'ready', ...neighborhood,
      complete: graph.complete ?? null, sources: graph.sources ?? null, issues: graph.issues ?? null,
    }));
    return 0;
  } catch {
    // Reader failures can contain private values; never relay exception text.
    return fail('GRAPH_LOAD_FAILED', 'Could not read graph data.', 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runGraphDependents(process.argv.slice(2));
}
