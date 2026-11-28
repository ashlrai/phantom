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
 * version (for example `2.1.321`); the same binary's non-session modes share
 * that name — `claude --chrome-native-host` is a ~12 MiB Chrome helper, not a
 * session — so harnessSessions drops a harness root with a browser ancestor
 * (see spawnedByBrowser below).
 */
export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = Object.freeze([
  { id: 'codex', kind: 'cloud-cli', names: ['codex'] },
  { id: 'claude', kind: 'cloud-cli', names: ['claude'], pattern: /^\d+\.\d+\.\d+$/ },
  { id: 'grok', kind: 'cloud-cli', names: ['grok', 'grok-native'] },
  { id: 'devin', kind: 'cloud-cli', names: ['devin'] },
  { id: 'cursor', kind: 'cloud-cli', names: ['cursor-agent'] },
  { id: 'gemini', kind: 'cloud-cli', names: ['gemini'] },
  // The remaining builtin cli-agent engines, named by their engine-registry
  // `bins` (ashlrcode installs as `ac` or `ashlrcode`). api-model engines run
  // inside the dispatcher process and own no CLI session tree to measure.
  { id: 'aw', kind: 'cloud-cli', names: ['aw'] },
  { id: 'ashlrcode', kind: 'cloud-cli', names: ['ac', 'ashlrcode'] },
  { id: 'hermes', kind: 'cloud-cli', names: ['hermes'] },
  { id: 'opencode', kind: 'cloud-cli', names: ['opencode'] },
  // The remaining terminal agents a community node can run: the apps
  // catalog's agent binaries (aider, goose, droid, pi, cline) plus GitHub
  // Copilot CLI. Without a row their sessions are invisible to `phm node
  // capacity` and `phm node route` drops their cost rows as unknown harness.
  // Kernel names only: a pip-installed aider execs its interpreter and stays
  // unmeasured like every other script, while the standalone `aider` binary
  // measures normally.
  { id: 'aider', kind: 'cloud-cli', names: ['aider'] },
  { id: 'goose', kind: 'cloud-cli', names: ['goose'] },
  { id: 'droid', kind: 'cloud-cli', names: ['droid'] },
  { id: 'pi', kind: 'cloud-cli', names: ['pi'] },
  { id: 'cline', kind: 'cloud-cli', names: ['cline'] },
  { id: 'copilot', kind: 'cloud-cli', names: ['copilot'] },
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
 * Comm names of standalone web browsers (ucomm, at most 16 bytes). A harness
 * process spawned beneath one is a browser helper, not an agent session —
 * `claude --chrome-native-host`, the Claude for Chrome native messaging host,
 * shares the versioned binary's kernel name (`2.1.126`) with a real session.
 * argv is never read, so the ancestor chain is the only signal; the list
 * covers the major browsers and stays best-effort: an unlisted browser keeps
 * its helper counted, which is the pre-change behavior, never a wrong
 * exclusion. Agent sessions are launched by terminals, IDEs and dispatchers,
 * never by a browser — remote IDEs run their processes server-side, so a
 * local harness process with a browser ancestor is always a helper.
 */
const BROWSER_ANCESTOR = /(?:^|[^a-z0-9])(?:google[ _-]?chrome|chrome|chromium|firefox|safari|microsoft[ _-]?edge|msedge|brave(?:[ _-]?browser)?|opera|vivaldi|arc|dia|comet|epiphany|librewolf|waterfox|floorp)(?=$|[^a-z0-9])/i;

/** True when the session root's ancestor chain passes through a browser.
 * Rows without ppid (the pgrep+footprint fallback) cannot prove ancestry and
 * keep the session; a missing ancestor row means the same. */
function spawnedByBrowser(rootPid: number, byPid: ReadonlyMap<number, ProcessRow>): boolean {
  const seen = new Set<number>([rootPid]);
  let pid = byPid.get(rootPid)?.ppid ?? null;
  while (pid !== null && pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    const row = byPid.get(pid);
    if (row === undefined) return false;
    if (BROWSER_ANCESTOR.test(row.name)) return true;
    pid = row.ppid;
  }
  return false;
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
    if (spawnedByBrowser(pid, byPid)) continue;
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
