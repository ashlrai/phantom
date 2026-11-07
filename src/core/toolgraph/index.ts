import { readFileSync } from 'node:fs';

export type Permission = 'read' | 'write' | 'deploy' | 'secret-adjacent';
export interface ToolGraph {
  capabilities: Record<string, { requires: string[]; tools: string[] }>;
  tools: Record<string, { permissions: Permission[] }>;
  tasks: Record<string, string[]>;
}
export type Resolution =
  | { status: 'disabled'; tools: [] }
  | { status: 'incomplete'; tools: []; capabilities: string[]; missingCapabilities: string[] }
  | { status: 'complete'; tools: { id: string; permissions: Permission[] }[]; capabilities: string[] };

const ranks: Record<Permission, number> = { read: 0, write: 1, deploy: 2, 'secret-adjacent': 3 };

/**
 * Discovery only: inventory membership never grants permission or executes a tool.
 * PHANTOM_TOOLGRAPH=1 opts in; all other values leave discovery disabled.
 * availableTools contains graph IDs attested by the caller's MCP/CLI inventory,
 * not inferred from declarations. Built-in IDs are logical adapter names.
 * Minimize count first, then summed permission ranks (read=0, write=1,
 * deploy=2, secret-adjacent=3), then lexical IDs for deterministic ties.
 * Invalid graphs/unknown tasks throw; unavailable capabilities return incomplete.
 */
export function resolve(
  taskClass: string,
  options: { availableTools: ReadonlySet<string>; graph?: ToolGraph; env?: NodeJS.ProcessEnv },
): Resolution {
  if ((options.env ?? process.env)['PHANTOM_TOOLGRAPH'] !== '1') return { status: 'disabled', tools: [] };
  const graph: ToolGraph = options.graph ?? JSON.parse(readFileSync(new URL('./graph.json', import.meta.url), 'utf8'));
  const owns = (object: object, key: string): boolean => Object.hasOwn(object, key);
  const visited = new Set<string>();
  const active = new Set<string>();
  const capabilities: string[] = [];
  function visit(id: string, collect: boolean): void {
    if (active.has(id)) throw new Error(`Toolgraph cycle at capability: ${id}`);
    if (!owns(graph.capabilities, id)) throw new Error(`Unknown capability: ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    const node = graph.capabilities[id];
    for (const tool of node.tools) {
      if (!owns(graph.tools, tool)) throw new Error(`Unknown tool: ${tool}`);
    }
    for (const dependency of node.requires) visit(dependency, collect);
    active.delete(id);
    visited.add(id);
    if (collect) capabilities.push(id);
  }
  for (const [id, tool] of Object.entries(graph.tools)) {
    if (!tool.permissions.length || tool.permissions.some(permission => !owns(ranks, permission))) {
      throw new Error(`Invalid permissions for tool: ${id}`);
    }
  }
  // Reject cycles even in disconnected portions of the declarative graph.
  for (const id of Object.keys(graph.capabilities)) visit(id, false);
  visited.clear();
  if (!owns(graph.tasks, taskClass)) throw new Error(`Unknown task class: ${taskClass}`);
  for (const id of graph.tasks[taskClass]) visit(id, true);
  const candidates = capabilities.map(id => graph.capabilities[id].tools.filter(tool => options.availableTools.has(tool)));
  const missingCapabilities = capabilities.filter((_, index) => !candidates[index].length);
  if (missingCapabilities.length) return { status: 'incomplete', tools: [], capabilities, missingCapabilities };

  // Exact set cover: minimize tool count first, then summed permission rank,
  // then stable tool IDs. Suitable for small, host-owned declarative graphs.
  let best: string[] | undefined;
  const cost = (ids: string[]): number => ids.reduce((sum, id) => sum + graph.tools[id].permissions.reduce((n, p) => n + ranks[p], 0), 0);
  function search(selected: Set<string>): void {
    const uncovered = candidates.find(tools => !tools.some(tool => selected.has(tool)));
    if (!uncovered) {
      const ids = [...selected].sort();
      if (!best || ids.length < best.length || (ids.length === best.length &&
        (cost(ids) < cost(best) || (cost(ids) === cost(best) && ids.join('\n') < best.join('\n'))))) best = ids;
      return;
    }
    if (best && selected.size >= best.length) return;
    for (const tool of [...new Set(uncovered)].sort()) {
      selected.add(tool);
      search(selected);
      selected.delete(tool);
    }
  }
  search(new Set());
  return { status: 'complete', capabilities, tools: (best ?? []).map(id => ({ id, permissions: [...graph.tools[id].permissions] })) };
}
