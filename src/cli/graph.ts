import { readRegistryGraph, type GraphStatusOptions } from '../core/graph/status.js';

const USAGE = `usage: phm graph status [--fleet <fleet.json>] [--seats <seats.json>] [--json]

Read the graph.v1 registry without running agents, models, or provider probes.
Fleet defaults to ./fleet.json. Seats default to passive native account/catalog
metadata; --seats accepts an exported seats array or {seats:[...]} snapshot.
Edges describe declarations and catalog entries, never execution permission.
Exit codes: 0 complete projection, 1 missing/invalid/unavailable source or
unresolved reference, 2 invalid arguments. --help reads no sources.
`;

export async function cmdGraph(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  const options: GraphStatusOptions = {};
  const seen = new Set<string>();
  let valid = args[0] === 'status';
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg)) { valid = false; break; }
    seen.add(arg);
    if (arg === '--json') continue;
    if (arg !== '--fleet' && arg !== '--seats') { valid = false; break; }
    const value = args[++index];
    if (!value?.trim() || value.startsWith('-') || [...value].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })) { valid = false; break; }
    options[arg === '--fleet' ? 'fleet' : 'seats'] = value;
  }
  if (!valid) {
    if (json) console.log(JSON.stringify({ error: 'Invalid graph arguments', usage: USAGE }));
    else console.error(USAGE);
    return 2;
  }
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
    // Never echo an exception that may carry a launcher, path or JSON fragment.
    if (json) console.log(JSON.stringify({ error: 'Graph sources unavailable' }));
    else console.error('Graph sources unavailable');
    return 1;
  }
}
