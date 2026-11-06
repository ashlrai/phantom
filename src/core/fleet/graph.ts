/**
 * Read-only router topology from ~/.ashlr-runs/queue (or --queue-dir).
 * slots.json accepts an array or { slots: [{ id, pool, jobId, status }] }.
 * jobs.jsonl transitions override Markdown queue state in append order.
 * status.json and leader-status.json supply leader.status and resources[].
 * Missing files are unknown; invalid input is partial, with usable rows retained.
 * Input text is data; prompts and arbitrary metadata never leave this module.
 */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

type Kind = 'leader' | 'lane' | 'slot' | 'job' | 'pr' | 'resource';
interface Node { id: string; kind: Kind; label: string; status: string | null }
interface Edge { source: string; target: string; relation: 'manages' | 'contains' | 'runs' | 'produces' | 'uses' }
export interface FleetGraph {
  schema: 'fleet.v1';
  kind: 'graph';
  generated_at: string;
  nodes: Node[];
  edges: Edge[];
  sources: Record<string, 'known' | 'partial' | 'unknown'>;
}
type Row = Record<string, unknown>;
const row = (v: unknown): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const token = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v) ? v : null;
const rows = (v: unknown, key: string): Row[] => {
  const list = Array.isArray(v) ? v : row(v)[key];
  if (!Array.isArray(list) || list.some(v => !Object.keys(row(v)).length)) throw new Error('invalid collection');
  return list.map(row);
};

export async function buildFleetGraph(options: { queueDir?: string; now?: () => Date } = {}): Promise<FleetGraph> {
  const root = options.queueDir ?? join(homedir(), '.ashlr-runs', 'queue');
  if (!isAbsolute(root)) throw new Error('queueDir must be absolute');
  const graph: FleetGraph = { schema: 'fleet.v1', kind: 'graph', generated_at: (options.now?.() ?? new Date()).toISOString(), nodes: [], edges: [], sources: {} };
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  function node(kind: Kind, label: string, status: string | null = null): string {
    const id = `${kind}:${label}`;
    nodes.set(id, { id, kind, label, status: status ?? nodes.get(id)?.status ?? null });
    return id;
  }
  function edge(source: string, target: string, relation: Edge['relation']): void {
    const e = { source, target, relation }; edges.set(JSON.stringify(e), e);
  }
  const leader = node('leader', 'router');
  function lane(pool: string): string {
    const id = node('lane', pool); edge(leader, id, 'manages'); return id;
  }
  function job(r: Row): void {
    const id = token(r['id'] ?? r['job'] ?? r['jobId']);
    if (!id) throw new Error('invalid job');
    const j = node('job', id, token(r['to'] ?? r['status'] ?? r['event']));
    const pool = token(r['pool'] ?? r['poolId']);
    if (pool) edge(lane(pool), j, 'contains');
    const slot = token(r['slot'] ?? r['slotId']);
    if (slot) edge(node('slot', slot), j, 'runs');
    const pr = r['prUrl'] ?? r['pr'];
    if (typeof pr === 'string' && /^https:\/\/github\.com\/ashlrai\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/.test(pr)) edge(j, node('pr', pr), 'produces');
  }
  async function read(name: string, consume: (text: string) => void): Promise<void> {
    graph.sources[name] = 'unknown';
    let file;
    try {
      file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length === buffer.length) return;
      graph.sources[name] = 'known';
      consume(buffer.subarray(0, length).toString('utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') graph.sources[name] = 'partial';
    } finally { await file?.close(); }
  }
  await read('router-queue.md', text => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('- ')) continue;
      const match = /^- ([A-Z-]+) (RQ-[A-Za-z0-9-]+) \(([^)]*)\):/.exec(line);
      if (!match) { graph.sources['router-queue.md'] = 'partial'; continue; }
      const pool = /(?:^|,\s*)pool=([A-Za-z0-9._-]+)/.exec(match[3]!);
      job({ id: match[2], status: match[1], pool: pool?.[1], pr: /https:\/\/github\.com\/ashlrai\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*/.exec(line)?.[0] });
    }
  });
  await read('jobs.jsonl', text => {
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try { job(row(JSON.parse(line))); } catch { graph.sources['jobs.jsonl'] = 'partial'; }
    }
  });
  await read('slots.json', text => {
    for (const r of rows(JSON.parse(text), 'slots')) {
      const id = token(r['id'] ?? r['slot']); const pool = token(r['pool'] ?? r['lane']);
      if (!id || !pool) { graph.sources['slots.json'] = 'partial'; continue; }
      const s = node('slot', id, token(r['status'])); edge(lane(pool), s, 'contains');
      const jobId = token(r['job'] ?? r['jobId']);
      if (jobId) edge(s, node('job', jobId), 'runs');
    }
  });
  for (const name of ['status.json', 'leader-status.json']) await read(name, text => {
    const r = row(JSON.parse(text));
    if (!Object.keys(r).length) throw new Error('invalid status');
    node('leader', 'router', token(row(r['leader'])['status'] ?? r['status']));
    for (const resource of rows(r['resources'] ?? [], 'resources')) {
      const id = token(resource['id']); const pool = token(resource['pool']);
      if (!id) { graph.sources[name] = 'partial'; continue; }
      edge(pool ? lane(pool) : leader, node('resource', id, token(resource['status'])), 'uses');
    }
  });
  graph.nodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  graph.edges = [...edges.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return graph;
}
