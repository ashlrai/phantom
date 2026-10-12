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
import { lstatSync, readdirSync, rmdirSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

export interface StewardRoot { id: string; path: string; retentionDays: number; quotaMB: number }
export interface StewardPolicy { roots: StewardRoot[]; minAgeMinutes: number }
export interface RootReport { id: string; path: string; exists: boolean; files: number; bytes: number; quotaBytes: number; overQuota: boolean; reclaimable: { files: number; bytes: number } }
export interface StewardReport { applied: boolean; roots: RootReport[]; totalBytes: number; reclaimableBytes: number; deleted: { files: number; bytes: number } }

export function defaultStewardPolicy(home = homedir()): StewardPolicy {
  const r = (id: string, rel: string, retentionDays: number, quotaMB: number): StewardRoot => ({ id, path: join(home, rel), retentionDays, quotaMB });
  return {
    minAgeMinutes: 60,
    roots: [
      r('codex-sessions', '.codex/sessions', 14, 2048),
      r('codex-log', '.codex/log', 7, 512),
      r('claude-projects', '.claude/projects', 30, 2048),
      r('ashlr-logs', '.ashlr/logs', 14, 512),
      r('ashlr-runs', '.ashlr/runs', 30, 2048),
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
  let names: string[]; try { names = readdirSync(dir); } catch { return; }
  for (const n of names) { const p = join(dir, n); try { if (lstatSync(p).isDirectory()) pruneEmpty(p, root); } catch { /* gone */ } }
  if (dir !== root) { try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* not empty */ } }
}

function safeRoot(path: string, home: string): boolean {
  const rel = relative(home, path);
  return isAbsolute(path) && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && rel.split(/[\\/]/).length >= 2;
}

export function runSteward(policy: StewardPolicy, opts: { apply?: boolean; now?: number; home?: string } = {}): StewardReport {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? homedir();
  const report: StewardReport = { applied: !!opts.apply, roots: [], totalBytes: 0, reclaimableBytes: 0, deleted: { files: 0, bytes: 0 } };
  for (const root of policy.roots) {
    const quotaBytes = root.quotaMB * 1024 * 1024;
    const rr: RootReport = { id: root.id, path: root.path, exists: existsSync(root.path), files: 0, bytes: 0, quotaBytes, overQuota: false, reclaimable: { files: 0, bytes: 0 } };
    report.roots.push(rr);
    if (!rr.exists || !safeRoot(root.path, home)) continue;
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
    if (opts.apply) {
      for (const f of victims) { try { unlinkSync(f.path); report.deleted.files++; report.deleted.bytes += f.bytes; } catch { /* raced */ } }
      pruneEmpty(root.path, root.path);
    }
  }
  report.totalBytes = report.roots.reduce((a, r) => a + r.bytes, 0);
  report.reclaimableBytes = report.roots.reduce((a, r) => a + r.reclaimable.bytes, 0);
  return report;
}
