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
 * reads file contents, and skips files modified in the last hour (live logs).
 */
import { lstatSync, realpathSync, readdirSync, rmdirSync, unlinkSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';

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
export interface RootReport { id: string; path: string; exists: boolean; files: number; bytes: number; quotaBytes: number; overQuota: boolean; refused?: string; reclaimable: { files: number; bytes: number }; action: StewardAction; nativeHint?: string }
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

interface FileInfo { path: string; bytes: number; mtimeMs: number }
function walk(dir: string, out: FileInfo[], depth = 0): void {
  if (depth > 12) return;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (st.isFile()) out.push({ path: p, bytes: st.size, mtimeMs: st.mtimeMs });
  }
}
function pruneEmpty(dir: string, root: string): void {
  try { if (lstatSync(dir).isSymbolicLink()) return; } catch { return; }
  let names: string[]; try { names = readdirSync(dir); } catch { return; }
  for (const n of names) { const p = join(dir, n); try { if (lstatSync(p).isDirectory()) pruneEmpty(p, root); } catch { /* gone */ } }
  if (dir !== root) { try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* not empty */ } }
}

function lexicallyUnder(path: string, base: string, minDepth = 1): boolean {
  const rel = relative(base, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && rel.split(/[\\/]/).length >= minDepth;
}
function realOrNull(p: string): string | null { try { return realpathSync(p); } catch { return null; } }
/** Realpath of the nearest existing ancestor joined with the not-yet-existing tail. */
function realPrefix(p: string): string | null {
  let cur = resolve(p); const tail: string[] = [];
  for (;;) {
    const r = realOrNull(cur);
    if (r) return tail.length ? join(r, ...tail.reverse()) : r;
    const up = dirname(cur); if (up === cur) return null;
    tail.push(cur.slice(up.length).replace(/^[\\/]+/, '')); cur = up;
  }
}

/**
 * A root is safe only when it is lexically ≥2 levels under home, is not itself a
 * symlink, and its realpath (resolving every parent component) is the same path
 * under the realpath of home. Any symlink hop that leaves home is refused.
 */
export function safeRoot(path: string, home: string): boolean {
  if (!isAbsolute(path) || !lexicallyUnder(resolve(path), resolve(home), 2)) return false;
  try { if (lstatSync(path).isSymbolicLink()) return false; } catch { /* missing roots are checked by realPrefix */ }
  const realHome = realOrNull(home); const real = realPrefix(path);
  if (!realHome || !real) return false;
  return lexicallyUnder(real, realHome, 2) && real === join(realHome, relative(resolve(home), resolve(path)));
}

/** Re-check immediately before mutating: a regular file (not a link) whose real parent is inside realRoot. */
export function insideRoot(file: string, realRoot: string): boolean {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    const realParent = realpathSync(dirname(file));
    return realParent === realRoot || realParent.startsWith(realRoot + sep);
  } catch { return false; }
}

export function runSteward(policy: StewardPolicy, opts: { apply?: boolean; now?: number; home?: string } = {}): StewardReport {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? homedir();
  const report: StewardReport = { applied: !!opts.apply, roots: [], totalBytes: 0, reclaimableBytes: 0, deleted: { files: 0, bytes: 0 }, archived: { files: 0, bytes: 0 } };
  for (const root of policy.roots) {
    const quotaBytes = root.quotaMB * 1024 * 1024;
    const rr: RootReport = { id: root.id, path: root.path, exists: existsSync(root.path), files: 0, bytes: 0, quotaBytes, overQuota: false, reclaimable: { files: 0, bytes: 0 }, action: root.action, ...(root.nativeHint ? { nativeHint: root.nativeHint } : {}) };
    report.roots.push(rr);
    if (!rr.exists) continue;
    if (!safeRoot(root.path, home)) { rr.refused = 'root is a symlink or resolves outside its allowed location'; continue; }
    const realRoot = realpathSync(root.path);
    const files: FileInfo[] = []; walk(root.path, files);
    rr.files = files.length; rr.bytes = files.reduce((a, f) => a + f.bytes, 0); rr.overQuota = rr.bytes > quotaBytes;
    const minAge = now - policy.minAgeMinutes * 60_000;
    const cutoff = now - root.retentionDays * 86_400_000;
    const victims = new Set<FileInfo>();
    const eligible = files.filter((f) => f.mtimeMs < minAge).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of eligible) if (f.mtimeMs < cutoff) victims.add(f);
    let remaining = rr.bytes - [...victims].reduce((a, f) => a + f.bytes, 0);
    for (const f of eligible) { if (remaining <= quotaBytes) break; if (!victims.has(f)) { victims.add(f); remaining -= f.bytes; } }
    rr.reclaimable = { files: victims.size, bytes: [...victims].reduce((a, f) => a + f.bytes, 0) };
    if (opts.apply && root.action === 'delete') {
      for (const f of victims) { if (!insideRoot(f.path, realRoot)) continue; try { unlinkSync(f.path); report.deleted.files++; report.deleted.bytes += f.bytes; } catch { /* raced */ } }
      pruneEmpty(root.path, root.path);
    } else if (opts.apply && root.action === 'archive' && safeRoot(policy.archiveDir, home)) {
      for (const f of victims) {
        try {
          if (!insideRoot(f.path, realRoot)) continue; // swapped for a link / escaped root
          if (lstatSync(f.path).mtimeMs !== f.mtimeMs) continue; // became active
          const raw = readFileSync(f.path);
          const gz = gzipSync(raw);
          const dest = join(policy.archiveDir, root.id, relative(root.path, f.path) + '.gz');
          mkdirSync(dirname(dest), { recursive: true });
          const realArchive = realpathSync(policy.archiveDir);
          const realDestDir = realpathSync(dirname(dest));
          if (!(realDestDir === realArchive || realDestDir.startsWith(realArchive + sep))) continue;
          writeFileSync(dest, gz, { mode: 0o600, flag: 'wx' }); // never overwrite an existing archive (file, link or hardlink)
          if (!gunzipSync(readFileSync(dest)).equals(raw)) continue; // verify before removing
          unlinkSync(f.path);
          report.archived.files++; report.archived.bytes += f.bytes;
        } catch { /* leave original in place */ }
      }
      pruneEmpty(root.path, root.path);
    }
  }
  report.totalBytes = report.roots.reduce((a, r) => a + r.bytes, 0);
  report.reclaimableBytes = report.roots.reduce((a, r) => a + r.reclaimable.bytes, 0);
  return report;
}
