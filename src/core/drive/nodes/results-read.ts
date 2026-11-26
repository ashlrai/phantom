/**
 * Read-only summary of node runner result artifacts for the status digest.
 *
 * Scope: `~/.ashlr-runs/node-results/<jobId>.json` on THIS computer only. Other
 * nodes keep their own results; nothing here sees them. An artifact is local
 * evidence, not proof of completion (worker.complete is the fencing boundary,
 * see docs/NODES.md). Only job ids (taken from file names, never file bodies)
 * and timestamps leave this module: claim tokens, leader tokens and output
 * sizes are parsed away. Nothing is written.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assurePrivateStoragePath } from '../../util/private-storage.js';
import { readStableRegularFile } from '../../util/stable-file-read.js';
import { isPlainRecord } from '../drive-helpers.js';

export interface NodeResultsSummary {
  v: 1;
  authority: 'none';
  status: 'ok' | 'none' | 'unavailable';
  asOf: string;
  windowMs: number;
  /** Readable artifacts whose mtime falls inside the window. */
  inWindow: number;
  /** Newest readable artifact by mtime; `at` is that mtime as ISO. */
  newest: { jobId: string; at: string } | null;
  /** Looked-at files that were corrupt, oversized, unsafe or unreadable. */
  unreadable: number;
  /** More than `max` artifacts exist; only the newest `max` were examined. */
  truncated: boolean;
  reason?: 'unsafe-dir' | 'unreadable-dir' | 'reader-failed';
}

const MAX_FILE_BYTES = 16 * 1024;
const MAX_SCANNED = 5000; // bounds lstat work if the directory is flooded
const SCHEMA = 'phm-node-runner.v1';
const JOB_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;

export function readNodeResults(opts: { dir?: string; nowMs?: number; windowMs?: number; max?: number } = {}): NodeResultsSummary {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? 24 * 3_600_000;
  const max = Math.max(1, Math.floor(opts.max ?? 200));
  const dir = opts.dir ?? join(homedir(), '.ashlr-runs', 'node-results');
  const result = (status: NodeResultsSummary['status'], extra: Partial<NodeResultsSummary> = {}): NodeResultsSummary =>
    ({ v: 1, authority: 'none', status, asOf: new Date(nowMs).toISOString(), windowMs, inWindow: 0, newest: null, unreadable: 0, truncated: false, ...extra });

  let names: string[];
  try {
    let st;
    try { st = lstatSync(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result('none');
      return result('unavailable', { reason: 'unreadable-dir' });
    }
    const foreign = typeof process.getuid === 'function' && st.uid !== process.getuid();
    if (!st.isDirectory() || st.isSymbolicLink() || foreign || (st.mode & 0o077) !== 0 ||
        !assurePrivateStoragePath(dir, 'directory', 'inspect-owned', { anchorPath: dir }).ok) {
      return result('unavailable', { reason: 'unsafe-dir' });
    }
    names = readdirSync(dir).filter(name => JOB_FILE.test(name)).slice(0, MAX_SCANNED);
  } catch { return result('unavailable', { reason: 'unreadable-dir' }); }

  const files: Array<{ name: string; mtimeMs: number }> = [];
  let unreadable = 0;
  for (const name of names) {
    try {
      const st = lstatSync(join(dir, name));
      if (st.isFile()) files.push({ name, mtimeMs: st.mtimeMs }); else unreadable++; // symlinks and others are skipped, not followed
    } catch { unreadable++; }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
  const truncated = files.length > max;
  let inWindow = 0;
  let newest: NodeResultsSummary['newest'] = null;
  for (const file of files.slice(0, max)) {
    const jobId = JOB_FILE.exec(file.name)![1]!;
    const read = readStableRegularFile(join(dir, file.name), { anchorPath: dir, maxFileBytes: MAX_FILE_BYTES, remainingBytes: MAX_FILE_BYTES });
    let valid = false;
    if (read.ok) {
      try {
        const body: unknown = JSON.parse(read.text);
        valid = isPlainRecord(body) && body['schema'] === SCHEMA && body['jobId'] === jobId;
      } catch { /* counted as unreadable below */ }
    }
    if (!valid) { unreadable++; continue; }
    newest ??= { jobId, at: new Date(file.mtimeMs).toISOString() };
    if (file.mtimeMs >= nowMs - windowMs) inWindow++;
  }
  if (files.length === 0 && unreadable === 0) return result('none');
  return result('ok', { inWindow, newest, unreadable, truncated });
}
