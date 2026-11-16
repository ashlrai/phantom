/**
 * Company-agnostic harness adapters for node autoscaling (RQ-NODE-AUTOSCALE-1).
 *
 * A harness is the local process tree one agent session costs a node: the
 * vendor CLI plus every child it spawns (MCP servers, tool runners, builds).
 * Adapters only name the CLI executable; they never read process arguments,
 * environment or credentials. Adding a provider means adding one row here.
 */

export type HarnessKind = 'cloud-cli' | 'local-model';

export interface HarnessAdapter {
  /** Stable harness id used in node-capacity.json and by the router. */
  id: string;
  kind: HarnessKind;
  /** Kernel process names (ucomm, at most 16 bytes) that start a session tree. */
  names: readonly string[];
  /** Optional name pattern for CLIs whose kernel name is not stable. */
  pattern?: RegExp;
}

/**
 * Desktop apps (Claude, Codex, Grok, Devin with capital letters) are operator
 * GUIs, not agent sessions, so they are deliberately absent. The Claude Code
 * native build execs from a versioned path, so its kernel name is the bare
 * version (for example `2.1.321`); nothing else on a Mac is named like that.
 */
export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = Object.freeze([
  { id: 'codex', kind: 'cloud-cli', names: ['codex'] },
  { id: 'claude', kind: 'cloud-cli', names: ['claude'], pattern: /^\d+\.\d+\.\d+$/ },
  { id: 'grok', kind: 'cloud-cli', names: ['grok', 'grok-native'] },
  { id: 'devin', kind: 'cloud-cli', names: ['devin'] },
  { id: 'cursor', kind: 'cloud-cli', names: ['cursor-agent'] },
  { id: 'gemini', kind: 'cloud-cli', names: ['gemini'] },
  { id: 'local-model', kind: 'local-model', names: ['ollama', 'llama-server', 'omlx'] },
]);

export function harnessFor(name: string, adapters: readonly HarnessAdapter[] = HARNESS_ADAPTERS): HarnessAdapter | null {
  for (const adapter of adapters) {
    if (adapter.names.includes(name) || adapter.pattern?.test(name)) return adapter;
  }
  return null;
}

/** One numeric process row. Names are kernel short names only, never command lines. */
export interface ProcessRow {
  pid: number;
  ppid: number | null;
  name: string;
  /** Resident (ps) or physical footprint (footprint) bytes; null when unreadable. */
  memBytes: number | null;
  /** Percent of one core; null when the source cannot report it. */
  cpuPercent: number | null;
}

export interface HarnessSession {
  harness: string;
  rootPid: number;
  processes: number;
  /** Sum over the tree; null when any process in the tree was unreadable. */
  memBytes: number | null;
  cpuPercent: number | null;
}

/**
 * Group process rows into harness sessions. A root is a harness process with
 * no same-harness ancestor, so a CLI that re-execs itself stays one session.
 * `children` is required when rows lack ppid (the pgrep fallback).
 */
export function harnessSessions(rows: readonly ProcessRow[], children: ReadonlyMap<number, readonly number[]>,
  adapters: readonly HarnessAdapter[] = HARNESS_ADAPTERS): HarnessSession[] {
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const harnessOf = new Map<number, string>();
  for (const row of rows) {
    const adapter = harnessFor(row.name, adapters);
    if (adapter) harnessOf.set(row.pid, adapter.id);
  }
  const trees = new Map<number, Set<number>>();
  for (const pid of [...harnessOf.keys()].sort((a, b) => a - b)) {
    const seen = new Set<number>();
    const todo = [pid];
    while (todo.length) {
      const id = todo.pop()!;
      if (seen.has(id) || seen.size > 4096) continue;
      // A different harness spawned inside this tree is its own session; never count it twice.
      if (id !== pid && harnessOf.has(id) && harnessOf.get(id) !== harnessOf.get(pid)) continue;
      seen.add(id);
      todo.push(...(children.get(id) ?? []));
    }
    trees.set(pid, seen);
  }
  const nested = new Set<number>();
  for (const [pid, tree] of trees) {
    for (const member of tree) {
      if (member !== pid && harnessOf.get(member) === harnessOf.get(pid)) nested.add(member);
    }
  }
  const sessions: HarnessSession[] = [];
  for (const [pid, tree] of trees) {
    if (nested.has(pid)) continue;
    let mem: number | null = 0, cpu: number | null = 0;
    for (const member of tree) {
      const row = byPid.get(member);
      if (!row) continue; // exited between listing and measuring
      mem = mem === null || row.memBytes === null ? null : mem + row.memBytes;
      cpu = cpu === null || row.cpuPercent === null ? null : cpu + row.cpuPercent;
    }
    sessions.push({ harness: harnessOf.get(pid)!, rootPid: pid, processes: tree.size, memBytes: mem, cpuPercent: cpu });
  }
  return sessions;
}

/** Children index from rows that carry ppid (the ps path). */
export function childrenFromRows(rows: readonly ProcessRow[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const row of rows) {
    if (row.ppid === null || row.ppid === row.pid) continue;
    const list = out.get(row.ppid);
    if (list) list.push(row.pid); else out.set(row.ppid, [row.pid]);
  }
  return out;
}
