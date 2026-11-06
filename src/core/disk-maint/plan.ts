/**
 * disk-maint plan - one bounded, read-only scan that attributes every
 * reclaimable byte to a class.
 *
 * Classes, all rebuildable-only by construction:
 *
 *   run-logs        ~/.ashlr-runs rolling logs and per-job sidecar logs for
 *                   jobs with a terminal ledger outcome, plus queue/*.log.
 *   agent-sessions  ~/.ashlr/native-profiles/<lane>/native-state session
 *                   stores (Codex rollouts, Claude projects, Grok sessions).
 *   ashlr-logs      ~/.ashlr log roots the steward quota does not cover:
 *                   agent-logs, crashes, run-streams, session-history and
 *                   the root-level *.log* files.
 *   recovery-dirs   stale `*-recovery-*` native-profile copies, backup-drill
 *                   and cortex-bridge dirs, and root-level *.bak* files.
 *   staging         update staging children, cloud checkouts and leftover
 *                   temp worktrees under ~/.ashlr.
 *   caches          summary-cache entries and genome-index-*.cache files.
 *   worktrees-runs  ~/.ashlr-runs/wt job worktrees, wt-reap semantics.
 *   worktrees-jobs  ~/Projects/ashlrai/wt job worktrees, merged only.
 *   bridge-targets  ~/.ashlr-runs/repos/<key>/target build output gone quiet.
 *   venvs           side-project .venv trees - gated behind --allow venvs.
 *   hub-claude      ashlr-hub/.claude session cache - gated --allow hub-claude.
 *
 * Every candidate passes the protect-list before it is listed, and apply
 * re-checks it before a byte moves. Nothing under ~/.codex*, model caches,
 * Docker, client trees or ~/Documents is ever a candidate.
 */
import { lstatSync, readdirSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readSource, type Source } from '../fleet/runs-parked-queue.js';
import { isKeptWorktree, readKeptWorktrees, measureWorktreeBytes, type KeptWorktrees } from '../worktree-retention.js';
import { classifyWorktree, parseJobLedger } from '../../cli/disk.js';
import { protectedReason, protectedRoots, resolveMaintRoots, type MaintRoots } from './protect.js';

/** Matches dispatchd's DISK_REUSE_ONLY_GB default. Reported, never changed. */
export const DISKGUARD_REUSE_ONLY_GB = 100;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type MaintClassId =
  | 'run-logs' | 'agent-sessions' | 'ashlr-logs' | 'recovery-dirs'
  | 'staging' | 'caches' | 'worktrees-runs' | 'worktrees-jobs'
  | 'bridge-targets' | 'venvs' | 'hub-claude';

export const GATED_CLASSES = new Set<MaintClassId>(['venvs', 'hub-claude']);
export const ALL_CLASSES: readonly MaintClassId[] = [
  'run-logs', 'agent-sessions', 'ashlr-logs', 'recovery-dirs', 'staging', 'caches',
  'worktrees-runs', 'worktrees-jobs', 'bridge-targets', 'venvs', 'hub-claude',
];

export type MaintAction = 'delete-file' | 'compress-file' | 'rotate-compress' | 'delete-dir' | 'worktree-remove';

export interface MaintCandidate {
  path: string;
  action: MaintAction;
  bytes: number;
  /** Age in whole days from the entry's freshness signal, null when unknown. */
  ageDays: number | null;
  /** Freshness signal the age came from (mtime for files, finish ts for worktrees). */
  mtimeMs: number | null;
  reason: string;
}

export interface MaintClassPlan {
  id: MaintClassId;
  /** true means the class only applies when enabled by --allow <id>. */
  gated: boolean;
  enabled: boolean;
  complete: boolean;
  note?: string;
  candidates: MaintCandidate[];
  bytes: number;
}

export interface MaintPolicy {
  compressAfterDays: number;
  deleteAfterDays: number;
  sessionCompressDays: number;
  sessionDeleteDays: number;
  orphanCompressDays: number;
  orphanDeleteDays: number;
  stagingDays: number;
  recoveryDays: number;
  cacheDays: number;
  worktreeMinAgeHours: number;
  venvDays: number;
  hubClaudeDays: number;
  bridgeTargetDays: number;
  rotateBytes: number;
}

export const DEFAULT_POLICY: MaintPolicy = {
  compressAfterDays: 7,
  deleteAfterDays: 45,
  sessionCompressDays: 14,
  sessionDeleteDays: 60,
  orphanCompressDays: 30,
  orphanDeleteDays: 90,
  stagingDays: 7,
  recoveryDays: 30,
  cacheDays: 14,
  worktreeMinAgeHours: 1,
  venvDays: 14,
  hubClaudeDays: 30,
  bridgeTargetDays: 30,
  rotateBytes: 50 * 1e6,
};

export interface DiskMaintPlan {
  schema: 'disk-maint.v1';
  generatedAt: string;
  apply: false;
  roots: MaintRoots;
  freeGb: number | null;
  /** DISKGUARD context line - the sweep exists to stay above it, unchanged. */
  diskguardReuseOnlyGb: number;
  jobsSource: Source;
  classes: MaintClassPlan[];
  totals: { candidates: number; bytes: number; complete: boolean };
  /** Paths the protect-list refused during the scan - evidence, not errors. */
  refused: { path: string; reason: string }[];
}

export interface MaintDeps {
  now?: number;
  roots?: MaintRoots;
  only?: ReadonlySet<MaintClassId>;
  allow?: ReadonlySet<string>;
  policy?: Partial<MaintPolicy>;
  readJobs?: (path: string) => Promise<{ state: Source; text: string }>;
  readPins?: () => KeptWorktrees | Promise<KeptWorktrees>;
  kept?: (dir: string) => boolean;
  freeBytes?: (path: string) => number | null | Promise<number | null>;
  measure?: (dir: string) => { bytes: number; complete: boolean };
  deadlineMs?: number;
}

const MAX_JOBS_BYTES = 8 * 1024 * 1024;
const WALK_MAX_ENTRIES = 100_000;

interface FileRow { path: string; bytes: number; mtimeMs: number }

interface ScanCtx {
  roots: MaintRoots;
  now: number;
  policy: MaintPolicy;
  protectedRoots: readonly string[];
  refused: { path: string; reason: string }[];
  ledger: Map<string, { state: string | null; finishMs: number | null; finishEmpty: boolean }> | null;
  kept: (dir: string) => boolean;
  measure: (dir: string) => { bytes: number; complete: boolean };
  deadlineMs: number;
}

const dayAge = (now: number, mtimeMs: number): number => Math.max(0, Math.floor((now - mtimeMs) / DAY_MS));

/** Refuse helper that records evidence for the plan's refused list. */
function refused(ctx: ScanCtx, path: string): string | null {
  const reason = protectedReason(path, ctx.roots, ctx.protectedRoots);
  if (reason) ctx.refused.push({ path, reason });
  return reason;
}

function lstat(path: string) {
  try { return lstatSync(path); } catch { return null; }
}

/**
 * Bounded file walk: no symlink traversal, no protected subtrees, shared
 * deadline across every root. A bounded-out walk reports complete=false -
 * partial byte counts are floors, never exact totals.
 */
function walkFiles(
  root: string,
  ctx: ScanCtx,
  opts: { maxDepth?: number } = {},
): { files: FileRow[]; complete: boolean } {
  const files: FileRow[] = [];
  const maxDepth = opts.maxDepth ?? 12;
  let complete = true;
  let visited = 0;
  const top = lstat(root);
  if (!top || !top.isDirectory() || top.isSymbolicLink() || refused(ctx, root)) return { files, complete: top !== null };
  const pending: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (pending.length) {
    const { dir, depth } = pending.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { complete = false; continue; }
    for (const name of names) {
      if (Date.now() >= ctx.deadlineMs || ++visited > WALK_MAX_ENTRIES) return { files, complete: false };
      // *.keep names are keep-markers by convention: never eaten anywhere.
      if (/\.keep$/i.test(name)) continue;
      const path = join(dir, name);
      const st = lstat(path);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (protectedReason(path, ctx.roots, ctx.protectedRoots)) { ctx.refused.push({ path, reason: 'protected-subtree' }); continue; }
        if (depth < maxDepth) pending.push({ dir: path, depth: depth + 1 });
        continue;
      }
      if (!st.isFile() || st.nlink !== 1) continue;
      if (protectedReason(path, ctx.roots, ctx.protectedRoots)) { ctx.refused.push({ path, reason: 'protected-file' }); continue; }
      files.push({ path, bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return { files, complete };
}

/** Direct children of `root` as `kind` entries; protected names are refused and recorded. */
function children(root: string, ctx: ScanCtx, kind: 'dir' | 'file'): { name: string; mtimeMs: number; bytes: number }[] {
  if (refused(ctx, root)) return [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: { name: string; mtimeMs: number; bytes: number }[] = [];
  for (const e of entries) {
    if (e.isSymbolicLink() || /\.keep$/i.test(e.name)) continue;
    if (kind === 'dir' && !e.isDirectory()) continue;
    if (kind === 'file' && !e.isFile()) continue;
    const path = join(root, e.name);
    if (protectedReason(path, ctx.roots, ctx.protectedRoots)) { ctx.refused.push({ path, reason: 'protected-entry' }); continue; }
    const st = lstat(path);
    if (!st) continue;
    out.push({ name: e.name, mtimeMs: st.mtimeMs, bytes: st.size });
  }
  return out;
}

/** A file-sized dir candidate: measured bytes come from the bounded measure. */
function dirCandidate(ctx: ScanCtx, path: string, mtimeMs: number, reason: string): MaintCandidate | null {
  if (refused(ctx, path)) return null;
  const measured = ctx.measure(path);
  return { path, action: 'delete-dir', bytes: measured.bytes, ageDays: dayAge(ctx.now, mtimeMs), mtimeMs, reason };
}

/** compress/delete split by age for a leftover file; still refused when protected. */
function aged(ctx: ScanCtx, row: FileRow, compressDays: number, deleteDays: number, reason: string): MaintCandidate | null {
  if (refused(ctx, row.path)) return null;
  const age = dayAge(ctx.now, row.mtimeMs);
  if (age >= deleteDays) return { path: row.path, action: 'delete-file', bytes: row.bytes, ageDays: age, mtimeMs: row.mtimeMs, reason: `${reason}; older than ${deleteDays}d` };
  if (age >= compressDays) return { path: row.path, action: 'compress-file', bytes: row.bytes, ageDays: age, mtimeMs: row.mtimeMs, reason: `${reason}; older than ${compressDays}d` };
  return null;
}

const JOB_SIDECAR = /^([A-Za-z0-9][\w.-]*?)\.(log|launch|out|err|reap\.log)$/;
const ROTATED = /\.(gz|[0-9]+|rotate-\d+(\.gz)?)$/;
/** Only log-ish names are ever touched; queue *.tsv and .base/.publish live. */
const LOG_LIKE = /\.(log|launch|out|err|reap\.log)(\.[0-9]+|\.rotate-\d+(\.gz)?|\.gz)?$/i;

function scanRunLogs(ctx: ScanCtx): MaintCandidate[] {
  const out: MaintCandidate[] = [];
  const p = ctx.policy;
  for (const base of [ctx.roots.runsDir, join(ctx.roots.runsDir, 'queue')]) {
    for (const entry of children(base, ctx, 'file')) {
      if (!LOG_LIKE.test(entry.name)) continue;
      const path = join(base, entry.name);
      if (ROTATED.test(entry.name)) {
        const stale = dayAge(ctx.now, entry.mtimeMs) >= p.deleteAfterDays;
        if (stale && !refused(ctx, path)) out.push({ path, action: 'delete-file', bytes: entry.bytes, ageDays: dayAge(ctx.now, entry.mtimeMs), mtimeMs: entry.mtimeMs, reason: `rotated log older than ${p.deleteAfterDays}d` });
        continue;
      }
      const sidecar = JOB_SIDECAR.exec(entry.name);
      const record = sidecar ? ctx.ledger?.get(sidecar[1]!) : undefined;
      const terminal = record?.state != null && record.state !== 'open';
      if (sidecar && terminal) {
        const c = aged(ctx, { path, bytes: entry.bytes, mtimeMs: entry.mtimeMs }, p.compressAfterDays, p.deleteAfterDays, 'terminal job log');
        if (c) out.push(c);
        continue;
      }
      // Named rolling logs (disk.log, outcomes.log, dispatch-events.log,
      // restock.log) and sidecars with no finished ledger record: rotate by
      // size, compress when quiet, delete only when long dead.
      if (!sidecar || ctx.ledger === null || !terminal) {
        const row = { path, bytes: entry.bytes, mtimeMs: entry.mtimeMs };
        if (entry.bytes > p.rotateBytes) {
          if (!refused(ctx, path)) out.push({ path, action: 'rotate-compress', bytes: entry.bytes, ageDays: dayAge(ctx.now, entry.mtimeMs), mtimeMs: entry.mtimeMs, reason: `live log over ${Math.round(p.rotateBytes / 1e6)}MB` });
          continue;
        }
        const c = aged(ctx, row, p.orphanCompressDays, p.orphanDeleteDays, 'unclaimed log');
        if (c) out.push(c);
      }
    }
  }
  return out;
}

const SESSION_SUBDIRS = new Set([
  'sessions', 'archived_sessions', 'log', 'logs', 'projects', 'todos',
  'shell-snapshots', 'statsig', 'history', 'file-history', 'backups', 'tmp',
]);
const LEFTOVER = /\.(log|jsonl|out|err|tmp|temp|cache|bak|old|gz)$/i;

function scanAgentSessions(ctx: ScanCtx): MaintCandidate[] {
  const out: MaintCandidate[] = [];
  const p = ctx.policy;
  const profiles = join(ctx.roots.ashlrDir, 'native-profiles');
  for (const profile of children(profiles, ctx, 'dir')) {
    if (/(recovery|backup)-\w{4,}$/i.test(profile.name)) continue; // recovery-dirs owns these
    const state = join(profiles, profile.name, 'native-state');
    const subs = children(state, ctx, 'dir').filter(d => SESSION_SUBDIRS.has(d.name));
    for (const sub of subs) {
      const { files } = walkFiles(join(state, sub.name), ctx);
      for (const row of files) {
        const c = aged(ctx, row, p.sessionCompressDays, p.sessionDeleteDays, 'agent session leftover');
        if (c) out.push(c);
      }
    }
    for (const f of children(state, ctx, 'file').filter(f => LEFTOVER.test(f.name))) {
      const c = aged(ctx, { path: join(state, f.name), bytes: f.bytes, mtimeMs: f.mtimeMs }, p.sessionCompressDays, p.sessionDeleteDays, 'agent session leftover');
      if (c) out.push(c);
    }
  }
  return out;
}

const ASHLR_LOG_DIRS = ['agent-logs', 'crashes', 'run-streams', 'session-history', 'test-watch-sessions'];
const ROOT_LOG = /^[\w.-]+\.log(\.\d+)?$|^[\w.-]+launchd\.(out|err)\.log$/;

function scanAshlrLogs(ctx: ScanCtx): MaintCandidate[] {
  const out: MaintCandidate[] = [];
  const p = ctx.policy;
  for (const dir of ASHLR_LOG_DIRS) {
    const { files } = walkFiles(join(ctx.roots.ashlrDir, dir), ctx);
    for (const row of files) {
      const c = aged(ctx, row, p.compressAfterDays, p.deleteAfterDays, 'ashlr log');
      if (c) out.push(c);
    }
  }
  for (const f of children(ctx.roots.ashlrDir, ctx, 'file').filter(f => ROOT_LOG.test(f.name))) {
    const c = aged(ctx, { path: join(ctx.roots.ashlrDir, f.name), bytes: f.bytes, mtimeMs: f.mtimeMs }, p.compressAfterDays, p.deleteAfterDays, 'ashlr log');
    if (c) out.push(c);
  }
  return out;
}

const RECOVERY_DIR = /(recovery|backup-drill|bridge)-\w{4,}$/i;
const RECOVERY_FILE = /\.bak($|[.-])/i;

function scanRecovery(ctx: ScanCtx): MaintCandidate[] {
  const out: MaintCandidate[] = [];
  const p = ctx.policy;
  const profiles = join(ctx.roots.ashlrDir, 'native-profiles');
  for (const dir of children(profiles, ctx, 'dir')) {
    if (!/(recovery|backup)-\w{4,}$/i.test(dir.name)) continue;
    if (dayAge(ctx.now, dir.mtimeMs) < p.recoveryDays) continue;
    const c = dirCandidate(ctx, join(profiles, dir.name), dir.mtimeMs, `recovery copy older than ${p.recoveryDays}d`);
    if (c) out.push(c);
  }
  for (const dir of children(ctx.roots.ashlrDir, ctx, 'dir')) {
    if (!RECOVERY_DIR.test(dir.name) || dayAge(ctx.now, dir.mtimeMs) < p.recoveryDays) continue;
    const c = dirCandidate(ctx, join(ctx.roots.ashlrDir, dir.name), dir.mtimeMs, `recovery dir older than ${p.recoveryDays}d`);
    if (c) out.push(c);
  }
  for (const f of children(ctx.roots.ashlrDir, ctx, 'file').filter(f => RECOVERY_FILE.test(f.name))) {
    const c = aged(ctx, { path: join(ctx.roots.ashlrDir, f.name), bytes: f.bytes, mtimeMs: f.mtimeMs }, p.recoveryDays, p.recoveryDays, 'stale recovery file');
    if (c) out.push(c);
  }
  return out;
}

const TEMP_WORKTREE = /^(vwt|mwt|mergewt|wt)-[0-9a-f]+$/;
const STAGING_PARENTS = [
  join('updates', 'staged'), join('updates', 'consumer-staging'), join('updates', 'manual-staging'),
];

function scanStaging(ctx: ScanCtx): MaintCandidate[] {
  const out: MaintCandidate[] = [];
  const p = ctx.policy;
  const dirs = [...STAGING_PARENTS.map(s => join(ctx.roots.ashlrDir, s)), join(ctx.roots.ashlrDir, 'cloud', 'checkouts')];
  for (const parent of dirs) {
    for (const child of children(parent, ctx, 'dir')) {
      if (dayAge(ctx.now, child.mtimeMs) < p.stagingDays) continue;
      const c = dirCandidate(ctx, join(parent, child.name), child.mtimeMs, `staging leftover older than ${p.stagingDays}d`);
      if (c) out.push(c);
    }
    for (const child of children(parent, ctx, 'file')) {
      if (dayAge(ctx.now, child.mtimeMs) < p.stagingDays) continue;
      const path = join(parent, child.name);
      if (!refused(ctx, path)) out.push({ path, action: 'delete-file', bytes: child.bytes, ageDays: dayAge(ctx.now, child.mtimeMs), mtimeMs: child.mtimeMs, reason: `staging leftover older than ${p.stagingDays}d` });
    }
  }
  const tmp = join(ctx.roots.ashlrDir, 'tmp');
  for (const child of children(tmp, ctx, 'dir')) {
    if (!TEMP_WORKTREE.test(child.name) || dayAge(ctx.now, child.mtimeMs) < p.stagingDays) continue;
    const c = dirCandidate(ctx, join(tmp, child.name), child.mtimeMs, `crash-leftover temp worktree older than ${p.stagingDays}d`);
    if (c) out.push(c);
  }
  return out;
}

const GENOME_CACHE = /^genome-index-[\da-f]+\.cache$/i;

function scanCaches(ctx: ScanCtx): MaintCandidate[] {
  const out: MaintCandidate[] = [];
  const p = ctx.policy;
  const { files } = walkFiles(join(ctx.roots.ashlrDir, 'summary-cache'), ctx);
  for (const row of files) {
    const c = aged(ctx, row, p.cacheDays, p.cacheDays, 'summary cache entry');
    if (c) out.push(c);
  }
  for (const f of children(ctx.roots.ashlrDir, ctx, 'file').filter(f => GENOME_CACHE.test(f.name))) {
    const c = aged(ctx, { path: join(ctx.roots.ashlrDir, f.name), bytes: f.bytes, mtimeMs: f.mtimeMs }, p.cacheDays, p.cacheDays, 'genome index cache');
    if (c) out.push(c);
  }
  return out;
}

function scanWorktrees(ctx: ScanCtx, root: string, states: ReadonlySet<string>): MaintCandidate[] {
  const out: MaintCandidate[] = [];
  const minAge = ctx.policy.worktreeMinAgeHours;
  for (const dir of children(root, ctx, 'dir')) {
    if (dir.name.startsWith('guardian-') || dir.name.includes('/') || dir.name.includes('\\')) continue;
    const path = join(root, dir.name);
    const record = ctx.ledger?.get(dir.name);
    const state = ctx.ledger === null ? 'unknown' : classifyWorktree(record);
    if (!states.has(state)) continue;
    const ageHours = record?.finishMs == null ? null : (ctx.now - record.finishMs) / HOUR_MS;
    if (ageHours === null || ageHours <= minAge) continue;
    if (ctx.kept(path)) continue;
    if (refused(ctx, path)) continue;
    const measured = ctx.measure(path);
    out.push({ path, action: 'worktree-remove', bytes: measured.bytes, ageDays: Math.floor(ageHours / 24), mtimeMs: record?.finishMs ?? null, reason: `${state} worktree, finished ${Math.floor(ageHours)}h ago` });
  }
  return out;
}

function scanBridgeTargets(ctx: ScanCtx): MaintCandidate[] {
  const out: MaintCandidate[] = [];
  const repos = join(ctx.roots.runsDir, 'repos');
  for (const repo of children(repos, ctx, 'dir')) {
    const target = join(repos, repo.name, 'target');
    const st = lstat(target);
    if (!st || !st.isDirectory() || st.isSymbolicLink() || dayAge(ctx.now, st.mtimeMs) < ctx.policy.bridgeTargetDays) continue;
    const c = dirCandidate(ctx, target, st.mtimeMs, `shared build target quiet ${ctx.policy.bridgeTargetDays}d`);
    if (c) out.push(c);
  }
  return out;
}

function scanVenvs(ctx: ScanCtx): MaintCandidate[] {
  const out: MaintCandidate[] = [];
  for (const proj of children(ctx.roots.sideProjectsDir, ctx, 'dir')) {
    const venv = join(ctx.roots.sideProjectsDir, proj.name, '.venv');
    const st = lstat(venv);
    if (!st || !st.isDirectory() || st.isSymbolicLink() || !lstat(join(venv, 'pyvenv.cfg')) || dayAge(ctx.now, st.mtimeMs) < ctx.policy.venvDays) continue;
    const c = dirCandidate(ctx, venv, st.mtimeMs, `rebuildable virtualenv quiet ${ctx.policy.venvDays}d`);
    if (c) out.push(c);
  }
  return out;
}

function scanHubClaude(ctx: ScanCtx): MaintCandidate[] {
  const out: MaintCandidate[] = [];
  if (!ctx.roots.hubDir) return out;
  const dot = join(ctx.roots.hubDir, '.claude');
  for (const sub of children(dot, ctx, 'dir').filter(d => SESSION_SUBDIRS.has(d.name))) {
    const { files } = walkFiles(join(dot, sub.name), ctx);
    for (const row of files) {
      const c = aged(ctx, row, ctx.policy.hubClaudeDays, ctx.policy.hubClaudeDays, 'hub .claude session cache');
      if (c) out.push(c);
    }
  }
  for (const f of children(dot, ctx, 'file').filter(f => LEFTOVER.test(f.name))) {
    const c = aged(ctx, { path: join(dot, f.name), bytes: f.bytes, mtimeMs: f.mtimeMs }, ctx.policy.hubClaudeDays, ctx.policy.hubClaudeDays, 'hub .claude session cache');
    if (c) out.push(c);
  }
  return out;
}

const SCANNERS: Record<MaintClassId, (ctx: ScanCtx) => MaintCandidate[]> = {
  'run-logs': scanRunLogs,
  'agent-sessions': scanAgentSessions,
  'ashlr-logs': scanAshlrLogs,
  'recovery-dirs': scanRecovery,
  'staging': scanStaging,
  'caches': scanCaches,
  'worktrees-runs': (ctx) => scanWorktrees(ctx, join(ctx.roots.runsDir, 'wt'), new Set(['merged', 'empty'])),
  'worktrees-jobs': (ctx) => scanWorktrees(ctx, ctx.roots.wtDir, new Set(['merged'])),
  'bridge-targets': scanBridgeTargets,
  'venvs': scanVenvs,
  'hub-claude': scanHubClaude,
};

const CLASS_NOTES: Partial<Record<MaintClassId, string>> = {
  'venvs': 'gated: enable with --allow venvs (rebuildable .venv trees only)',
  'hub-claude': 'gated: enable with --allow hub-claude (ashlr-hub .claude session cache)',
};

const defaultFreeBytes = (path: string): number | null => {
  let current = resolve(path);
  for (;;) {
    try {
      const stat = statfsSync(current);
      if (stat.bsize <= 0 || stat.bavail < 0) return null;
      return Number(stat.bavail) * Number(stat.bsize);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) return null;
      current = dirname(current);
    }
  }
};

export async function planDiskMaint(deps: MaintDeps = {}): Promise<DiskMaintPlan> {
  const now = deps.now ?? Date.now();
  const roots = deps.roots ?? resolveMaintRoots();
  const policy = { ...DEFAULT_POLICY, ...deps.policy };
  const deadlineMs = deps.deadlineMs ?? Date.now() + 20_000;
  const measure = deps.measure ?? ((dir: string) => measureWorktreeBytes(dir, { deadlineMs }));

  let jobs: { state: Source; text: string };
  try {
    jobs = await (deps.readJobs ?? ((path: string) => readSource(path, MAX_JOBS_BYTES, true)))(join(roots.runsDir, 'metrics', 'jobs.jsonl'));
  } catch {
    jobs = { state: 'degraded', text: '' };
  }
  // Unreadable ledger means unknown states everywhere: logs fall to orphan
  // ages and no worktree is ever claimed on a guess.
  const ledger = jobs.state === 'healthy' ? parseJobLedger(jobs.text) : null;

  let pins: KeptWorktrees;
  try { pins = await (deps.readPins ?? readKeptWorktrees)(); } catch { pins = { paths: [], valid: false }; }
  const kept = deps.kept ?? ((dir: string) => isKeptWorktree(dir, pins));

  let freeBytes: number | null = null;
  try {
    const raw = await (deps.freeBytes ?? defaultFreeBytes)(roots.runsDir);
    freeBytes = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
  } catch { freeBytes = null; }

  const ctx: ScanCtx = {
    roots, now, policy, ledger, kept, measure, deadlineMs,
    protectedRoots: protectedRoots(roots),
    refused: [],
  };
  const classes: MaintClassPlan[] = [];
  for (const id of ALL_CLASSES) {
    if (deps.only && !deps.only.has(id)) continue;
    const gated = GATED_CLASSES.has(id);
    const enabled = !gated || (deps.allow?.has(id) ?? false);
    let candidates: MaintCandidate[] = [];
    let complete = true;
    const note = CLASS_NOTES[id];
    if (!enabled && gated) {
      // Show what the flag would reclaim without listing actionable paths.
      try { candidates = SCANNERS[id](ctx); } catch { complete = false; }
      const bytes = candidates.reduce((s, c) => s + c.bytes, 0);
      classes.push({ id, gated, enabled: false, complete, ...(note ? { note } : {}), candidates: [], bytes });
      continue;
    }
    if (id === 'hub-claude' && !roots.hubDir) {
      classes.push({ id, gated, enabled, complete, note: 'ashlr-hub checkout not found', candidates: [], bytes: 0 });
      continue;
    }
    try { candidates = SCANNERS[id](ctx); } catch { complete = false; }
    classes.push({ id, gated, enabled, complete, ...(note ? { note } : {}), candidates, bytes: candidates.reduce((s, c) => s + c.bytes, 0) });
  }
  const all = classes.flatMap(c => c.candidates);
  return {
    schema: 'disk-maint.v1',
    generatedAt: new Date(now).toISOString(),
    apply: false,
    roots,
    freeGb: freeBytes === null ? null : Math.round((freeBytes / 1e9) * 10) / 10,
    diskguardReuseOnlyGb: DISKGUARD_REUSE_ONLY_GB,
    jobsSource: jobs.state,
    classes,
    totals: {
      candidates: all.length,
      bytes: all.reduce((s, c) => s + c.bytes, 0),
      complete: classes.every(c => c.complete),
    },
    refused: ctx.refused,
  };
}

/** Every candidate path re-validated through protect - used by apply too. */
export function candidateStillSafe(candidate: MaintCandidate, roots: MaintRoots, protectedRootsList: readonly string[]): string | null {
  const reason = protectedReason(candidate.path, roots, protectedRootsList);
  if (reason) return reason;
  const st = lstat(candidate.path);
  if (!st) return 'gone';
  if (st.isSymbolicLink()) return 'linked';
  if (candidate.action === 'worktree-remove' || candidate.action === 'delete-dir') {
    if (!st.isDirectory()) return 'not-a-directory';
    // worktree-remove's freshness is the ledger finish ts; git rechecks safety
    // itself. delete-dir re-checks the dir mtime so a dir that changed since
    // the plan is refused rather than eaten mid-write.
    if (candidate.action === 'delete-dir' && candidate.mtimeMs !== null && st.mtimeMs !== candidate.mtimeMs) return 'changed';
    return null;
  }
  if (!st.isFile()) return 'not-a-file';
  if (candidate.mtimeMs !== null && st.mtimeMs !== candidate.mtimeMs) return 'changed';
  if (st.size !== candidate.bytes) return 'changed';
  return null;
}

/** CLI-facing root override plumbing lives in protect.ts; re-export the bits. */
export { resolveMaintRoots, protectedRoots, protectedReason };
export type { MaintRoots };
