/**
 * core/fleet/empty-merge-scan.ts — read-only scan of landed `bridge(...)`
 * commits on a ref, classifying each as 'real', 'evidence-only' or 'empty'
 * (zero added+deleted lines on every file, e.g. a 0-byte add, or no files at
 * all). A commit whose only content changes are `.bridge-evidence/` paths or
 * `BRIDGE_NOTES.md` is 'evidence-only'. Exists so a merged bridge commit
 * stops counting as "done" when nothing landed.
 *
 * Pinned log format (asserted by test/fleet-empty-merges-371.test.ts):
 *   git log -m --first-parent --no-renames --numstat -z \
 *     --format=%x00%H%x09%s -n <limit> <ref> --
 * The stream is NUL-separated records: NUL, sha, TAB, subject, NUL, LF, then
 * one NUL-terminated `adds<TAB>dels<TAB>path` entry per file (`-` marks a
 * binary). `-m --first-parent` gives merge commits a diff against their
 * first parent so they are not mistaken for empty ones.
 */
import { execFileSync } from 'node:child_process';

export const EMPTY_MERGE_DEFAULT_REF = 'origin/master';
export const EMPTY_MERGE_DEFAULT_LIMIT = 50;
export const EMPTY_MERGE_MAX_LIMIT = 500;

export interface MergeFile {
  path: string;
  /** Added lines; 0 for binary files (git reports `-`). */
  added: number;
  /** Deleted lines; 0 for binary files. */
  deleted: number;
  binary: boolean;
}

export interface MergeCommit {
  sha: string;
  subject: string;
  files: MergeFile[];
}

export type MergeVerdict = 'empty' | 'evidence-only' | 'real';

export interface MergeScanRow {
  sha: string;
  subject: string;
  /** The `RQ-[A-Z0-9-]+` id from `bridge(RQ-…)`, else null. */
  job: string | null;
  verdict: MergeVerdict;
  files: number;
}

export interface EmptyMergeScan {
  v: 1;
  asOf: string;
  ref: string;
  /** Bridge-subject commits inspected (bounded by the scan limit). */
  scanned: number;
  /** Only non-'real' verdicts are reported. */
  rows: MergeScanRow[];
  /** 'unavailable' when git could not be read; no error text or path. */
  source?: 'unavailable';
}

const HEADER = /^([0-9a-f]{40,64})\t([\s\S]*)$/;
const COUNT = /^(?:-|\d+)$/;
const JOB = /^bridge\((RQ-[A-Z0-9-]+)\)/;
const EVIDENCE = /^\.bridge-evidence\//;

/** Parse the pinned `git log --numstat -z` stream into per-commit records. */
export function parseNumstatLog(text: string): MergeCommit[] {
  const commits: MergeCommit[] = [];
  const segments = text.split('\0');
  let current: MergeCommit | undefined;
  for (let i = 0; i < segments.length; i++) {
    const header = HEADER.exec(segments[i]!);
    if (header) {
      current = { sha: header[1]!, subject: header[2]!, files: [] };
      commits.push(current);
      continue;
    }
    if (!current) continue;
    const entry = segments[i]!.startsWith('\n') ? segments[i]!.slice(1) : segments[i]!;
    if (entry === '') continue;
    const t1 = entry.indexOf('\t');
    const t2 = t1 < 0 ? -1 : entry.indexOf('\t', t1 + 1);
    if (t2 < 0) continue;
    const added = entry.slice(0, t1), deleted = entry.slice(t1 + 1, t2);
    if (!COUNT.test(added) || !COUNT.test(deleted)) continue;
    let path = entry.slice(t2 + 1);
    if (path === '') {
      // -z rename form: `a\td\t\0old\0new`; keep the destination path.
      path = segments[i + 2] ?? '';
      i += 2;
    }
    const binary = added === '-' || deleted === '-';
    current.files.push({ path, added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted), binary });
  }
  return commits;
}

/**
 * Classify one commit. `sizes` maps a path to its byte size for entries git
 * reports as binary (`-` in numstat): a 0-byte binary still counts as no
 * change, while a binary of unknown size counts as real so a possibly-real
 * merge is never reported empty.
 */
export function classifyMerge(c: MergeCommit, sizes: Map<string, number>): MergeScanRow {
  const changed = c.files.filter(file =>
    file.binary ? (sizes.get(file.path) ?? 1) !== 0 : file.added + file.deleted > 0);
  const verdict: MergeVerdict = changed.length === 0
    ? 'empty'
    : changed.every(file => EVIDENCE.test(file.path) || file.path === 'BRIDGE_NOTES.md') ? 'evidence-only' : 'real';
  return { sha: c.sha, subject: c.subject, job: JOB.exec(c.subject)?.[1] ?? null, verdict, files: c.files.length };
}

const git = (cwd: string | undefined) => (args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Scan at most `limit` commits (default 50, capped at 500) on `ref` (default
 * `origin/master`), classify each `bridge(`-subject commit, and report only
 * non-'real' rows. A git failure reports `source: 'unavailable'` rather than
 * leaking stderr text or paths.
 */
export function scanEmptyMerges(opts: { cwd?: string; ref?: string; limit?: number; exec?: (args: string[]) => string } = {}): EmptyMergeScan {
  const ref = opts.ref ?? EMPTY_MERGE_DEFAULT_REF;
  const limit = Number.isSafeInteger(opts.limit) && opts.limit! > 0
    ? Math.min(opts.limit!, EMPTY_MERGE_MAX_LIMIT)
    : EMPTY_MERGE_DEFAULT_LIMIT;
  const asOf = new Date().toISOString();
  const run = opts.exec ?? git(opts.cwd);
  let text: string;
  try {
    text = run(['log', '-m', '--first-parent', '--no-renames', '--numstat', '-z', '--format=%x00%H%x09%s', `-n${limit}`, ref, '--']);
  } catch {
    return { v: 1, asOf, ref, scanned: 0, rows: [], source: 'unavailable' };
  }
  const rows: MergeScanRow[] = [];
  let scanned = 0;
  for (const commit of parseNumstatLog(text)) {
    if (!commit.subject.startsWith('bridge(')) continue;
    scanned += 1;
    const row = classifyMerge(commit, new Map());
    if (row.verdict !== 'real') rows.push(row);
  }
  return { v: 1, asOf, ref, scanned, rows };
}
