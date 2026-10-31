/** Read-only GRAPH-1 CLI. Exit codes: 0 success/help, 1 unavailable/error, 2 usage. */
import { graphNeighborhood, type GraphDirection } from '../core/graph/neighborhood.js';

const USAGE = `Usage: phm graph <nodes|edges|status> [--json]
       phm graph node <node-id> [--json]
       phm graph neighbors <node-id> [--direction in|out|both] [--depth 1..4] [--edge-kind can-message|can-delegate|reviews|routes-to] [--json]

  nodes       List graph node records.
  node        Retrieve one exact graph node record.
  edges       List graph edge records.
  status      Report graph availability and node/edge counts.
  neighbors   Find a node and its bounded graph neighborhood (default: both, depth 1).
              Returns at most 500 nodes and indicates whether results were truncated.
              Use -- before a node ID that looks like an option (also applies to node).
  --kind      Filter nodes by agent|engine-account|model|mcp, or edges by
              can-message|can-delegate|reviews|routes-to (exact match).
  --edge-kind Filter neighbors traversal to one exact edge kind (same values as edges --kind).
  --from      Filter edges by exact source ID; use --from=<id> for option-like IDs.
  --to        Filter edges by exact destination ID; use --to=<id> for option-like IDs.
  --json      Emit one versioned JSON object on stdout, including errors.
  --help, -h  Show this help without loading the graph.

Read-only; graph data comes exclusively from the GRAPH-1 loader.
Neighborhood reachability does not grant dispatch authority.
Until GRAPH-1 is available, all data commands report GRAPH_UNAVAILABLE.
Unavailable counts are unknown, never reported as zero.
Exit codes: 0 success/help, 1 unavailable or loader failure, 2 invalid arguments.
Node and neighbors also exit 1 when the node is not found.
`;

type GraphCommand = 'nodes' | 'node' | 'edges' | 'status' | 'neighbors';
type ErrorCode = 'GRAPH_USAGE' | 'GRAPH_UNAVAILABLE' | 'GRAPH_LOAD_FAILED' | 'GRAPH_NODE_NOT_FOUND';
const NODE_KINDS = ['agent', 'engine-account', 'model', 'mcp'] as const;
const EDGE_KINDS = ['can-message', 'can-delegate', 'reviews', 'routes-to'] as const;

interface Options {
  command: GraphCommand | null;
  json: boolean;
  help: boolean;
  nodeId: string | null;
  direction: GraphDirection;
  depth: number;
  kind: string | null;
  edgeKind: string | null;
  from: string | null;
  to: string | null;
}

function isCommand(value: string): value is GraphCommand {
  return value === 'nodes' || value === 'node' || value === 'edges' || value === 'status' || value === 'neighbors';
}

function parse(args: string[]): Options {
  const options: Options = { command: null, json: false, help: false, nodeId: null, direction: 'both', depth: 1, kind: null, edgeKind: null, from: null, to: null };
  let directionSeen = false;
  let depthSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !options.json) options.json = true;
    else if ((arg === '--help' || arg === '-h') && !options.help) options.help = true;
    else if ((options.command === 'neighbors' || options.command === 'node') && arg === '--' && options.nodeId === null && i + 1 < args.length) {
      options.nodeId = args[++i]!;
    } else if ((options.command === 'nodes' || options.command === 'edges') && arg === '--kind' && options.kind === null) {
      const value = args[++i];
      const kinds: readonly string[] = options.command === 'nodes' ? NODE_KINDS : EDGE_KINDS;
      if (value === undefined || !kinds.includes(value)) throw new Error(`Kind must be ${kinds.join(', ')}.`);
      options.kind = value;
    } else if (options.command === 'neighbors' && arg === '--edge-kind' && options.edgeKind === null) {
      const value = args[++i];
      if (value === undefined || !(EDGE_KINDS as readonly string[]).includes(value)) throw new Error(`Edge kind must be ${EDGE_KINDS.join(', ')}.`);
      options.edgeKind = value;
    } else if (options.command === 'edges' && /^(--from|--to)(=|$)/.test(arg)) {
      const separator = arg.indexOf('=');
      const key = (separator === -1 ? arg.slice(2) : arg.slice(2, separator)) as 'from' | 'to';
      const value = separator === -1 ? args[++i] : arg.slice(separator + 1);
      if (options[key] !== null || !value || (separator === -1 && value.startsWith('-'))) {
        throw new Error(`Invalid --${key} filter.`);
      }
      options[key] = value;
    } else if (options.command === 'neighbors' && arg === '--direction' && !directionSeen) {
      const value = args[++i];
      if (value !== 'in' && value !== 'out' && value !== 'both') throw new Error('Direction must be in, out, or both.');
      options.direction = value;
      directionSeen = true;
    } else if (options.command === 'neighbors' && arg === '--depth' && !depthSeen) {
      const value = args[++i];
      if (value === undefined || !/^[1-4]$/.test(value)) throw new Error('Depth must be an integer from 1 to 4.');
      options.depth = Number(value);
      depthSeen = true;
    } else if ((options.command === 'neighbors' || options.command === 'node') && options.nodeId === null && !arg.startsWith('-')) {
      options.nodeId = arg;
    }
    else if (isCommand(arg) && options.command === null) options.command = arg;
    else throw new Error('Invalid graph arguments.');
  }
  if (!options.help && options.command === null) throw new Error('A graph subcommand is required.');
  if (!options.help && (options.command === 'neighbors' || options.command === 'node') && options.nodeId === null) throw new Error('A node ID is required.');
  return options;
}

function fail(options: Pick<Options, 'command' | 'json'>, code: ErrorCode, message: string): number {
  if (options.json) {
    console.log(JSON.stringify({ schemaVersion: 1, command: options.command,
      status: code === 'GRAPH_UNAVAILABLE' ? 'unavailable' : code === 'GRAPH_NODE_NOT_FOUND' ? 'not_found' : 'error', error: { code, message } }));
  } else {
    console.error(`graph: ${message}`);
    if (code === 'GRAPH_USAGE') console.error('Run `phm graph --help` for usage.');
  }
  return code === 'GRAPH_USAGE' ? 2 : 1;
}

export async function cmdGraph(args: string[]): Promise<number> {
  let options: Options;
  try {
    options = parse(args);
  } catch (error) {
    return fail({ json: args.includes('--json'), command: args.find(isCommand) ?? null },
      'GRAPH_USAGE', (error as Error).message);
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    const { loadGraph } = await import('../core/graph/loader.js');
    const graph = await loadGraph();
    if (graph.status === 'unavailable') {
      return fail(options, 'GRAPH_UNAVAILABLE', 'GRAPH-1 loader is not available in this build.');
    }
    // Validate the boundary before projecting counts: malformed data is not an empty graph.
    if (graph.status !== 'ready' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error('Invalid graph snapshot');
    }
    const command = options.command!;
    if (command === 'node') {
      const node = graph.nodes.find((record) => record?.id === options.nodeId);
      if (!node) return fail(options, 'GRAPH_NODE_NOT_FOUND', 'Graph node not found.');
      console.log(JSON.stringify({ schemaVersion: 1, command, status: 'ready', node,
        complete: graph.complete, sources: graph.sources, issues: graph.issues }, null, options.json ? undefined : 2));
      return 0;
    }
    if (command === 'neighbors') {
      const selectedGraph = options.edgeKind === null ? graph : {
        ...graph, edges: graph.edges.filter((edge) => edge?.kind === options.edgeKind),
      };
      const neighborhood = graphNeighborhood(selectedGraph, options.nodeId!, options.direction, options.depth);
      if (!neighborhood) return fail(options, 'GRAPH_NODE_NOT_FOUND', 'Graph node not found.');
      const result = { schemaVersion: 1, command, status: 'ready', ...neighborhood,
        ...(options.edgeKind !== null ? { edgeKind: options.edgeKind } : {}),
        ...(options.json || options.edgeKind !== null ? { complete: graph.complete, sources: graph.sources, issues: graph.issues } : {}) };
      console.log(JSON.stringify(result, null, options.json ? undefined : 2));
      return 0;
    }
    const records = command === 'nodes' || command === 'edges'
      ? graph[command].filter((record) =>
        (options.kind === null || record?.kind === options.kind)
        && (options.from === null || record?.from === options.from)
        && (options.to === null || record?.to === options.to))
      : null;
    const data = command === 'status'
      ? { counts: { nodes: graph.nodes.length, edges: graph.edges.length } }
      : { [command]: records };
    if (options.json) {
      console.log(JSON.stringify({ schemaVersion: 1, command, status: 'ready', ...data,
        ...(options.from !== null || options.to !== null ? { filters: {
          ...(options.kind !== null ? { kind: options.kind } : {}),
          ...(options.from !== null ? { from: options.from } : {}),
          ...(options.to !== null ? { to: options.to } : {}),
        } } : {}),
        complete: graph.complete, sources: graph.sources, issues: graph.issues }));
    } else if (command === 'status') {
      console.log(`Graph: ready · ${graph.nodes.length} node${graph.nodes.length === 1 ? '' : 's'} · ${graph.edges.length} edge${graph.edges.length === 1 ? '' : 's'}`);
    } else {
      const serialized = JSON.stringify(records, null, 2);
      console.log(`Graph ${command}: ${records!.length}`);
      console.log(serialized);
    }
    return 0;
  } catch {
    // Loader errors may contain private paths or credentials. Expose a stable public error only.
    return fail(options, 'GRAPH_LOAD_FAILED', 'Could not load GRAPH-1 graph data.');
  }
}
