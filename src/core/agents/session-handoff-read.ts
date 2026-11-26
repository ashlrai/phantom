/**
 * Read-only session-handoff accessors, split from session-handoff.ts so read
 * surfaces (the unified comms inbox, fleet indexes) can list and fetch
 * checkpoints without importing the write/plan path — that path pulls in
 * child_process git fingerprinting (session-handoff-repo.ts) and claim-store
 * leases, which must stay out of those readers' import closures. Everything
 * here is a pure journal read: no subprocess, no lock, no write, and the same
 * private-storage and stable-file gates session-handoff.ts applies.
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { HANDOFF_LOG_BYTES, handoffId, parseHandoff, refuseHandoff,
  type HandoffDraft, type HandoffSignal, type SessionHandoff } from './session-handoff-schema.js';

export function handoffDir(runs: string, create = false): string {
  const root = realpathSync(runs);
  const dir = join(root, 'handffs'); // Wire spelling is intentional: runs/handffs/<job>.jsonl.
  if (create) mkdirSync(dir, { mode: 0o700 });
  if (!assurePrivateStoragePath(dir, 'directory', 'inspect-existing', { anchorPath: root }).ok) {
    return refuseHandoff('Unsafe handoff directory.');
  }
  return dir;
}

export function readHandoffJournal(dir: string, job: string): { text: string; records: SessionHandoff[] } {
  if (!handoffId.safeParse(job).success) return refuseHandoff('Invalid job id.');
  const path = join(dir, `${job}.jsonl`);
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', records: [] };
    return refuseHandoff('Cannot inspect handoff journal.');
  }
  const read = readStableRegularFile(path, { anchorPath: dir, maxFileBytes: HANDOFF_LOG_BYTES, remainingBytes: HANDOFF_LOG_BYTES });
  if (!read.ok || !read.text.endsWith('\n')) return refuseHandoff('Unreadable or incomplete handoff journal.');
  try {
    const records = read.text.slice(0, -1).split('\n').map(line => parseHandoff(JSON.parse(line)));
    if (records.some((record, i) => record.job !== job || record.revision !== i + 1 || record.attempt !== records[0].attempt ||
      record.repo !== records[0].repo || (i > 0 && records[i - 1].signal.kind === 'completed'))) return refuseHandoff('Broken handoff history.');
    return { text: read.text, records };
  } catch { return refuseHandoff('Invalid handoff journal.'); }
}

export function readSessionHandoff(runs: string, job: string): SessionHandoff {
  return readHandoffJournal(handoffDir(runs), job).records.at(-1) ?? refuseHandoff('No checkpoint available.');
}

export interface SessionHandoffListEntry {
  job: string;
  attempt: string;
  revision: number;
  at: string;
  lane: string;
  model: string;
  minTier: HandoffDraft['minTier'];
  repo: string;
  signal: HandoffSignal;
  needs: string[];
  /** 'open' while the latest signal is not 'completed'; a completed journal is retained history. */
  state: 'open' | 'completed';
  /** repoState.head only; the absolute root, diff digest and Entire reference stay in the per-job read. */
  head: string;
}

export interface SessionHandoffList {
  schema: 'session-handoff.list.v1';
  /** 'missing' is a verified-absent store (no runs or handoffs directory); 'unavailable' means the
   * directory could not be read, so handoffs and unreadable stay null — unknown, never a fabricated empty. */
  status: 'ok' | 'missing' | 'unavailable';
  handoffs: SessionHandoffListEntry[] | null;
  /** Job ids whose journal failed the same validation `show` applies; other journals still list. */
  unreadable: string[] | null;
  /** More journal files exist than the bounded scan covers; the newest by journal mtime were read. */
  truncated: boolean;
}

const HANDOFF_LIST_MAX_JOURNALS = 256;

function handoffList(status: 'missing' | 'unavailable'): SessionHandoffList {
  const empty = status === 'missing';
  return { schema: 'session-handoff.list.v1', status,
    handoffs: empty ? [] : null, unreadable: empty ? [] : null, truncated: false };
}

/** Fleet-wide index of session-handoff journals: which jobs hold a checkpoint awaiting resume or
 * failover, without knowing each job id. Read-only; per-file validation matches `show`, so one
 * corrupt journal lands in `unreadable` instead of poisoning the index. Existence is staged before
 * the private-storage check because a never-written store is 'missing', not 'unsafe'. */
export function listSessionHandoffs(runs: string): SessionHandoffList {
  let root: string;
  try { root = realpathSync(runs); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return handoffList('missing');
    return handoffList('unavailable');
  }
  const dir = join(root, 'handoffs'); // Wire spelling is intentional: runs/handffs/<job>.jsonl.
  try { lstatSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return handoffList('missing');
    return handoffList('unavailable');
  }
  if (!assurePrivateStoragePath(dir, 'directory', 'inspect-existing', { anchorPath: root }).ok) {
    return refuseHandoff('Unsafe handoff directory.');
  }
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return handoffList('missing');
    return handoffList('unavailable');
  }
  const candidates = names.filter(name => name.endsWith('.jsonl'))
    .map(name => name.slice(0, -'.jsonl'.length))
    .filter(job => handoffId.safeParse(job).success)
    .map(job => {
      let mtime = Number.NEGATIVE_INFINITY;
      try { mtime = lstatSync(join(dir, `${job}.jsonl`)).mtimeMs; } catch { /* journal() reports it unreadable */ }
      return { job, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime || a.job.localeCompare(b.job));
  const scanned = candidates.slice(0, HANDOFF_LIST_MAX_JOURNALS);
  const handoffs: SessionHandoffListEntry[] = [];
  const unreadable: string[] = [];
  for (const { job } of scanned) {
    try {
      const record = readHandoffJournal(dir, job).records.at(-1);
      if (record === undefined) { unreadable.push(job); continue; }
      handoffs.push({ job: record.job, attempt: record.attempt, revision: record.revision, at: record.at,
        lane: record.lane, model: record.model, minTier: record.minTier, repo: record.repo,
        signal: record.signal, needs: [...record.needs],
        state: record.signal.kind === 'completed' ? 'completed' : 'open', head: record.repoState.head });
    } catch { unreadable.push(job); }
  }
  handoffs.sort((a, b) => b.at.localeCompare(a.at) || a.job.localeCompare(b.job));
  unreadable.sort();
  return { schema: 'session-handoff.list.v1', status: 'ok', handoffs, unreadable,
    truncated: candidates.length > scanned.length };
}
