import type { GraphSnapshot } from '../core/graph/loader.js';

const MAX_NODES = 500;
const MAX_EDGES = 1000;
const MAX_BYTES = 256 * 1024;

export class MermaidLimitError extends Error {}

// Mermaid's numeric entities keep syntax, HTML, and line breaks inside labels.
function label(value: string): string {
  if (value.length > MAX_BYTES) throw new MermaidLimitError(`Mermaid export exceeds the ${MAX_BYTES} byte output limit.`);
  return Array.from(value, (char) => /^[a-zA-Z0-9 ]$/.test(char) ? char : `#${char.codePointAt(0)};`).join('');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sourceState(value: unknown, allowed: readonly string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
}

/** Render only the loaded records. Missing endpoints are placeholders, not inferred nodes. */
export function renderMermaid(graph: GraphSnapshot, filters: { from: string | null; to: string | null }): string {
  const nodes = new Map<string, string>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || nodes.has(node.id)
      || (node.label !== undefined && typeof node.label !== 'string')) throw new Error('Invalid graph node');
    nodes.set(node.id, typeof node.label === 'string' ? node.label : node.id);
  }
  const edges: { from: string; to: string; kind: string }[] = [];
  for (const edge of graph.edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string' || typeof edge.kind !== 'string') {
      throw new Error('Invalid graph edge');
    }
    if ((filters.from === null || edge.from === filters.from) && (filters.to === null || edge.to === filters.to)) {
      edges.push({ from: edge.from, to: edge.to, kind: edge.kind });
      if (edges.length > MAX_EDGES) throw new MermaidLimitError(`Mermaid export exceeds the ${MAX_EDGES} edge limit.`);
    }
  }
  const filtered = filters.from !== null || filters.to !== null;
  const selected = filtered ? new Set<string>() : new Set(nodes.keys());
  for (const edge of edges) { selected.add(edge.from); selected.add(edge.to); }
  if (selected.size > MAX_NODES) throw new MermaidLimitError(`Mermaid export exceeds the ${MAX_NODES} node limit (including missing endpoints).`);
  const ids = [...selected].sort(compare);
  const names = new Map(ids.map((id, index) => [id, `n${index}`]));
  const missing = ids.filter((id) => !nodes.has(id)).length;
  edges.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.kind, b.kind));
  const complete = typeof graph.complete === 'boolean' ? String(graph.complete) : 'unknown';
  const issues = Array.isArray(graph.issues) ? String(graph.issues.length) : 'unknown';
  const fleet = sourceState(graph.sources?.fleetJson?.state, ['absent', 'loaded', 'malformed']);
  const seats = sourceState(graph.sources?.seats?.state, ['absent', 'loaded']);
  const lines: string[] = [];
  let bytes = 0;
  const add = (line: string) => {
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (bytes > MAX_BYTES) throw new MermaidLimitError(`Mermaid export exceeds the ${MAX_BYTES} byte output limit.`);
    lines.push(line);
  };
  add(`%% Source complete: ${complete}; recorded issues: ${issues}`);
  add(`%% Sources: fleet.json=${fleet}; seats=${seats}`);
  add(`%% Selection: ${filtered ? 'filtered edges and endpoints' : 'all loaded nodes and edges'}; missing endpoints: ${missing}`);
  add('flowchart LR');
  for (const id of ids) add(`  ${names.get(id)}["${label(nodes.has(id) ? nodes.get(id)! : `Missing node: ${id}`)}"]`);
  for (const edge of edges) add(`  ${names.get(edge.from)} -->|"${label(edge.kind)}"| ${names.get(edge.to)}`);
  return lines.join('\n');
}
