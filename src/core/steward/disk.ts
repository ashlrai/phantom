/**
 * Context & resource steward — Phase 1 disk/log guardrails.
 *
 * Agent CLIs (Codex especially) write unbounded session logs. The steward
 * measures known agent log/artifact roots, reports which are over budget, and
 * — only with explicit `apply` — deletes files that are older than the
 * retention window or that push a root over its quota (oldest first).
 *
 * Safety: only allowlisted roots under the user's home are ever touched; it
 * never follows symlinks, never deletes directories it did not empty, never
 * reads file contents, and skips files modified in the last 24 hours (live logs).
 */
import { lstatSync, readdirSync, rmdirSync, unlinkSync, existsSync, mkdirSync, readFileSync, writeFileSync,
  realpathSync, readSync, openSync, closeSync, fstatSync, fsyncSync, constants, type Stats } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';

/**
 * delete  — Phantom-owned/plain logs: remove expired + oldest-over-quota files.
 * archive — vendor session stores (Codex, Claude): never hand-delete; cold files
 *           are gzip-copied to $archiveDir, verified, then the original removed,
 *           only with explicit apply. Active (recently modified) sessions untouched.
 * report  — measure and warn only.
 */
export type StewardAction = 'delete' | 'archive' | 'report';
export interface StewardRoot { id: string; path: string; retentionDays: number; quotaMB: number; action: StewardAction; nativeHint?: string }
export interface StewardPolicy { roots: StewardRoot[]; minAgeMinutes: number; archiveDir: string }
export interface RootReport { id: string; path: string; exists: boolean; files: number; bytes: number; quotaBytes: number; overQuota: boolean; reclaimable: { files: number; bytes: number }; action: StewardAction; nativeHint?: string }
export interface StewardReport { applied: boolean; roots: RootReport[]; totalBytes: number; reclaimableBytes: number; deleted: { files: number; bytes: number }; archived: { files: number; bytes: number } }

export function defaultStewardPolicy(home = homedir()): StewardPolicy {
  const r = (id: string, rel: string, retentionDays: number, quotaMB: number, action: StewardAction, nativeHint?: string): StewardRoot => ({ id, path: join(home, rel), retentionDays, quotaMB, action, ...(nativeHint ? { nativeHint } : {}) });
  return {
    minAgeMinutes: 24 * 60,
    archiveDir: join(home, '.ashlr', 'archive'),
    roots: [
      r('codex-sessions', '.codex/sessions', 30, 20 * 1024, 'archive', 'Prefer `codex delete <session>` where available; avoid hand-deleting rollout JSONL.'),
      r('codex-log', '.codex/log', 14, 1024, 'delete'),
      r('claude-projects', '.claude/projects', 30, 10 * 1024, 'archive', 'Claude Code: set cleanupPeriodDays in settings.json for native retention.'),
      r('ashlr-logs', '.ashlr/logs', 14, 1024, 'delete'),
      r('ashlr-runs', '.ashlr/runs', 30, 4 * 1024, 'delete'),
    ],
  };
}

interface FileInfo { path: string; bytes: number; mtimeMs: number; stat: Stats }
interface Boundary { home: string; physicalHome: string; directories: Map<string, Stats> }
const sameDirectory = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: Stats, b: Stats) => sameDirectory(a, b) && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink;

function belowHome(path: string, home: string): boolean {
  const rel = relative(home, path);
  return isAbsolute(path) && rel !== '..' && !rel.startsWith('..' + '/') &&
    !rel.startsWith('..' + '\\') && !isAbsolute(rel);
}

/** Pin real directory identities from home down, including the traversal root.
 * Node has no portable openat/unlinkat API: these checks refuse observed swaps,
 * but cannot atomically exclude a hostile rename between a check and syscall.
 */
function directoryCurrent(path: string, boundary: Boundary, create = false): boolean {
  if (!belowHome(path, boundary.home)) return false;
  try {
    if (realpathSync(boundary.home) !== boundary.physicalHome) return false;
    let current = boundary.home;
    const rel = relative(boundary.home, path);
    const parts = rel ? rel.split(/[\\/]/) : [];
    for (let i = -1; i < parts.length; i++) {
      if (i >= 0) current = join(current, parts[i]);
      let st: Stats;
      try { st = lstatSync(current); }
      catch (error) {
        if (!create || i < 0 || (error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        // Create one component at a time; recursive mkdir could follow links.
        if (!directoryCurrent(dirname(current), boundary)) return false;
        mkdirSync(current, { mode: 0o700 });
        st = lstatSync(current);
      }
      const pinned = boundary.directories.get(current);
      if (!st.isDirectory() || st.isSymbolicLink() || (pinned && !sameDirectory(pinned, st)) ||
          realpathSync(current) !== join(boundary.physicalHome, relative(boundary.home, current))) return false;
      boundary.directories.set(current, st);
    }
    return true;
  } catch { return false; }
}

function fileCurrent(file: FileInfo, boundary: Boundary): boolean {
  if (!directoryCurrent(dirname(file.path), boundary)) return false;
  try {
    const st = lstatSync(file.path);
    return st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && sameFile(file.stat, st);
  } catch { return false; }
}

function walk(dir: string, out: FileInfo[], boundary: Boundary, depth = 0): void {
  if (depth > 12 || !directoryCurrent(dir, boundary)) return;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!directoryCurrent(dir, boundary)) return;
    const p = join(dir, n);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out, boundary, depth + 1);
    else if (st.isFile() && st.nlink === 1) out.push({ path: p, bytes: st.size, mtimeMs: st.mtimeMs, stat: st });
  }
}
function pruneEmpty(dir: string, root: string, boundary: Boundary, depth = 0): void {
  if (depth > 12 || !directoryCurrent(dir, boundary)) return;
  let names: string[]; try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!directoryCurrent(dir, boundary)) return;
    const p = join(dir, n);
    try { if (lstatSync(p).isDirectory()) pruneEmpty(p, root, boundary, depth + 1); } catch { /* gone */ }
  }
  if (dir !== root && directoryCurrent(dir, boundary)) {
    try { if (readdirSync(dir).length === 0 && directoryCurrent(dir, boundary)) rmdirSync(dir); } catch { /* not empty */ }
  }
}

function archiveFile(file: FileInfo, root: StewardRoot, archiveDir: string, boundary: Boundary): boolean {
  let source: number | undefined;
  let destination: number | undefined;
  try {
    if (!fileCurrent(file, boundary)) return false;
    source = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!sameFile(file.stat, fstatSync(source))) return false;
    const raw = readFileSync(source);
    if (raw.length !== file.bytes || !sameFile(file.stat, fstatSync(source)) || !fileCurrent(file, boundary)) return false;
    const gz = gzipSync(raw);
    const dest = join(archiveDir, root.id, relative(root.path, file.path) + '.gz');
    if (!directoryCurrent(dirname(dest), boundary, true) || !fileCurrent(file, boundary)) return false;
    // Existing archives (including links) are never overwritten or trusted.
    destination = openSync(dest, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(destination, gz);
    fsyncSync(destination);
    const archiveStat = fstatSync(destination);
    const archived = Buffer.alloc(gz.length);
    if (readSync(destination, archived, 0, archived.length, 0) !== archived.length ||
        !gunzipSync(archived).equals(raw) || !directoryCurrent(dirname(dest), boundary) ||
        !sameFile(archiveStat, lstatSync(dest)) || !fileCurrent(file, boundary)) return false;
    unlinkSync(file.path);
    return true;
  } catch { return false; /* leave original in place */ }
  finally {
    if (destination !== undefined) closeSync(destination);
    if (source !== undefined) closeSync(source);
  }
}

export function runSteward(policy: StewardPolicy, opts: { apply?: boolean; now?: number; home?: string } = {}): StewardReport {
  const now = opts.now ?? Date.now();
  const home = resolve(opts.home ?? homedir());
  const allowed = defaultStewardPolicy(home);
  let boundary: Boundary;
  try { boundary = { home, physicalHome: realpathSync(home), directories: new Map() }; }
  catch { boundary = { home, physicalHome: home, directories: new Map() }; }
  const report: StewardReport = { applied: !!opts.apply, roots: [], totalBytes: 0, reclaimableBytes: 0, deleted: { files: 0, bytes: 0 }, archived: { files: 0, bytes: 0 } };
  for (const root of policy.roots) {
    const quotaBytes = root.quotaMB * 1024 * 1024;
    const rr: RootReport = { id: root.id, path: root.path, exists: existsSync(root.path), files: 0, bytes: 0, quotaBytes, overQuota: false, reclaimable: { files: 0, bytes: 0 }, action: root.action, ...(root.nativeHint ? { nativeHint: root.nativeHint } : {}) };
    report.roots.push(rr);
    const admitted = allowed.roots.find((r) => r.id === root.id && r.path === root.path &&
      (r.action === root.action || root.action === 'report'));
    if (!rr.exists || !admitted || !Number.isFinite(now) ||
        !Number.isFinite(root.quotaMB) || root.quotaMB < 0 ||
        !Number.isFinite(root.retentionDays) || root.retentionDays < 0 ||
        !Number.isFinite(policy.minAgeMinutes) || policy.minAgeMinutes < 0 ||
        !directoryCurrent(root.path, boundary)) continue;
    const files: FileInfo[] = []; walk(root.path, files, boundary);
    rr.files = files.length; rr.bytes = files.reduce((a, f) => a + f.bytes, 0); rr.overQuota = rr.bytes > quotaBytes;
    const minAge = now - Math.max(24 * 60, policy.minAgeMinutes) * 60_000;
    const cutoff = now - root.retentionDays * 86_400_000;
    const victims = new Set<FileInfo>();
    const eligible = files.filter((f) => f.mtimeMs < minAge).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of eligible) if (f.mtimeMs < cutoff) victims.add(f);
    let remaining = rr.bytes - [...victims].reduce((a, f) => a + f.bytes, 0);
    for (const f of eligible) { if (remaining <= quotaBytes) break; if (!victims.has(f)) { victims.add(f); remaining -= f.bytes; } }
    rr.reclaimable = { files: victims.size, bytes: [...victims].reduce((a, f) => a + f.bytes, 0) };
    if (opts.apply && root.action === 'delete') {
      for (const f of victims) {
        try {
          if (!fileCurrent(f, boundary)) continue;
          unlinkSync(f.path); report.deleted.files++; report.deleted.bytes += f.bytes;
        } catch { /* raced */ }
      }
      pruneEmpty(root.path, root.path, boundary);
    } else if (opts.apply && root.action === 'archive' && policy.archiveDir === allowed.archiveDir) {
      for (const f of victims) {
        if (archiveFile(f, root, policy.archiveDir, boundary)) {
          report.archived.files++; report.archived.bytes += f.bytes;
        }
      }
      pruneEmpty(root.path, root.path, boundary);
    }
  }
  report.totalBytes = report.roots.reduce((a, r) => a + r.bytes, 0);
  report.reclaimableBytes = report.roots.reduce((a, r) => a + r.reclaimable.bytes, 0);
  return report;
}
