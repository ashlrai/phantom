/**
 * `phm fleet session-audit` — per-lane inventory of agent-CLI session state.
 *
 * WHY THIS EXISTS. Every fleet lane and Verse seat pins its CLI to a home the
 * CLI then fills with session state it never deletes: codex rollouts under
 * `sessions/YYYY/MM/DD/rollout-*.jsonl`, claude transcripts under
 * `projects/<cwd-slug>/<id>.jsonl`, grok session trees under
 * `sessions/<encoded-cwd>/<id>/`, and the devin lane's task records under
 * `$ASHLR_HOME/devin/tasks/*.json`. Disk-maint's agent-sessions class reaps
 * leftovers purely by age; this audit answers the question age cannot —
 * which sessions are big, old, and provably done publishing their results.
 *
 * LANE HOMES scanned:
 *   devin           <ashlrDir>/devin — one `tasks/<id>.json` per remote session
 *   codex-cmp       $CODEX_HOME (default ~/.codex)
 *   codex-personal  $CODEX_HOME_ALT (default ~/.codex-2)
 *   claude          $CLAUDE_CONFIG_DIR (default ~/.claude)
 *   <profile>       <ashlrDir>/native-profiles/<name>/native-state, provider
 *                   from the profile's own profile.json (codex/claude/grok).
 *
 * A "session" is the smallest unit a resume could need: one rollout file,
 * one transcript file, one grok session directory, or one devin task record.
 * Nothing else under a lane home — auth.json, config.toml, sqlite state,
 * settings, credentials, todos, history — is ever enumerated as a session.
 *
 * --prune-plan lists only sessions that are BOTH older than --older-than-days
 * AND have published results the local file is not the last copy of:
 *   devin   terminal state (merged/closed/failed/expired) with a recorded
 *           pr or report — the outcome lives on GitHub/in the record the
 *           fleet already consumed.
 *   others  the session's cwd provably names a job worktree (claude encodes
 *           it in the projects/ slug, grok percent-encodes it in the
 *           sessions/ dir, codex carries it in session_meta.cwd) whose jobs
 *           ledger attempt finished MERGED, published RESULT PR/EMPTY, or
 *           finished empty. Sessions with no job linkage, an unreadable
 *           ledger, or an ambiguous slug are never eligible — unknown never
 *           counts as safe.
 *
 * READ-ONLY: no deletes, no publishes, no queue writes; the plan names
 * candidate paths and leaves every removal to the operator. All readers are
 * injectable for hermetic tests.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { readSource, type Source } from './runs-parked-queue.js';
import { parseAuditLedger, type WtJobLedger } from './wt-audit.js';

export const SESSION_AUDIT_SCHEMA = 'fleet.session-audit.v1' as const;
export const SESSION_AUDIT_MAX_JOBS_BYTES = 8 * 1024 * 1024;
/** Session-meta head read per codex rollout — session_meta is the first record. */
export const SESSION_META_HEAD_BYTES = 256 * 1024;
/** Rollout head reads per run; beyond this aged rollouts stay unproven. */
export const SESSION_AUDIT_MAX_HEAD_READS = 1_024;
/** Session entries enumerated per lane home; beyond it the lane is partial. */
export const SESSION_AUDIT_MAX_SESSIONS_PER_LANE = 8_192;
/** Entries a grok session-dir size walk may touch. */
const GROK_DIR_WALK_LIMIT = 4_096;
/** Small ceiling for a devin task record or a profile.json read. */
const SMALL_FILE_BYTES = 256 * 1024;
const DAY_MS = 86_400_000;

/** dispatchd's job-id shape (same rule as wt-audit/wt-reap). */
export const SESSION_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Recovery/backup profile copies belong to disk-maint's recovery-dirs class. */
const RECOVERY_PROFILE = /(recovery|backup)-\w{4,}$/i;
const PROVIDERS = new Set(['codex', 'claude', 'grok'] as const);
/** Terminal devin task states — non-terminal records are still resumable. */
const DEVIN_TERMINAL = new Set(['merged', 'closed', 'failed', 'expired']);
const ROLLOUT = /^rollout-[\w.-]+\.jsonl$/;
const TRANSCRIPT = /^[\w.-]+\.jsonl$/;

export type SessionProvider = 'codex' | 'claude' | 'grok' | 'devin';
export type SessionKind = 'rollout' | 'transcript' | 'session-dir' | 'task';
/** Published-result evidence classes a prune entry may cite. */
export type SessionEvidence =
  | 'merged' | 'published-pr' | 'published-empty' | 'finished-empty'
  | 'task-pr' | 'task-report';

/** What a probe learned about a path; 'degraded' means it exists but refused. */
export type Probe<T> = T | 'missing' | 'degraded';

/** Filesystem surface the audit needs; every call fails soft. */
export interface SessionAuditFs {
  /** Direct children of a dir: 'missing' when absent, 'degraded' when unreadable. */
  entries(path: string): Promise<Probe<Array<{ name: string; isDir: boolean; isFile: boolean }>>>;
  /** lstat facts, 'missing' when absent, 'degraded' when present-but-unreadable. */
  stat(path: string): Promise<Probe<{ mtimeMs: number; size: number; isFile: boolean; isDir: boolean }>>;
  /** Bounded file text (at most `max` bytes); null when absent/unreadable/oversized. */
  head(path: string, max: number): Promise<string | null>;
}

const defaultFs: SessionAuditFs = {
  async entries(path) {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .map(e => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR'
        ? 'missing' : 'degraded';
    }
  },
  async stat(path) {
    try {
      const s = await lstat(path);
      return { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile(), isDir: s.isDirectory() };
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR'
        ? 'missing' : 'degraded';
    }
  },
  async head(path, max) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile()) return null;
      const buffer = Buffer.alloc(Math.min(info.size, max));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      return buffer.subarray(0, length).toString('utf8');
    } catch { return null; } finally { await file?.close().catch(() => undefined); }
  },
};

// ---------------------------------------------------------------------------
// Lane homes
// ---------------------------------------------------------------------------

export interface SessionLaneHome {
  /** Lane id: 'devin', 'codex-cmp', 'codex-personal', 'claude', or a native-profile name. */
  lane: string;
  provider: SessionProvider;
  /** The session-state root (never the whole home — state subtrees only). */
  home: string;
  /** 'pool' = dispatchd lane home; 'profile' = Verse native-profile seat. */
  source: 'pool' | 'profile';
}

export interface SessionAuditRoots {
  /** Home root; default homedir(). */
  home: string;
  /** $ASHLR_HOME when absolute, else <home>/.ashlr. */
  ashlrDir: string;
  /** $ASHLR_RUNS_DIR, else <home>/.ashlr-runs. */
  runsDir: string;
  /** $ASHLR_WT_DIR, else <home>/Projects/ashlrai/wt. */
  wtDir: string;
}

export function resolveSessionAuditRoots(
  overrides: Partial<SessionAuditRoots> = {},
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): SessionAuditRoots {
  const home = resolve(overrides.home ?? homeDir);
  const ashlr = env['ASHLR_HOME'];
  return {
    home,
    ashlrDir: resolve(overrides.ashlrDir
      ?? (typeof ashlr === 'string' && ashlr.trim() !== '' && isAbsolute(ashlr.trim()) ? ashlr.trim() : join(home, '.ashlr'))),
    runsDir: resolve(overrides.runsDir ?? env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs')),
    wtDir: resolve(overrides.wtDir ?? env['ASHLR_WT_DIR'] ?? join(home, 'Projects', 'ashlrai', 'wt')),
  };
}

/** One devin lane home plus the three pool CLI homes — always known. */
function poolLaneHomes(roots: SessionAuditRoots, env: NodeJS.ProcessEnv): SessionLaneHome[] {
  const read = (key: string, fallback: string): string => {
    const value = env[key];
    return typeof value === 'string' && value.trim() !== '' && isAbsolute(value.trim())
      ? resolve(value.trim()) : fallback;
  };
  const homes: SessionLaneHome[] = [
    { lane: 'devin', provider: 'devin', home: join(roots.ashlrDir, 'devin'), source: 'pool' },
    { lane: 'codex-cmp', provider: 'codex', home: read('CODEX_HOME', join(roots.home, '.codex')), source: 'pool' },
    { lane: 'claude', provider: 'claude', home: read('CLAUDE_CONFIG_DIR', join(roots.home, '.claude')), source: 'pool' },
  ];
  const secondary = read('CODEX_HOME_ALT', join(roots.home, '.codex-2'));
  if (secondary !== homes[1]!.home) {
    homes.push({ lane: 'codex-personal', provider: 'codex', home: secondary, source: 'pool' });
  }
  return homes;
}

/** profile.json carries the provider and the pinned native-state path. */
function parseProfileManifest(text: string | null): { provider: SessionProvider; nativeState: string } | null {
  if (text === null) return null;
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const provider = manifest['provider'];
  const nativeState = manifest['nativeStatePath'];
  if (typeof provider !== 'string' || !PROVIDERS.has(provider as never)) return null;
  if (typeof nativeState !== 'string' || !isAbsolute(nativeState)) return null;
  return { provider: provider as SessionProvider, nativeState };
}

// ---------------------------------------------------------------------------
// Session enumeration
// ---------------------------------------------------------------------------

interface RawSession {
  kind: SessionKind;
  /** Filename or dir name without the lane root — e.g. rollout-….jsonl, dv_….json, <slug>/<id>.jsonl. */
  rel: string;
  path: string;
  bytes: number | null;
  mtimeMs: number | null;
  /** claude projects/ slug (job-correlation hint, never emitted). */
  slug?: string;
  /** grok sessions/ percent-encoded cwd dir name. */
  cwdEnc?: string;
}

const DAY_DIR = /^\d{4}$/;
const MONTH_DIR = /^\d{2}$/;

/** 'missing' probe → skip (absent stores/dirs are normal); anything else → partial. */
const probeOk = <T>(p: Probe<T>): p is T => p !== 'missing' && p !== 'degraded';
const probeMissing = <T>(p: Probe<T>): boolean => p === 'missing';

/** Codex rollouts: sessions/YYYY/MM/DD/rollout-*.jsonl (+ archived_sessions). */
async function scanCodexHome(fs: SessionAuditFs, home: string, cap: number): Promise<{ sessions: RawSession[]; complete: boolean }> {
  const sessions: RawSession[] = [];
  let complete = true;
  for (const store of ['sessions', 'archived_sessions']) {
    const root = join(home, store);
    const rootStat = await fs.stat(root);
    if (probeMissing(rootStat)) continue;
    if (!probeOk(rootStat) || !rootStat.isDir) { if (!probeMissing(rootStat)) complete = false; continue; }
    const years = await fs.entries(root);
    if (!probeOk(years)) { if (!probeMissing(years)) complete = false; continue; }
    for (const year of years) {
      if (!year.isDir || !DAY_DIR.test(year.name)) continue;
      const months = await fs.entries(join(root, year.name));
      if (!probeOk(months)) { if (!probeMissing(months)) complete = false; continue; }
      for (const month of months) {
        if (!month.isDir || !MONTH_DIR.test(month.name)) continue;
        const days = await fs.entries(join(root, year.name, month.name));
        if (!probeOk(days)) { if (!probeMissing(days)) complete = false; continue; }
        for (const day of days) {
          if (!day.isDir || !MONTH_DIR.test(day.name)) continue;
          const files = await fs.entries(join(root, year.name, month.name, day.name));
          if (!probeOk(files)) { if (!probeMissing(files)) complete = false; continue; }
          for (const f of files) {
            if (!f.isFile || !ROLLOUT.test(f.name)) continue;
            if (sessions.length >= cap) { complete = false; break; }
            const path = join(root, year.name, month.name, day.name, f.name);
            const st = await fs.stat(path);
            sessions.push({
              kind: 'rollout', rel: `${store}/${year.name}/${month.name}/${day.name}/${f.name}`,
              path, bytes: probeOk(st) && st.isFile ? st.size : null,
              mtimeMs: probeOk(st) && st.isFile ? st.mtimeMs : null,
            });
          }
        }
      }
    }
  }
  return { sessions, complete };
}

/** Claude transcripts: projects/<cwd-slug>/<session>.jsonl (slug dirs only). */
async function scanClaudeHome(fs: SessionAuditFs, home: string, cap: number): Promise<{ sessions: RawSession[]; complete: boolean }> {
  const sessions: RawSession[] = [];
  let complete = true;
  const root = join(home, 'projects');
  const rootStat = await fs.stat(root);
  if (probeMissing(rootStat)) return { sessions, complete };
  if (!probeOk(rootStat) || !rootStat.isDir) return { sessions, complete: false };
  const slugs = await fs.entries(root);
  if (!probeOk(slugs)) return { sessions, complete: false };
  for (const slug of slugs) {
    if (!slug.isDir || slug.name.startsWith('.')) continue;
    const files = await fs.entries(join(root, slug.name));
    if (!probeOk(files)) { if (!probeMissing(files)) complete = false; continue; }
    for (const f of files) {
      if (!f.isFile || !TRANSCRIPT.test(f.name) || f.name.startsWith('.')) continue;
      if (sessions.length >= cap) { complete = false; break; }
      const path = join(root, slug.name, f.name);
      const st = await fs.stat(path);
      sessions.push({
        kind: 'transcript', rel: `projects/${slug.name}/${f.name}`,
        path, bytes: probeOk(st) && st.isFile ? st.size : null,
        mtimeMs: probeOk(st) && st.isFile ? st.mtimeMs : null,
        slug: slug.name,
      });
    }
  }
  return { sessions, complete };
}

/** Grok sessions: sessions/<percent-encoded-cwd>/<session-id>/ directories. */
async function scanGrokHome(fs: SessionAuditFs, home: string, cap: number, wantSize: boolean): Promise<{ sessions: RawSession[]; complete: boolean }> {
  const sessions: RawSession[] = [];
  let complete = true;
  const root = join(home, 'sessions');
  const rootStat = await fs.stat(root);
  if (probeMissing(rootStat)) return { sessions, complete };
  if (!probeOk(rootStat) || !rootStat.isDir) return { sessions, complete: false };
  const cwds = await fs.entries(root);
  if (!probeOk(cwds)) return { sessions, complete: false };
  for (const cwd of cwds) {
    if (!cwd.isDir) continue;
    const subs = await fs.entries(join(root, cwd.name));
    if (!probeOk(subs)) { if (!probeMissing(subs)) complete = false; continue; }
    for (const sub of subs) {
      if (!sub.isDir || sub.name.startsWith('.')) continue;
      if (sessions.length >= cap) { complete = false; break; }
      const path = join(root, cwd.name, sub.name);
      const st = await fs.stat(path);
      let bytes: number | null = null;
      if (wantSize) {
        const sized = await walkDirBytes(fs, path, GROK_DIR_WALK_LIMIT);
        bytes = sized.bytes;
        if (!sized.complete) complete = false;
      }
      sessions.push({
        kind: 'session-dir', rel: `sessions/${cwd.name}/${sub.name}`,
        path, bytes, mtimeMs: probeOk(st) && st.isDir ? st.mtimeMs : null, cwdEnc: cwd.name,
      });
    }
  }
  return { sessions, complete };
}

/** Bounded recursive byte sum for one session dir; symlink-safe via stat(). */
async function walkDirBytes(fs: SessionAuditFs, dir: string, limit: number): Promise<{ bytes: number; complete: boolean }> {
  let bytes = 0;
  let touched = 0;
  let complete = true;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    const kids = await fs.entries(current);
    if (!probeOk(kids)) { complete = false; continue; }
    for (const kid of kids) {
      if (++touched > limit) return { bytes, complete: false };
      const path = join(current, kid.name);
      if (kid.isDir) { stack.push(path); continue; }
      if (!kid.isFile) continue;
      const st = await fs.stat(path);
      if (probeOk(st) && st.isFile) bytes += st.size;
    }
  }
  return { bytes, complete };
}

/** Devin lane: tasks/<id>.json — each record is one remote session. */
async function scanDevinHome(fs: SessionAuditFs, home: string, cap: number): Promise<{ sessions: RawSession[]; complete: boolean }> {
  const sessions: RawSession[] = [];
  const root = join(home, 'tasks');
  const rootStat = await fs.stat(root);
  if (probeMissing(rootStat)) return { sessions, complete: true };
  if (!probeOk(rootStat) || !rootStat.isDir) return { sessions, complete: false };
  const files = await fs.entries(root);
  if (!probeOk(files)) return { sessions, complete: false };
  let complete = true;
  for (const f of files) {
    if (!f.isFile || !/^dv_[\w.-]+\.json$/.test(f.name)) continue;
    if (sessions.length >= cap) { complete = false; break; }
    const path = join(root, f.name);
    const st = await fs.stat(path);
    sessions.push({
      kind: 'task', rel: `tasks/${f.name}`,
      path, bytes: probeOk(st) && st.isFile ? st.size : null,
      mtimeMs: probeOk(st) && st.isFile ? st.mtimeMs : null,
    });
  }
  return { sessions, complete };
}

// ---------------------------------------------------------------------------
// Evidence: session -> job -> published result
// ---------------------------------------------------------------------------

/** Claude's projects/ slug: every non-alphanumeric becomes `-`. */
export function claudeSlug(pathname: string): string {
  return pathname.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Slug -> job map over every ledger id under both job-worktree roots.
 * Encode-forward (never decode-guess): two ids mapping to the same slug make
 * the slug ambiguous, and an ambiguous slug matches nothing.
 */
export function buildSlugJobMap(jobIds: Iterable<string>, wtRoots: readonly string[]): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const id of jobIds) {
    for (const root of wtRoots) {
      const slug = claudeSlug(join(root, id));
      if (seen.has(slug)) seen.set(slug, null);
      else seen.set(slug, id);
    }
  }
  const map = new Map<string, string>();
  for (const [slug, id] of seen) if (id !== null) map.set(slug, id);
  return map;
}

/** cwd -> job id when the path sits directly under a known job-worktree root. */
export function jobForCwd(cwd: string | null, wtRoots: readonly string[]): string | null {
  if (cwd === null || !isAbsolute(cwd)) return null;
  const resolved = resolve(cwd);
  const parent = dirname(resolved);
  if (!wtRoots.some(root => resolve(root) === parent)) return null;
  const id = basename(resolved);
  return SESSION_JOB_ID.test(id) ? id : null;
}

/**
 * The ledger verdicts that mean a session's result already lives elsewhere:
 * MERGED outcome, a publish row classed pr/empty, or a finished-empty run —
 * the same classes wt-audit's reap plan relies on. Relaunch-safe because
 * parseAuditLedger resets evidence at each launch.
 */
export function publishedEvidence(record: WtJobLedger | undefined): Exclude<SessionEvidence, 'task-pr' | 'task-report'> | null {
  if (record === undefined) return null;
  if (record.outcomeState === 'merged') return 'merged';
  if (record.publishClass === 'pr') return 'published-pr';
  if (record.publishClass === 'empty') return 'published-empty';
  if (record.finishSeen && record.finishEmpty) return 'finished-empty';
  return null;
}

/** session_meta carries cwd; scan only the head records, never whole rollouts. */
export function codexSessionCwd(headText: string | null): string | null {
  if (headText === null) return null;
  for (const line of headText.split(/\r?\n/).slice(0, 16)) {
    if (!line.includes('session_meta')) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row?.type !== 'session_meta') continue;
    const payload = row['payload'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const cwd = (payload as Record<string, unknown>)['cwd'];
    if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd;
  }
  return null;
}

interface DevinTaskEvidence {
  state: string | null;
  hasPr: boolean;
  hasReport: boolean;
  updatedMs: number | null;
}

const REPORT_STATUSES = new Set(['done', 'partial', 'blocked', 'no-change']);

/** Devin task record -> terminal + published-result facts. Pure. */
export function parseDevinTaskEvidence(text: string | null): DevinTaskEvidence | null {
  if (text === null) return null;
  let row: Record<string, unknown>;
  try { row = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const state = typeof row['state'] === 'string' ? row['state'] : null;
  const pr = row['pr'];
  const report = row['report'];
  const updated = typeof row['updatedAt'] === 'string' ? Date.parse(row['updatedAt']) : NaN;
  const hasPr = pr !== null && typeof pr === 'object' && !Array.isArray(pr)
    && (typeof (pr as Record<string, unknown>)['url'] === 'string' && (pr as Record<string, unknown>)['url'] !== ''
      || typeof (pr as Record<string, unknown>)['number'] === 'number');
  const hasReport = report !== null && typeof report === 'object' && !Array.isArray(report)
    && REPORT_STATUSES.has(String((report as Record<string, unknown>)['status']));
  return {
    state,
    hasPr,
    hasReport,
    updatedMs: Number.isFinite(updated) ? updated : null,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface SessionAuditEntry {
  lane: string;
  provider: SessionProvider;
  kind: SessionKind;
  /** Session identity inside its store (rollout file, transcript id, task id, dir id). */
  rel: string;
  path: string;
  bytes: number | null;
  ageDays: number | null;
  /** Fleet job the session provably served, when resolvable. */
  job: string | null;
  /** devin task state; null for CLI lanes / unparsed records. */
  state: string | null;
  /** Published-result evidence, or null. */
  published: SessionEvidence | null;
  pruneable: boolean;
  /** Why the session is not in the prune plan (empty when it is). */
  blockers: string[];
}

export interface SessionAuditLaneView {
  lane: string;
  provider: SessionProvider;
  home: string;
  source: 'pool' | 'profile';
  /** 'missing' when the home does not exist; 'degraded' when it could not be listed. */
  state: 'healthy' | 'missing' | 'degraded';
  sessions: number;
  bytes: number;
  complete: boolean;
  oldestAgeDays: number | null;
  newestAgeDays: number | null;
  published: { sessions: number; bytes: number };
  pruneable: { sessions: number; bytes: number };
  stores: Array<{ store: string; sessions: number; bytes: number }>;
}

export interface SessionAuditPruneEntry {
  lane: string;
  provider: SessionProvider;
  kind: SessionKind;
  rel: string;
  path: string;
  action: 'delete-file' | 'delete-dir';
  bytes: number | null;
  ageDays: number | null;
  job: string | null;
  state: string | null;
  evidence: SessionEvidence;
}

export interface SessionAuditReport {
  schema: typeof SESSION_AUDIT_SCHEMA;
  generatedAt: string;
  readOnly: true;
  olderThanDays: number;
  wtDir: string;
  runsDir: string;
  sources: {
    profiles: Source;
    jobs: Source;
    sized: boolean;
    /** codex rollouts past the head-read cap could not be job-correlated. */
    headReadsCapped: boolean;
  };
  lanes: SessionAuditLaneView[];
  totals: {
    lanes: number;
    sessions: number;
    bytes: number;
    complete: boolean;
    oldestAgeDays: number | null;
    published: { sessions: number; bytes: number };
    pruneable: { sessions: number; bytes: number };
  };
  prunePlan?: {
    olderThanDays: number;
    count: number;
    bytes: number;
    complete: boolean;
    entries: SessionAuditPruneEntry[];
  };
}

export interface SessionAuditDeps {
  now?: number;
  roots?: Partial<SessionAuditRoots>;
  env?: NodeJS.ProcessEnv;
  fs?: SessionAuditFs;
  /** Injected reader for metrics/jobs.jsonl; default reads a bounded tail. */
  readJobs?: (path: string) => Promise<{ state: Source; text: string }>;
  /** false skips grok session-dir size walks (file sizes still come free). */
  wantSize?: boolean;
  /** Plan age gate in whole days (>= 0). */
  olderThanDays?: number;
  wantPlan?: boolean;
}

export const SESSION_AUDIT_DEFAULT_OLDER_THAN_DAYS = 30;

interface ScanOutcome {
  sessions: RawSession[];
  complete: boolean;
  /** 'missing' when the home is absent, 'degraded' when it refused a probe. */
  present: 'healthy' | 'missing' | 'degraded';
}

/** Enumerate one lane home; `state` mirrors the home probe. */
async function scanLane(
  fs: SessionAuditFs, lane: SessionLaneHome, cap: number, wantSize: boolean,
): Promise<ScanOutcome> {
  const homeStat = await fs.stat(lane.home);
  if (probeMissing(homeStat)) return { sessions: [], complete: true, present: 'missing' };
  if (!probeOk(homeStat)) return { sessions: [], complete: false, present: 'degraded' };
  if (!homeStat.isDir) return { sessions: [], complete: true, present: 'missing' };
  switch (lane.provider) {
    case 'codex': {
      const r = await scanCodexHome(fs, lane.home, cap);
      return { ...r, present: 'healthy' };
    }
    case 'claude': {
      const r = await scanClaudeHome(fs, lane.home, cap);
      return { ...r, present: 'healthy' };
    }
    case 'grok': {
      const r = await scanGrokHome(fs, lane.home, cap, wantSize);
      return { ...r, present: 'healthy' };
    }
    case 'devin': {
      const r = await scanDevinHome(fs, lane.home, cap);
      return { ...r, present: 'healthy' };
    }
  }
}

export async function readSessionAudit(deps: SessionAuditDeps = {}): Promise<SessionAuditReport> {
  const now = deps.now ?? Date.now();
  const env = deps.env ?? process.env;
  const roots = resolveSessionAuditRoots(deps.roots, env);
  const fs = deps.fs ?? defaultFs;
  const wantSize = deps.wantSize !== false;
  const olderThanDays = deps.olderThanDays !== undefined && Number.isFinite(deps.olderThanDays) && deps.olderThanDays >= 0
    ? deps.olderThanDays : SESSION_AUDIT_DEFAULT_OLDER_THAN_DAYS;
  const cutoffMs = now - olderThanDays * DAY_MS;

  const profilesDir = join(roots.ashlrDir, 'native-profiles');
  const [profileEntries, jobs] = await Promise.all([
    fs.entries(profilesDir),
    (async () => {
      try {
        return await (deps.readJobs ?? ((path: string) => readSource(path, SESSION_AUDIT_MAX_JOBS_BYTES, true)))(
          join(roots.runsDir, 'metrics', 'jobs.jsonl'));
      } catch { return { state: 'degraded' as Source, text: '' }; }
    })(),
  ]);

  const laneHomes = poolLaneHomes(roots, env);
  const profilesSource: Source = profileEntries === 'missing' ? 'missing'
    : !probeOk(profileEntries) ? 'degraded' : 'healthy';
  if (probeOk(profileEntries)) {
    for (const entry of profileEntries) {
      if (!entry.isDir || entry.name.startsWith('.') || RECOVERY_PROFILE.test(entry.name)) continue;
      const dir = join(profilesDir, entry.name);
      const manifest = parseProfileManifest(await fs.head(join(dir, 'profile.json'), SMALL_FILE_BYTES));
      if (manifest === null) continue;
      // The manifest must name its own tree — a copied profile.json that
      // points elsewhere is refused, same rule as the repin verifier.
      if (resolve(manifest.nativeState) !== resolve(join(dir, 'native-state'))) continue;
      laneHomes.push({
        lane: entry.name, provider: manifest.provider, home: manifest.nativeState, source: 'profile',
      });
    }
  }
  // One home may serve two lanes (CLAUDE_CONFIG_DIR == a profile's native-state): dedupe.
  const seenHomes = new Set<string>();
  const lanes = laneHomes.filter(lane => {
    const key = resolve(lane.home);
    if (seenHomes.has(key)) return false;
    seenHomes.add(key);
    return true;
  });

  const ledger = jobs.state === 'healthy' ? parseAuditLedger(jobs.text) : null;
  const wtRoots = [roots.wtDir, join(roots.runsDir, 'wt')];
  const slugJobs = buildSlugJobMap(ledger?.keys() ?? [], wtRoots);
  let headReads = 0;
  let headReadsCapped = false;

  /** Job correlation per provider. Rollout heads are only read for files old
   * enough to plausibly prune — the audit itself never opens a session. */
  const resolveJob = async (lane: SessionLaneHome, raw: RawSession): Promise<string | null> => {
    switch (lane.provider) {
      case 'claude':
        return typeof raw.slug === 'string' ? (slugJobs.get(raw.slug) ?? null) : null;
      case 'grok': {
        if (typeof raw.cwdEnc !== 'string') return null;
        let cwd: string;
        try { cwd = decodeURIComponent(raw.cwdEnc); } catch { return null; }
        return jobForCwd(cwd, wtRoots);
      }
      case 'codex': {
        if (ledger === null) return null;
        const old = raw.mtimeMs !== null && raw.mtimeMs <= cutoffMs;
        if (!old) return null; // only the plan needs job linkage
        if (headReads >= SESSION_AUDIT_MAX_HEAD_READS) { headReadsCapped = true; return null; }
        headReads++;
        const cwd = codexSessionCwd(await fs.head(raw.path, SESSION_META_HEAD_BYTES));
        return jobForCwd(cwd, wtRoots);
      }
      case 'devin': return null;
    }
  };

  const laneViews: SessionAuditLaneView[] = [];
  const entries: SessionAuditEntry[] = [];

  for (const lane of lanes) {
    const scanned = await scanLane(fs, lane, SESSION_AUDIT_MAX_SESSIONS_PER_LANE, wantSize);
    let laneComplete = scanned.complete;
    const laneEntries: SessionAuditEntry[] = [];

    for (const raw of scanned.sessions) {
      let mtimeMs = raw.mtimeMs;
      let state: string | null = null;
      let job: string | null = null;
      let published: SessionEvidence | null = null;
      const blockers: string[] = [];

      if (lane.provider === 'devin') {
        const evidence = parseDevinTaskEvidence(await fs.head(raw.path, SMALL_FILE_BYTES));
        state = evidence?.state ?? null;
        if (evidence?.updatedMs !== null && evidence?.updatedMs !== undefined) {
          mtimeMs = mtimeMs === null ? evidence.updatedMs : Math.max(mtimeMs, evidence.updatedMs);
        }
        if (evidence === null) blockers.push('unparsed-record');
        else if (!DEVIN_TERMINAL.has(state ?? '')) blockers.push('not-terminal');
        else if (evidence.hasPr) published = 'task-pr';
        else if (evidence.hasReport) published = 'task-report';
        else blockers.push('no-result-recorded');
      } else {
        job = await resolveJob(lane, raw);
        if (ledger === null) blockers.push('ledger-unreadable');
        else if (job === null) blockers.push('no-job-link');
        else {
          published = publishedEvidence(ledger.get(job));
          if (published === null) blockers.push('job-not-published');
        }
      }

      const ageDays = mtimeMs === null ? null : Math.max(0, (now - mtimeMs) / DAY_MS);
      if (mtimeMs === null) blockers.push('age-unknown');
      else if (mtimeMs > cutoffMs) blockers.push('fresh');
      const pruneable = published !== null && mtimeMs !== null && mtimeMs <= cutoffMs;
      laneEntries.push({
        lane: lane.lane, provider: lane.provider, kind: raw.kind, rel: raw.rel,
        path: raw.path, bytes: raw.bytes, ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10,
        job, state, published, pruneable, blockers,
      });
    }

    // Rollup
    let bytes = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    let publishedCount = 0;
    let publishedBytes = 0;
    let pruneableCount = 0;
    let pruneableBytes = 0;
    const stores = new Map<string, { sessions: number; bytes: number }>();
    for (const e of laneEntries) {
      const store = e.rel.split('/')[0]!;
      const bucket = stores.get(store) ?? { sessions: 0, bytes: 0 };
      bucket.sessions++;
      bucket.bytes += e.bytes ?? 0;
      stores.set(store, bucket);
      if (e.bytes !== null) bytes += e.bytes;
      else if (wantSize) laneComplete = false;
      if (e.ageDays !== null) {
        if (oldest === null || e.ageDays > oldest) oldest = e.ageDays;
        if (newest === null || e.ageDays < newest) newest = e.ageDays;
      }
      if (e.published !== null) { publishedCount++; publishedBytes += e.bytes ?? 0; }
      if (e.pruneable) { pruneableCount++; pruneableBytes += e.bytes ?? 0; }
    }

    laneViews.push({
      lane: lane.lane, provider: lane.provider, home: lane.home, source: lane.source,
      // 'degraded' means enumeration failed somewhere — partial *sizes* alone
      // only lower `complete`, never the listing state.
      state: scanned.present !== 'healthy' ? scanned.present : !scanned.complete ? 'degraded' : 'healthy',
      sessions: laneEntries.length, bytes,
      complete: laneComplete,
      oldestAgeDays: oldest, newestAgeDays: newest,
      published: { sessions: publishedCount, bytes: publishedBytes },
      pruneable: { sessions: pruneableCount, bytes: pruneableBytes },
      stores: [...stores.entries()].map(([store, v]) => ({ store, ...v })),
    });
    entries.push(...laneEntries);
  }

  laneViews.sort((a, b) => b.bytes - a.bytes || a.lane.localeCompare(b.lane));

  const totals = laneViews.reduce((acc, lane) => ({
    lanes: acc.lanes + 1,
    sessions: acc.sessions + lane.sessions,
    bytes: acc.bytes + lane.bytes,
    complete: acc.complete && lane.complete,
    oldestAgeDays: lane.oldestAgeDays !== null && (acc.oldestAgeDays === null || lane.oldestAgeDays > acc.oldestAgeDays)
      ? lane.oldestAgeDays : acc.oldestAgeDays,
    published: { sessions: acc.published.sessions + lane.published.sessions, bytes: acc.published.bytes + lane.published.bytes },
    pruneable: { sessions: acc.pruneable.sessions + lane.pruneable.sessions, bytes: acc.pruneable.bytes + lane.pruneable.bytes },
  }), {
    lanes: 0, sessions: 0, bytes: 0, complete: true, oldestAgeDays: null as number | null,
    published: { sessions: 0, bytes: 0 }, pruneable: { sessions: 0, bytes: 0 },
  });

  const report: SessionAuditReport = {
    schema: SESSION_AUDIT_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    olderThanDays,
    wtDir: roots.wtDir,
    runsDir: roots.runsDir,
    sources: { profiles: profilesSource, jobs: jobs.state, sized: wantSize, headReadsCapped },
    lanes: laneViews,
    totals,
  };

  if (deps.wantPlan) {
    const planEntries: SessionAuditPruneEntry[] = entries
      .filter(e => e.pruneable)
      .map(e => ({
        lane: e.lane, provider: e.provider, kind: e.kind, rel: e.rel, path: e.path,
        action: (e.kind === 'session-dir' ? 'delete-dir' : 'delete-file') as SessionAuditPruneEntry['action'],
        bytes: e.bytes, ageDays: e.ageDays, job: e.job, state: e.state,
        evidence: e.published!,
      }))
      .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.path.localeCompare(b.path));
    report.prunePlan = {
      olderThanDays,
      count: planEntries.length,
      bytes: planEntries.reduce((sum, e) => sum + (e.bytes ?? 0), 0),
      complete: planEntries.every(e => e.bytes !== null),
      entries: planEntries,
    };
  }
  return report;
}

// ---------------------------------------------------------------------------
// Human formatting — pure.
// ---------------------------------------------------------------------------

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function formatGb(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  const gb = round1(bytes / 1e9);
  return `${gb === 0 && bytes > 0 ? '<0.1' : gb} GB`;
}

export function formatSessionAudit(report: SessionAuditReport): string[] {
  const lines = ['session audit — reads only, deletes nothing'];
  const t = report.totals;
  lines.push(`lane homes: ${t.lanes}, sessions: ${t.sessions} (${formatGb(t.bytes)}${t.complete ? '' : ', partial sizes'})`);
  if (t.oldestAgeDays !== null) lines.push(`oldest session: ${round1(t.oldestAgeDays)}d`);
  for (const lane of report.lanes) {
    if (lane.state === 'missing') continue;
    const ages = lane.oldestAgeDays === null ? 'ages unknown'
      : `newest ${round1(lane.newestAgeDays ?? 0)}d / oldest ${round1(lane.oldestAgeDays)}d`;
    const pub = lane.published.sessions > 0 ? `, ${lane.published.sessions} published` : '';
    const prunable = lane.pruneable.sessions > 0 ? `, ${lane.pruneable.sessions} pruneable` : '';
    const store = lane.stores.length ? ` [${lane.stores.map(s => s.store).join(', ')}]` : '';
    lines.push(`  ${lane.lane} (${lane.provider}): ${lane.sessions} sessions, ${formatGb(lane.bytes)}, ${ages}${pub}${prunable}${store}${lane.complete ? '' : ' (partial)'}`);
  }
  if (t.pruneable.sessions === 0) {
    lines.push(`pruneable now: none at >=${round1(report.olderThanDays)}d with published results`);
  } else {
    lines.push(`pruneable now: ${t.pruneable.sessions} sessions (${formatGb(t.pruneable.bytes)}) — add --prune-plan for the list`);
  }
  const degraded: string[] = [];
  if (report.sources.profiles === 'degraded') degraded.push('profiles=degraded');
  if (report.sources.jobs !== 'healthy') degraded.push(`jobs=${report.sources.jobs}`);
  for (const lane of report.lanes) if (lane.state === 'degraded') degraded.push(`lane:${lane.lane}=degraded`);
  if (degraded.length) {
    lines.push(`degraded sources: ${degraded.join(', ')} — unproven sessions are never listed as pruneable`);
  }
  return lines;
}

export function formatSessionPrunePlan(report: SessionAuditReport): string[] {
  const plan = report.prunePlan;
  const lines = [`session prune plan — >=${round1(report.olderThanDays)}d with published results; deletes nothing`];
  if (!plan || plan.count === 0) {
    lines.push('no session is provably safe to prune right now');
    if (report.sources.jobs !== 'healthy') lines.push('the jobs ledger could not be read — no CLI session can be proven published');
    return lines;
  }
  for (const entry of plan.entries) {
    const size = entry.bytes === null ? 'size unknown' : formatGb(entry.bytes);
    const age = entry.ageDays === null ? 'age unknown' : `${entry.ageDays}d`;
    const job = entry.job === null ? '' : `, job ${entry.job}`;
    const state = entry.state === null ? '' : `, state ${entry.state}`;
    lines.push(`${entry.lane} ${entry.rel}: ${entry.action}, ${size}, ${age}, evidence ${entry.evidence}${job}${state}`);
    lines.push(`    ${entry.path}`);
  }
  lines.push(`total: ${plan.count} session(s), ${formatGb(plan.bytes)}${plan.complete ? '' : ' (partial sizes)'}`);
  lines.push('the plan never names auth, config, sqlite state or live sessions; removal stays the operator\u2019s call.');
  return lines;
}
