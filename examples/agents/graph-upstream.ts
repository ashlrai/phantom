/** Read an incoming GRAPH-1 neighborhood without starting work. */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGraph } from '../../src/core/graph/loader.js';
import { graphNeighborhood } from '../../src/core/graph/neighborhood.js';

const usage = 'Usage: npx tsx examples/agents/graph-upstream.ts --node ID [--depth 1..4]';

type Dependencies = {
  load?: typeof loadGraph;
  write?: (line: string) => void;
};

/** Returns a process exit code and writes exactly one JSON object. */
export async function runGraphUpstream(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (value: object, code: number) => {
    write(JSON.stringify(value));
    return code;
  };
  const fail = (status: string, code: string, message: string, exit: number) =>
    emit({ schemaVersion: 1, status, error: { code, message } }, exit);

  let nodeId: string | undefined;
  let depth: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--node' && nodeId === undefined && i + 1 < args.length) {
      nodeId = args[++i];
    } else if (arg === '--depth' && depth === undefined && /^[1-4]$/.test(args[i + 1] ?? '')) {
      depth = Number(args[++i]);
    } else {
      return fail('error', 'GRAPH_USAGE', usage, 2);
    }
  }
  if (!nodeId || nodeId.startsWith('--')) return fail('error', 'GRAPH_USAGE', usage, 2);

  try {
    const graph = await (deps.load ?? loadGraph)();
    if (graph.status === 'unavailable') {
      return fail('unavailable', 'GRAPH_UNAVAILABLE', 'Graph data is unavailable.', 1);
    }
    if (graph.status !== 'ready' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error('Invalid graph snapshot');
    }
    const neighborhood = graphNeighborhood(graph, nodeId, 'in', depth ?? 1);
    if (neighborhood === null) {
      return emit({ schemaVersion: 1, status: 'not_found', nodeId, complete: graph.complete ?? null,
        error: { code: 'GRAPH_NODE_NOT_FOUND', message: 'Node not found in the available graph.' } }, 1);
    }
    return emit({ schemaVersion: 1, status: 'ready', complete: graph.complete ?? null, ...neighborhood }, 0);
  } catch {
    // Do not expose loader or serialization diagnostics, which may contain private data.
    return fail('error', 'GRAPH_LOAD_FAILED', 'Could not read graph data.', 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runGraphUpstream(process.argv.slice(2));
}
