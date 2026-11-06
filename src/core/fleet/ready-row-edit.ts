/**
 * core/fleet/ready-row-edit.ts — the guarded writer for
 * <runsDir>/queue/ready.tsv rows (RQ-PHX-RUNSREASSIGNVERB01).
 *
 * THE DISPATCHER CONTRACT (contrib/mac/dispatchd.py): ready.tsv has no
 * header — one row per queued job, tab-separated:
 *   id \t repo \t lane \t tier \t absolute prompt path
 * plus any extra columns a producer appended (kept verbatim in `raw`). A
 * parked row carries a lane like PARKED-BYHAND.codex-local instead of a real
 * lane id, so the dispatcher's `f[2] in LANES` check leaves it in the file.
 *
 * THE RACE THIS FILE EXISTS FOR: the dispatcher reads the whole file each
 * tick, launches what it can, then rewrites the file with the rows it did
 * not launch (temp + os.replace). A writer that lands between its read and
 * its rewrite has its edit silently reverted. So every write here is
 * verified: write, sleep verifyMs, re-read, and compare the rows the edit
 * touched (by id, as raw-line multisets — rows the edit did not touch are
 * deliberately ignored: the dispatcher may legitimately have launched them).
 * While a touched row still differs, rewrite and re-verify, up to `attempts`
 * writes. The caller gets the VERIFIED outcome, never the intended one.
 *
 * WRITE PRIMITIVE: `.ready-<uuid>.tmp` created O_EXCL 0o600 in the queue
 * directory itself, then rename(2) over ready.tsv — atomic, never partial,
 * same-filesystem by construction. Rows the edit returns unchanged keep
 * `raw` byte-identical; non-row lines (blank, `#`-comments) are not part of
 * the row set — parseReadyRows skips them and a rewrite does not carry them
 * forward (the real file is pure data rows).
 *
 * READ PATH mirrors the house bounded read (lstat regular-file, 2 MiB cap,
 * O_NOFOLLOW | O_NONBLOCK) with one deliberate difference: no inode recheck.
 * This file is REPLACED by rename every dispatcher tick — an open that lands
 * on the new inode is not a swapped-symlink attack, it is a fresh coherent
 * snapshot, and the handle's own fstat bounds the read for whatever inode it
 * actually opened. ENOENT propagates so callers can map a missing queue
 * themselves; other guard failures throw a plain Error.
 */
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Matches the reader bound in runs-parked-queue.ts. */
const MAX_READY_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 50_000;

export interface ReadyRow {
  id: string;
  repo: string;
  lane: string;
  tier: string;
  promptPath: string;
  /** The original line, untouched — rewriting a row means replacing `raw`. */
  raw: string;
}

export interface RewriteReadyRowsOptions {
  /** Delay between a write and its verification re-read. Default 2000 ms. */
  verifyMs?: number;
  /** Total writes attempted before giving up. Default 3. */
  attempts?: number;
  /** Clock seam for callers that attribute their own audit rows. */
  now?: () => Date;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RewriteReadyRowsResult {
  /** Rows whose id's raw-line multiset differs before vs after the edit. */
  changed: number;
  /** Writes actually performed (1 per attempt). */
  attempts: number;
  /** The post-verify file holds every row the edit produced for its ids. */
  verified: boolean;
}

/**
 * Positional parse of the dispatcher's queue file. Blank lines and lines
 * starting with `#` are skipped; every other line is a row — fewer than five
 * columns just leaves later fields empty, extra columns live on in `raw`.
 */
export function parseReadyRows(text: string): ReadyRow[] {
  const rows: ReadyRow[] = [];
  for (const rawLine of text.split('\n')) {
    if (rows.length >= MAX_ROWS) break;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim() || line.startsWith('#')) continue;
    const cells = line.split('\t');
    const [id = '', repo = '', lane = '', tier = '', promptPath = ''] = cells;
    rows.push({ id, repo, lane, tier, promptPath, raw: rawLine });
  }
  return rows;
}

/** Bounded, no-symlink-follow read of one queue file; ENOENT propagates. */
export async function readReadyText(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_READY_BYTES) throw new Error('ready.tsv is not a readable regular file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_READY_BYTES) throw new Error('ready.tsv is not a readable regular file');
    const bytes = Buffer.alloc(current.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX_READY_BYTES) throw new Error('ready.tsv exceeds read bound');
    return bytes.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

/** id → the multiset of raw lines carrying it (a job can legitimately repeat). */
function groupById(rows: readonly ReadyRow[]): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const row of rows) {
    const list = byId.get(row.id) ?? [];
    list.push(row.raw);
    byId.set(row.id, list);
  }
  return byId;
}

function sameMultiset(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return a === b;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/** Rows gained or lost per touched id: max(added, removed) of the raw multisets. */
function changedCount(before: Map<string, string[]>, after: Map<string, string[]>, touched: ReadonlySet<string>): number {
  let changed = 0;
  for (const id of touched) {
    const oldRaws = [...(before.get(id) ?? [])].sort();
    const newRaws = [...(after.get(id) ?? [])].sort();
    let removed = 0;
    let added = 0;
    for (let i = 0, j = 0; i < oldRaws.length || j < newRaws.length;) {
      if (i < oldRaws.length && (j >= newRaws.length || oldRaws[i]! < newRaws[j]!)) { removed++; i++; }
      else if (j < newRaws.length && (i >= oldRaws.length || newRaws[j]! < oldRaws[i]!)) { added++; j++; }
      else { i++; j++; }
    }
    changed += Math.max(removed, added);
  }
  return changed;
}

/**
 * Apply `edit` to the parsed rows of `<queueDir>/ready.tsv` and commit the
 * result atomically, then verify it survived the dispatcher's rewrite. The
 * edit runs against a FRESH parse done inside this call — callers must not
 * assume the rows they inspected are the rows being written. Returning null
 * (or rows that produce no per-id change) writes nothing.
 */
export async function rewriteReadyRows(
  queueDir: string,
  edit: (rows: ReadyRow[]) => ReadyRow[] | null,
  opts: RewriteReadyRowsOptions = {},
): Promise<RewriteReadyRowsResult> {
  const path = join(queueDir, 'ready.tsv');
  const originalText = await readReadyText(path);
  const originalRows = parseReadyRows(originalText);
  const before = groupById(originalRows); // snapshot before the edit can mutate rows
  const edited = edit(originalRows);
  if (edited === null) return { changed: 0, attempts: 0, verified: true };
  const after = groupById(edited);
  const touched = new Set([...before.keys(), ...after.keys()]
    .filter((id) => !sameMultiset(before.get(id), after.get(id))));
  if (!touched.size) return { changed: 0, attempts: 0, verified: true };
  const trailingNewline = originalText === '' || originalText.endsWith('\n');
  const text = edited.length === 0 ? '' : edited.map((row) => row.raw).join('\n') + (trailingNewline ? '\n' : '');
  const changed = changedCount(before, after, touched);
  const verifyMs = Math.max(0, opts.verifyMs ?? 2000);
  const maxAttempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let temp: string | undefined;
  try {
    for (let attempt = 1; ; attempt++) {
      temp = join(queueDir, `.ready-${randomUUID()}.tmp`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(text); } finally { await handle.close(); }
      await rename(temp, path);
      temp = undefined;
      await sleep(verifyMs);
      let freshText: string;
      try {
        freshText = await readReadyText(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') freshText = '';
        else throw error;
      }
      const fresh = groupById(parseReadyRows(freshText));
      if ([...touched].every((id) => sameMultiset(fresh.get(id), after.get(id)))) {
        return { changed, attempts: attempt, verified: true };
      }
      if (attempt >= maxAttempts) return { changed, attempts: attempt, verified: false };
    }
  } finally { if (temp) await unlink(temp).catch(() => {}); }
}
