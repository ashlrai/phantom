/** Read-only GRAPH-1 CLI. Exit codes: 0 success/help, 1 unavailable/error, 2 usage. */
const USAGE = `Usage: phm graph <nodes|edges|status> [--json]

  nodes       List graph node records.
  edges       List graph edge records.
  status      Report graph availability and node/edge counts.
  --json      Emit one versioned JSON object on stdout, including errors.
  --help, -h  Show this help without loading the graph.

Read-only; graph data comes exclusively from the GRAPH-1 loader.
Until GRAPH-1 is available, all data commands report GRAPH_UNAVAILABLE.
Unavailable counts are unknown, never reported as zero.
Exit codes: 0 success/help, 1 unavailable or loader failure, 2 invalid arguments.
`;

type GraphCommand = 'nodes' | 'edges' | 'status';
type ErrorCode = 'GRAPH_USAGE' | 'GRAPH_UNAVAILABLE' | 'GRAPH_LOAD_FAILED';

interface Options {
  command: GraphCommand | null;
  json: boolean;
  help: boolean;
}

function isCommand(value: string): value is GraphCommand {
  return value === 'nodes' || value === 'edges' || value === 'status';
}

function parse(args: string[]): Options {
  const options: Options = { command: null, json: false, help: false };
  for (const arg of args) {
    if (arg === '--json' && !options.json) options.json = true;
    else if ((arg === '--help' || arg === '-h') && !options.help) options.help = true;
    else if (isCommand(arg) && options.command === null) options.command = arg;
    else throw new Error('Expected one of nodes, edges, or status, with optional --json and --help.');
  }
  if (!options.help && options.command === null) throw new Error('A graph subcommand is required.');
  return options;
}

function fail(options: Pick<Options, 'command' | 'json'>, code: ErrorCode, message: string): number {
  if (options.json) {
    console.log(JSON.stringify({ schemaVersion: 1, command: options.command,
      status: code === 'GRAPH_UNAVAILABLE' ? 'unavailable' : 'error', error: { code, message } }));
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
    const data = command === 'status'
      ? { counts: { nodes: graph.nodes.length, edges: graph.edges.length } }
      : { [command]: graph[command] };
    if (options.json) {
      console.log(JSON.stringify({ schemaVersion: 1, command, status: 'ready', ...data }));
    } else if (command === 'status') {
      console.log(`Graph: ready · ${graph.nodes.length} node${graph.nodes.length === 1 ? '' : 's'} · ${graph.edges.length} edge${graph.edges.length === 1 ? '' : 's'}`);
    } else {
      const records = JSON.stringify(graph[command], null, 2);
      console.log(`Graph ${command}: ${graph[command].length}`);
      console.log(records);
    }
    return 0;
  } catch {
    // Loader errors may contain private paths or credentials. Expose a stable public error only.
    return fail(options, 'GRAPH_LOAD_FAILED', 'Could not load GRAPH-1 graph data.');
  }
}
