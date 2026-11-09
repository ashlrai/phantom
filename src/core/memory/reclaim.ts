/**
 * core/memory/reclaim.ts -- `phm mem reclaim` planning and apply.
 *
 * Reclaims memory on the operator machine, in three classes only:
 *
 *   (a) idle-model        Models resident in a local inference runtime are
 *                         unloaded ONLY through that runtime's own loopback
 *                         API: Ollama `POST /api/generate` with keep_alive 0,
 *                         oMLX `POST /admin/api/models/{id}/unload`. No keys
 *                         are ever sent; an admin API that wants auth is
 *                         skipped, not fought.
 *   (b) orphaned-process  node, tsserver, rust-analyzer, esbuild and cargo
 *                         processes whose ancestor chain contains no live job
 *                         pid from the router queue status file.
 *   (c) job-leftover      Pids a finished queue job recorded that are still
 *                         alive, plus their live descendants.
 *
 * Hard rules, enforced here rather than by convention:
 *   - Never kill a pid inside a live job's process tree, a live job's
 *     ancestor chain, the reclaim process's own chain, or pid <= 1.
 *   - Never kill a codex process attached to a live job; codex processes are
 *     killable only as the directly recorded pid of a finished job, and a pid
 *     that started AFTER the job finished (pid reuse) is never touched.
 *   - Model unloads go to numeric loopback endpoints only; anything else is
 *     refused before a request is made.
 *   - A queue status file that cannot be read or parsed fails CLOSED: every
 *     action degrades to skip. A missing file means no live jobs exist.
 *   - No auth files (~/.codex*, keychains, env) are read or touched; nothing
 *     here handles secrets at all.
 *
 * The module is pure with injected effects: the process table, queue status,
 * fetch, kill and clocks all arrive through ReclaimDeps, so the safety rules
 * are exercised end to end in tests without touching a real machine.
 */

// ---------------------------------------------------------------------------
// Process table
// ---------------------------------------------------------------------------

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Resident set size in KiB (`ps -o rss`). */
  rssKb: number;
  /** Virtual size in KiB (`ps -o vsz`). */
  vszKb: number;
  /** Elapsed seconds since start (`ps -o etimes`); -1 when unknown. */
  etimesSec: number;
  /** BSD state letter (`ps -o state`); 'Z' rows are dead. */
  state: string;
  /** Basename of argv[0]. */
  name: string;
  /** Full argument vector. */
  argv: string;
}

export const PROCESS_TABLE_ARGS = ['-axww', '-o', 'pid=,ppid=,rss=,vsz=,etimes=,state=,args='];

/**
 * Parse `ps -axww -o pid=,ppid=,rss=,vsz=,etimes=,state=,args=` output.
 * Every column except args is a single whitespace-free token, so the split is
 * unambiguous. Rows that do not parse (or pid <= 1) are dropped.
 */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number.parseInt(m[1] as string, 10);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    const argv = (m[7] as string).trim();
    const argv0 = argv.split(/\s+/)[0] ?? '';
    rows.push({
      pid,
      ppid: Number.parseInt(m[2] as string, 10),
      rssKb: Number.parseInt(m[3] as string, 10),
      vszKb: Number.parseInt(m[4] as string, 10),
      etimesSec: Number.parseInt(m[5] as string, 10),
      state: m[6] as string,
      name: basenameOf(argv0),
      argv,
    });
  }
  return rows;
}

export function basenameOf(path: string): string {
  const trimmed = path.trim();
  const idx = trimmed.lastIndexOf('/');
  return (idx === -1 ? trimmed : trimmed.slice(idx + 1)).toLowerCase();
}

// ---------------------------------------------------------------------------
// Queue status
// ---------------------------------------------------------------------------

export type JobLiveness = 'live' | 'finished' | 'other';

export interface QueueJobView {
  id: string;
  status: string;
  liveness: JobLiveness;
  /** Pids recorded anywhere on the job (job fields and claims). */
  pids: number[];
  /** Latest finishedAt across claims/job fields, ms since epoch, or null. */
  finishedAtMs: number | null;
}

export interface QueueStatusView {
  state: 'ok' | 'missing' | 'invalid';
  path: string | null;
  jobs: QueueJobView[];
  /** Pids recorded by jobs/claims that are still live. */
  liveJobPids: Set<number>;
  /** Pids recorded by finished jobs, mapped to their job id. */
  finishedJobPids: Map<number, { jobId: string; finishedAtMs: number | null }>;
}

/** Statuses that mean a job is in flight. PR-OPEN keeps its claim per the queue contract. */
const LIVE_STATUSES = new Set([
  'running', 'claimed', 'in-progress', 'in_progress', 'active', 'leased',
  'dispatched', 'working', 'started', 'executing', 'busy', 'pr-open', 'pr_open',
]);
/** Statuses whose recorded pids are leftovers when still alive. BLOCKED closes the claim. */
const FINISHED_STATUSES = new Set([
  'done', 'completed', 'finished', 'failed', 'error', 'cancelled', 'canceled',
  'timeout', 'timed-out', 'merged', 'blocked', 'abandoned', 'dead', 'rejected',
]);

const STATUS_KEYS = ['status', 'state', 'phase'] as const;
const ID_KEYS = ['id', 'jobId', 'job_id', 'name', 'job'] as const;
const PID_KEY_RE = /^(?:pid|pids|pgid|rootpid|jobpid|workerpid|processpid|treepids|descendantpids|childpids)$/i;
const CLAIMS_KEY = 'claims';
const MAX_STATUS_WALK_DEPTH = 8;
const MAX_STATUS_JOBS = 512;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pidValues(v: unknown): number[] {
  const one = (n: unknown): number | null =>
    typeof n === 'number' && Number.isInteger(n) && n > 1 ? n : null;
  if (Array.isArray(v)) {
    const out: number[] = [];
    for (const item of v) { const n = one(item); if (n !== null) out.push(n); }
    return out;
  }
  const n = one(v);
  return n === null ? [] : [n];
}

function timestampMs(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function statusOf(rec: Record<string, unknown>): string | null {
  for (const key of STATUS_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim().toLowerCase();
  }
  return null;
}

function jobIdOf(rec: Record<string, unknown>, fallback: string): string {
  for (const key of ID_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim().length > 0 && v.length <= 128) return v.trim();
  }
  return fallback;
}

/** Does this object look like a job record rather than an envelope/summary? */
function looksLikeJob(rec: Record<string, unknown>): boolean {
  if (statusOf(rec) !== null) return true;
  if (Array.isArray(rec[CLAIMS_KEY])) return true;
  for (const key of Object.keys(rec)) {
    if (PID_KEY_RE.test(key)) return true;
  }
  return false;
}

interface RawJob {
  id: string;
  status: string | null;
  pids: number[];
  livePids: number[];
  finishedPids: number[];
  hasOpenClaim: boolean;
  hasClosedClaim: boolean;
  finishedAtMs: number | null;
}

function readClaim(claim: Record<string, unknown>): {
  pids: number[]; open: boolean; finishedAtMs: number | null;
} {
  const pids: number[] = [];
  for (const key of Object.keys(claim)) {
    if (PID_KEY_RE.test(key)) pids.push(...pidValues(claim[key]));
  }
  const finishedAtMs = timestampMs(claim['finishedAt'] ?? claim['finished_at'] ?? claim['endedAt'] ?? claim['completedAt']);
  return { pids, open: finishedAtMs === null, finishedAtMs };
}

function readJob(rec: Record<string, unknown>, fallbackId: string): RawJob {
  const status = statusOf(rec);
  const pids: number[] = [];
  const livePids: number[] = [];
  const finishedPids: number[] = [];
  let hasOpenClaim = false;
  let hasClosedClaim = false;
  let finishedAtMs = timestampMs(
    rec['finishedAt'] ?? rec['finished_at'] ?? rec['completedAt'] ?? rec['endedAt'],
  );

  for (const key of Object.keys(rec)) {
    if (PID_KEY_RE.test(key)) pids.push(...pidValues(rec[key]));
  }
  const claims = rec[CLAIMS_KEY];
  if (Array.isArray(claims)) {
    for (const c of claims) {
      if (!isRecord(c)) continue;
      const parsed = readClaim(c);
      pids.push(...parsed.pids);
      if (parsed.open) {
        hasOpenClaim = true;
        livePids.push(...parsed.pids);
      } else {
        hasClosedClaim = true;
        finishedPids.push(...parsed.pids);
        if (parsed.finishedAtMs !== null && (finishedAtMs === null || parsed.finishedAtMs > finishedAtMs)) {
          finishedAtMs = parsed.finishedAtMs;
        }
      }
    }
  }
  return { id: jobIdOf(rec, fallbackId), status, pids, livePids, finishedPids, hasOpenClaim, hasClosedClaim, finishedAtMs };
}

/**
 * Collect job-like records anywhere in the status document, tolerating the
 * shapes different writers produce: `jobs: []`, keyed job maps, grouped
 * `running`/`finished` arrays, or a bare top-level array. Job records are not
 * descended into (their `claims` are not jobs); everything else is.
 */
function collectJobRecords(json: unknown, out: { rec: Record<string, unknown>; fallbackId: string }[]): void {
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_STATUS_WALK_DEPTH || out.length >= MAX_STATUS_JOBS) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (isRecord(item) && looksLikeJob(item)) {
          if (out.length < MAX_STATUS_JOBS) {
            out.push({ rec: item, fallbackId: `job-${out.length + 1}` });
          }
        } else {
          walk(item, depth + 1);
        }
      }
      return;
    }
    if (!isRecord(node)) return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (isRecord(value)) {
        // A keyed map of job records: the key is the job id.
        if (looksLikeJob(value) && statusOf(value) !== null) {
          if (out.length < MAX_STATUS_JOBS) out.push({ rec: value, fallbackId: key });
        } else {
          walk(value, depth + 1);
        }
      } else if (Array.isArray(value)) {
        walk(value, depth + 1);
      }
    }
  };
  walk(json, 0);
}

function livenessOf(raw: RawJob): JobLiveness {
  // An open claim is the strongest live signal; it outranks a stale status.
  if (raw.hasOpenClaim) return 'live';
  if (raw.status !== null) {
    if (LIVE_STATUSES.has(raw.status)) return 'live';
    if (FINISHED_STATUSES.has(raw.status)) return 'finished';
    return 'other';
  }
  if (raw.hasClosedClaim) return 'finished';
  return 'other';
}

/**
 * Tolerant parse of the router queue status document. Unknown shapes yield
 * zero jobs (state 'ok'), never a crash; a non-object payload is 'invalid'.
 */
export function parseQueueStatusJson(json: unknown, path: string | null): QueueStatusView {
  if (!isRecord(json) && !Array.isArray(json)) {
    return { state: 'invalid', path, jobs: [], liveJobPids: new Set(), finishedJobPids: new Map() };
  }
  const found: { rec: Record<string, unknown>; fallbackId: string }[] = [];
  collectJobRecords(json, found);
  const jobs: QueueJobView[] = [];
  const liveJobPids = new Set<number>();
  const finishedJobPids = new Map<number, { jobId: string; finishedAtMs: number | null }>();
  const seenJobIds = new Set<string>();
  for (const { rec, fallbackId } of found) {
    const raw = readJob(rec, fallbackId);
    const liveness = livenessOf(raw);
    let id = raw.id;
    while (seenJobIds.has(id)) id = `${id}~`;
    seenJobIds.add(id);
    jobs.push({ id, status: raw.status ?? 'unknown', liveness, pids: raw.pids, finishedAtMs: raw.finishedAtMs });
    if (liveness === 'live') {
      for (const pid of raw.pids) liveJobPids.add(pid);
      for (const pid of raw.livePids) liveJobPids.add(pid);
    } else if (liveness === 'finished') {
      for (const pid of raw.pids) finishedJobPids.set(pid, { jobId: id, finishedAtMs: raw.finishedAtMs });
    }
  }
  return { state: 'ok', path, jobs, liveJobPids, finishedJobPids };
}

// ---------------------------------------------------------------------------
// Process tree protection
// ---------------------------------------------------------------------------

/**
 * The never-kill set: each live job pid, every descendant it still has, every
 * ancestor above it, and the reclaim process's own chain. A candidate is only
 * killable when it is outside this set AND its own ancestor chain contains no
 * live job pid (the spec's orphan test, checked separately in classify()).
 */
export function computeProtectedPids(
  table: readonly ProcessRow[],
  liveJobPids: ReadonlySet<number>,
  selfPid: number,
): Set<number> {
  const byPid = new Map<number, ProcessRow>();
  const children = new Map<number, number[]>();
  for (const row of table) {
    byPid.set(row.pid, row);
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const protectedPids = new Set<number>([0, 1]);

  const protectChain = (start: number): void => {
    // Self + ancestors.
    let cur: number | undefined = start;
    const seen = new Set<number>();
    while (cur !== undefined && cur > 1 && !seen.has(cur)) {
      seen.add(cur);
      protectedPids.add(cur);
      cur = byPid.get(cur)?.ppid;
    }
    // Descendants. A dedicated seen-set: `start` is often already in
    // protectedPids via the ancestor walk, and skipping it here would drop
    // its children from the closure.
    const stack = [start];
    const seenDesc = new Set<number>();
    while (stack.length > 0) {
      const pid = stack.pop() as number;
      if (seenDesc.has(pid)) continue;
      seenDesc.add(pid);
      protectedPids.add(pid);
      for (const child of children.get(pid) ?? []) stack.push(child);
    }
  };

  for (const pid of liveJobPids) protectChain(pid);
  protectChain(selfPid);
  return protectedPids;
}

/** Walk the ppid chain upward from `pid`; stops at pid 1, gaps and cycles. */
export function ancestorPids(pid: number, table: readonly ProcessRow[]): number[] {
  const byPid = new Map<number, number>();
  for (const row of table) byPid.set(row.pid, row.ppid);
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  let cur = byPid.get(pid);
  while (cur !== undefined && cur > 1 && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = byPid.get(cur);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidate classification
// ---------------------------------------------------------------------------

export const RECLAIM_CLASSES = ['idle-model', 'orphaned-process', 'job-leftover'] as const;
export type ReclaimClass = (typeof RECLAIM_CLASSES)[number];

/** Process names the spec allows class (b) to reclaim. */
export const ORPHAN_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'node', 'nodejs', 'tsserver', 'rust-analyzer', 'rust_analyzer', 'esbuild', 'cargo',
]);
/** argv tokens (by basename) that mark a reclaimable helper even under a wrapper. */
const ORPHAN_ARGV_TOKENS: ReadonlySet<string> = new Set([
  'tsserver.js', 'tsserver', 'rust-analyzer', 'esbuild', 'cargo',
]);
const CODEX_NAME_RE = /^codex(?=$|[-._])/i;

export function isCodexProcess(row: Pick<ProcessRow, 'name' | 'argv'>): boolean {
  if (CODEX_NAME_RE.test(row.name)) return true;
  for (const token of row.argv.split(/\s+/)) {
    // Path segments too: `/opt/codex-cli/dist/cli.js` hides codex in a
    // directory component, which a basename-only check would miss.
    for (const segment of token.split('/')) {
      if (CODEX_NAME_RE.test(segment.toLowerCase())) return true;
    }
  }
  return false;
}

export function isOrphanTargetProcess(row: Pick<ProcessRow, 'name' | 'argv'>): boolean {
  if (ORPHAN_PROCESS_NAMES.has(row.name)) return true;
  for (const token of row.argv.split(/\s+/)) {
    if (ORPHAN_ARGV_TOKENS.has(basenameOf(token))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Loopback endpoints
// ---------------------------------------------------------------------------

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OMLX_BASE_URL = 'http://127.0.0.1:8000';

/**
 * Normalize an inference base URL, refusing anything that is not plain http on
 * a loopback host. No userinfo, query, fragment or non-canonical host survives.
 */
export function loopbackHttpBase(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  const host = parsed.hostname;
  const loopback =
    host === 'localhost' || host === '[::1]' || host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback) return null;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split('.').map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return null;
  }
  return parsed.origin;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export const MEM_RECLAIM_SCHEMA = 'mem-reclaim.v1' as const;

export type ReclaimAction = 'kill' | 'unload' | 'skip';

export interface ReclaimEntry {
  pid: number | null;
  class: ReclaimClass;
  /** Process name for kills, model id for unloads. */
  name: string;
  runtime?: 'ollama' | 'omlx';
  model?: string;
  jobId?: string;
  rssKb: number | null;
  swapKb?: number | null;
  reason: string;
  action: ReclaimAction;
  /** apply only. */
  result?: 'ok' | 'failed' | 'skipped';
  detail?: string;
}

export interface ReclaimReport {
  schema: typeof MEM_RECLAIM_SCHEMA;
  mode: 'dry-run' | 'apply';
  startedAt: string;
  queueStatus: {
    path: string | null;
    state: QueueStatusView['state'];
    liveJobs: number;
    finishedJobs: number;
    livePids: number;
  };
  processes: number;
  protectedPids: number;
  totals: {
    candidates: number;
    reclaimableKb: number;
    actions: number;
    skipped: number;
    errors: number;
  };
  /** Set when the run was prevented from acting (fail-closed). */
  blocked?: string;
  entries: ReclaimEntry[];
}

// ---------------------------------------------------------------------------
// Deps + options
// ---------------------------------------------------------------------------

export interface ReclaimDeps {
  readProcessTable(): Promise<ProcessRow[]>;
  readQueueStatus(): Promise<QueueStatusView>;
  fetchImpl: typeof fetch;
  killPid(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void | Promise<void>;
  pidAlive(pid: number): Promise<boolean> | boolean;
  sleep(ms: number): Promise<void>;
  selfPid: number;
  /** Swapped-out bytes for a pid (vmmap); absent or null = unknown. */
  swapKb?(pid: number): Promise<number | null>;
}

export interface ReclaimPlanOptions {
  apply: boolean;
  probeModels: boolean;
  withVmmap: boolean;
  killGraceMs: number;
  ollamaBaseUrl: string | null;
  omlxBaseUrl: string | null;
}

export const DEFAULT_RECLAIM_OPTIONS: ReclaimPlanOptions = {
  apply: false,
  probeModels: true,
  withVmmap: false,
  killGraceMs: 3_000,
  ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  omlxBaseUrl: DEFAULT_OMLX_BASE_URL,
};

const PROBE_TIMEOUT_MS = 2_500;
const UNLOAD_TIMEOUT_MS = 10_000;
const MAX_VMMAP_PIDS = 32;

function kbOfBytes(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v / 1024);
}

async function fetchJsonBounded(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
    const text = await res.text();
    if (text.length > 4 * 1024 * 1024) return { ok: false, status: res.status, body: null };
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Model inventory probes (loopback only, no credentials ever)
// ---------------------------------------------------------------------------

interface LoadedModel {
  runtime: 'ollama' | 'omlx';
  model: string;
  sizeKb: number | null;
  detail: string | null;
}

async function probeOllamaLoaded(
  fetchImpl: typeof fetch,
  base: string,
): Promise<LoadedModel[] | 'unreachable' | 'invalid'> {
  const res = await fetchJsonBounded(fetchImpl, `${base}/api/ps`, PROBE_TIMEOUT_MS);
  if (res.status === 0) return 'unreachable';
  if (!isRecord(res.body) || !Array.isArray(res.body['models'])) return 'invalid';
  const out: LoadedModel[] = [];
  for (const entry of res.body['models']) {
    if (!isRecord(entry)) continue;
    const name = typeof entry['name'] === 'string' ? entry['name'] : typeof entry['model'] === 'string' ? entry['model'] : null;
    if (!name) continue;
    const expires = typeof entry['expires_at'] === 'string' ? entry['expires_at'] : null;
    out.push({
      runtime: 'ollama',
      model: name,
      sizeKb: kbOfBytes(entry['size'] ?? entry['size_vram']),
      detail: expires ? `keep-alive expires ${expires}` : null,
    });
  }
  return out;
}

function omlxModelId(entry: Record<string, unknown>): string | null {
  for (const key of ['id', 'model_id', 'modelId', 'name', 'model'] as const) {
    const v = entry[key];
    if (typeof v === 'string' && v.length > 0 && v.length <= 256) return v;
  }
  return null;
}

function omlxIsLoaded(entry: Record<string, unknown>): boolean {
  for (const key of ['is_loaded', 'isLoaded', 'loaded'] as const) {
    if (typeof entry[key] === 'boolean') return entry[key] as boolean;
  }
  for (const key of ['state', 'status'] as const) {
    const v = entry[key];
    if (typeof v === 'string' && /^(loaded|ready|resident|active|warm)$/i.test(v)) return true;
    if (typeof v === 'string') return false;
  }
  return false;
}

async function probeOmlxLoaded(
  fetchImpl: typeof fetch,
  base: string,
): Promise<LoadedModel[] | 'unreachable' | 'invalid' | 'auth-required'> {
  const res = await fetchJsonBounded(fetchImpl, `${base}/admin/api/models`, PROBE_TIMEOUT_MS);
  if (res.status === 0) return 'unreachable';
  if (res.status === 401 || res.status === 403) return 'auth-required';
  const list = Array.isArray(res.body)
    ? res.body
    : isRecord(res.body) && Array.isArray(res.body['models'])
      ? (res.body['models'] as unknown[])
      : null;
  if (list === null) return 'invalid';
  const out: LoadedModel[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    if (!omlxIsLoaded(entry)) continue;
    const model = omlxModelId(entry);
    if (!model) continue;
    out.push({
      runtime: 'omlx',
      model,
      sizeKb: kbOfBytes(entry['estimated_size'] ?? entry['size_bytes'] ?? entry['sizeBytes'] ?? entry['size']),
      detail: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Build the reclaim plan: inventory the table, classify candidates and probe
 * the runtimes. Pure of side effects -- nothing is killed or unloaded here.
 */
export async function planReclaim(
  options: ReclaimPlanOptions,
  deps: ReclaimDeps,
): Promise<ReclaimReport> {
  const [table, status] = await Promise.all([deps.readProcessTable(), deps.readQueueStatus()]);
  const blocked = status.state === 'invalid' ? 'queue-status-unreadable' : undefined;
  const protectedPids = computeProtectedPids(table, status.liveJobPids, deps.selfPid);
  const liveJobs = status.jobs.filter((j) => j.liveness === 'live').length;
  const finishedJobs = status.jobs.filter((j) => j.liveness === 'finished').length;

  const entries: ReclaimEntry[] = [];
  const push = (e: ReclaimEntry): void => {
    if (blocked && e.action !== 'skip') {
      e.action = 'skip';
      e.reason = `${e.reason}; blocked: queue status unreadable`;
    }
    entries.push(e);
  };

  const byPid = new Map<number, ProcessRow>();
  const children = new Map<number, number[]>();
  for (const row of table) {
    byPid.set(row.pid, row);
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const aliveRow = (pid: number): ProcessRow | undefined => {
    const row = byPid.get(pid);
    return row && !row.state.startsWith('Z') ? row : undefined;
  };

  // (c) finished-job leftovers: recorded pids still alive + their live descendants.
  const leftoverSeen = new Set<number>();
  const leftoverCandidate = (pid: number, jobId: string, finishedAtMs: number | null, via: string): void => {
    if (leftoverSeen.has(pid)) return;
    leftoverSeen.add(pid);
    const row = aliveRow(pid);
    if (!row) return;
    if (protectedPids.has(pid)) {
      push({
        pid, class: 'job-leftover', name: row.name, jobId, rssKb: row.rssKb,
        reason: `pid recorded by finished job ${jobId} now sits inside a live job tree`,
        action: 'skip',
      });
      return;
    }
    const codex = isCodexProcess(row);
    const startedAfterFinish =
      finishedAtMs !== null && row.etimesSec >= 0 &&
      Date.now() - row.etimesSec * 1000 > finishedAtMs;
    if (startedAfterFinish || (codex && via !== 'recorded')) {
      push({
        pid, class: 'job-leftover', name: row.name, jobId, rssKb: row.rssKb,
        reason: startedAfterFinish
          ? `pid recorded by finished job ${jobId}, but the process started after the job finished (pid reuse)`
          : `codex process ${via} finished job ${jobId}; only recorded pids are killable`,
        action: 'skip',
      });
      return;
    }
    push({
      pid, class: 'job-leftover', name: row.name, jobId, rssKb: row.rssKb,
      reason: `still alive after job ${jobId} finished (${via})`,
      action: 'kill',
    });
  };

  for (const [pid, info] of status.finishedJobPids) {
    leftoverCandidate(pid, info.jobId, info.finishedAtMs, 'recorded pid');
    const stack = [...(children.get(pid) ?? [])];
    const seen = new Set<number>(leftoverSeen);
    while (stack.length > 0) {
      const child = stack.pop() as number;
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(...(children.get(child) ?? []));
      leftoverCandidate(child, info.jobId, info.finishedAtMs, `descendant of recorded pid ${pid}`);
    }
  }

  // (b) orphaned dev processes: target names, outside every live job tree.
  for (const row of table) {
    if (row.state.startsWith('Z') || leftoverSeen.has(row.pid)) continue;
    if (!isOrphanTargetProcess(row)) continue;
    if (protectedPids.has(row.pid)) continue;
    const ancestors = ancestorPids(row.pid, table);
    const liveAncestor = ancestors.find((a) => status.liveJobPids.has(a));
    if (liveAncestor !== undefined) continue; // inside a live job's tree
    if (isCodexProcess(row)) {
      push({
        pid: row.pid, class: 'orphaned-process', name: row.name, rssKb: row.rssKb,
        reason: 'codex-shaped process outside live job trees; codex is only reclaimable as a finished-job leftover',
        action: 'skip',
      });
      continue;
    }
    push({
      pid: row.pid, class: 'orphaned-process', name: row.name, rssKb: row.rssKb,
      reason: `${row.name} with no live job pid in its ancestor chain`,
      action: 'kill',
    });
  }

  // (a) idle resident models, via each runtime's own loopback API.
  if (options.probeModels) {
    const modelProbe = async (
      runtime: 'ollama' | 'omlx',
      rawBase: string | null,
      probe: (f: typeof fetch, base: string) => Promise<LoadedModel[] | 'unreachable' | 'invalid' | 'auth-required'>,
    ): Promise<void> => {
      if (rawBase === null) return;
      const base = loopbackHttpBase(rawBase);
      if (base === null) {
        push({
          pid: null, class: 'idle-model', name: runtime, runtime,
          rssKb: null, reason: `refused non-loopback ${runtime} base url`, action: 'skip',
        });
        return;
      }
      const loaded = await probe(deps.fetchImpl, base);
      if (!Array.isArray(loaded)) {
        if (loaded === 'auth-required' || loaded === 'invalid') {
          push({
            pid: null, class: 'idle-model', name: runtime, runtime, rssKb: null,
            reason: loaded === 'auth-required'
              ? `${runtime} requires auth; reclaim never sends credentials`
              : `${runtime} answered with an unreadable model list`,
            action: 'skip',
          });
        }
        return; // 'unreachable': runtime not running, nothing resident
      }
      for (const m of loaded) {
        push({
          pid: null, class: 'idle-model', name: m.model, runtime: m.runtime, model: m.model,
          rssKb: m.sizeKb,
          reason: `resident in ${m.runtime}${m.detail ? ` (${m.detail})` : ''}; unload goes through the runtime API`,
          action: 'unload',
        });
      }
    };
    await Promise.all([
      modelProbe('ollama', options.ollamaBaseUrl, probeOllamaLoaded),
      modelProbe('omlx', options.omlxBaseUrl, probeOmlxLoaded),
    ]);
  }

  if (options.withVmmap && deps.swapKb) {
    let enriched = 0;
    for (const e of entries) {
      if (e.pid === null || e.action === 'skip' || enriched >= MAX_VMMAP_PIDS) continue;
      enriched += 1;
      const kb = await deps.swapKb(e.pid);
      if (kb !== null) e.swapKb = kb;
    }
  }

  const reclaimableKb = entries.reduce((sum, e) => sum + (e.action === 'skip' ? 0 : e.rssKb ?? 0), 0);
  const actions = entries.filter((e) => e.action !== 'skip').length;
  return {
    schema: MEM_RECLAIM_SCHEMA,
    mode: options.apply ? 'apply' : 'dry-run',
    startedAt: new Date().toISOString(),
    queueStatus: {
      path: status.path,
      state: status.state,
      liveJobs,
      finishedJobs,
      livePids: status.liveJobPids.size,
    },
    processes: table.length,
    protectedPids: protectedPids.size,
    totals: {
      candidates: entries.length,
      reclaimableKb,
      actions,
      skipped: entries.length - actions,
      errors: 0,
    },
    ...(blocked ? { blocked } : {}),
    entries,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function waitForExit(deps: ReclaimDeps, pid: number, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await deps.pidAlive(pid))) return true;
    await deps.sleep(50);
  }
  return !(await deps.pidAlive(pid));
}

async function unloadModel(
  deps: ReclaimDeps,
  base: string,
  entry: ReclaimEntry,
): Promise<string | null> {
  if (entry.runtime === 'ollama') {
    const res = await fetchJsonBounded(
      deps.fetchImpl, `${base}/api/generate`, UNLOAD_TIMEOUT_MS,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: entry.model, keep_alive: 0, stream: false }),
      },
    );
    if (res.status === 0) return 'unreachable';
    if (res.status < 200 || res.status >= 300) return `http ${res.status}`;
    return null;
  }
  if (entry.runtime === 'omlx') {
    const res = await fetchJsonBounded(
      deps.fetchImpl,
      `${base}/admin/api/models/${encodeURIComponent(entry.model as string)}/unload`,
      UNLOAD_TIMEOUT_MS,
      { method: 'POST' },
    );
    if (res.status === 0) return 'unreachable';
    if (res.status === 401 || res.status === 403) return 'auth-required';
    if (res.status < 200 || res.status >= 300) return `http ${res.status}`;
    return null;
  }
  return 'unknown-runtime';
}

/**
 * Execute a plan's actions. Safety is re-verified against the plan itself:
 * the plan was computed from the same table/status snapshot moments earlier,
 * entries already reflect the protected set, and kills re-check liveness.
 */
export async function applyReclaim(
  report: ReclaimReport,
  options: ReclaimPlanOptions,
  deps: ReclaimDeps,
): Promise<ReclaimReport> {
  let errors = 0;
  const ollamaBase = options.ollamaBaseUrl === null ? null : loopbackHttpBase(options.ollamaBaseUrl);
  const omlxBase = options.omlxBaseUrl === null ? null : loopbackHttpBase(options.omlxBaseUrl);

  for (const entry of report.entries) {
    if (entry.action === 'skip') {
      entry.result = 'skipped';
      continue;
    }
    if (report.blocked) {
      entry.result = 'skipped';
      entry.detail = report.blocked;
      continue;
    }
    if (entry.action === 'unload') {
      const base = entry.runtime === 'ollama' ? ollamaBase : omlxBase;
      if (base === null) {
        entry.result = 'skipped';
        entry.detail = 'non-loopback-base-url';
        continue;
      }
      const problem = await unloadModel(deps, base, entry);
      if (problem === null) {
        entry.result = 'ok';
      } else {
        entry.result = 'failed';
        entry.detail = problem;
        errors += 1;
      }
      continue;
    }
    // action === 'kill'
    const pid = entry.pid as number;
    try {
      if (!(await deps.pidAlive(pid))) {
        entry.result = 'ok';
        entry.detail = 'already-exited';
        continue;
      }
      await deps.killPid(pid, 'SIGTERM');
      if (!(await waitForExit(deps, pid, options.killGraceMs))) {
        await deps.killPid(pid, 'SIGKILL');
        await waitForExit(deps, pid, 1_000);
      }
      entry.result = 'ok';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        entry.result = 'ok';
        entry.detail = 'already-exited';
      } else {
        entry.result = 'failed';
        entry.detail = code ?? (err instanceof Error ? err.message : String(err));
        errors += 1;
      }
    }
  }
  report.totals.errors = errors;
  return report;
}
