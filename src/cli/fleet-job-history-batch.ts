import { JOB_LIMIT_MAX, validJobId } from '../core/fleet/job-path-history.js';
import { JOB_BATCH_MAX, jobHistoryBatch, type JobHistoryBatchJob } from '../core/fleet/job-history-batch.js';
import {
  AWAIT_MS_MAX, INTERVAL_MS_DEFAULT, INTERVAL_MS_MAX, INTERVAL_MS_MIN, awaitJobHistory,
} from '../core/fleet/job-history-await.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-history-batch RQ-ID... [--limit N] [--at OID] [--await-ms N] [--interval-ms N] [--json]\n'
  + '       ashlr fleet job-history-batch --stdin [--limit N] [--at OID] [--await-ms N] [--interval-ms N] [--json]\n'
  + `1–${JOB_BATCH_MAX} distinct exact job ids; --limit is 1–${JOB_LIMIT_MAX} matching commits per id (default 20). `
  + '--stdin reads one JSON array of those ids (at most 64 KiB) instead of positional ids. '
  + 'By default scans current origin/master; --at selects a full commit OID reachable from origin/master. '
  + 'One bounded snapshot scan serves every id; empty evidence does not prove a job never landed. '
  + `--await-ms 0–${AWAIT_MS_MAX} re-observes until every id has a recorded bridge commit or the wall deadline `
  + `expires (exit 3); --interval-ms ${INTERVAL_MS_MIN}–${INTERVAL_MS_MAX} spaces observations (default ${INTERVAL_MS_DEFAULT}, `
  + 'only with --await-ms). Awaiting still reads only the locally maintained origin/master ref — it never fetches remote state.';

/** Stdin is read at most this far; past it the input is rejected without buffering the rest. */
export const JOB_STDIN_MAX_BYTES = 64 * 1024;

/** Chunk source; process.stdin by default, injectable so tests need no real pipe. */
export type JobIdStdin = AsyncIterable<Uint8Array | string>;

/**
 * Buffers at most JOB_STDIN_MAX_BYTES. On overflow it returns 'overflow' from
 * inside the for-await loop, which closes the source at once so no further
 * chunks are pulled. Stream errors propagate to the caller.
 */
async function readBoundedStdin(input: JobIdStdin): Promise<Buffer | 'overflow'> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    total += bytes.length;
    if (total > JOB_STDIN_MAX_BYTES) return 'overflow';
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Strict parse: strict UTF-8, one JSON array of 1–JOB_BATCH_MAX distinct exact ids. Null on any violation. */
function parseJobIdArray(bytes: Buffer): string[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > JOB_BATCH_MAX) return null;
  const seen = new Set<string>();
  for (const id of parsed) {
    if (typeof id !== 'string' || !validJobId(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return parsed as string[];
}

/** Human-mode per-job evidence block, shared by one-shot and await reports. */
function printJobEvidence(jobs: JobHistoryBatchJob[]): void {
  for (const job of jobs) {
    if (!job.commits.length) {
      console.log(`${job.jobId}: no matching commits in this bounded scan; this does not prove the job never landed.`);
      continue;
    }
    console.log(`${job.jobId}:${job.matchesTruncated ? ' matching commits exceed the result limit' : ''}`);
    for (const commit of job.commits) {
      console.log(`  ${commit.sha} ${commit.date} ${commit.pr === null ? '#?' : `#${commit.pr}`}`);
    }
    for (const path of job.paths) console.log(`  ${path}`);
  }
}

/**
 * Read-only batch audit of merged bridge commits; never fetches, queues or merges.
 * Ids come from positional args or, with --stdin, one JSON array; both feed the same
 * bounded reader. Usage errors exit 2 before any git call; a stdin read failure exits 1.
 */
export async function cmdFleetJobHistoryBatch(args: string[], stdin: JobIdStdin = process.stdin): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const ids: string[] = [];
  const seenIds = new Set<string>();
  const seenFlags = new Set<string>();
  let limit = 20, json = false, fromStdin = false;
  let at: string | undefined;
  let awaitMs: number | undefined, intervalMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seenFlags.has(arg)) { json = true; seenFlags.add(arg); continue; }
    if (arg === '--stdin' && !seenFlags.has(arg)) { fromStdin = true; seenFlags.add(arg); continue; }
    if (arg === '--at' && !seenFlags.has(arg)) {
      seenFlags.add(arg);
      at = args[++i];
      if (!at || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(at)) { console.error(usage); return 2; }
      continue;
    }
    if (arg === '--limit' && !seenFlags.has(arg)) {
      seenFlags.add(arg);
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) { console.error(usage); return 2; }
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > JOB_LIMIT_MAX) { console.error(usage); return 2; }
      continue;
    }
    if (arg === '--await-ms' && !seenFlags.has(arg)) {
      seenFlags.add(arg);
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) { console.error(usage); return 2; }
      awaitMs = Number(value);
      if (!Number.isSafeInteger(awaitMs) || awaitMs < 0 || awaitMs > AWAIT_MS_MAX) { console.error(usage); return 2; }
      continue;
    }
    if (arg === '--interval-ms' && !seenFlags.has(arg)) {
      seenFlags.add(arg);
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) { console.error(usage); return 2; }
      intervalMs = Number(value);
      if (!Number.isSafeInteger(intervalMs) || intervalMs < INTERVAL_MS_MIN || intervalMs > INTERVAL_MS_MAX) {
        console.error(usage); return 2;
      }
      continue;
    }
    if (arg.startsWith('-') || !validJobId(arg) || seenIds.has(arg) || ids.length >= JOB_BATCH_MAX) {
      console.error(usage); return 2;
    }
    seenIds.add(arg);
    ids.push(arg);
  }
  // Exactly one id source: --stdin with positional ids, or neither, is a usage error before any read.
  if (fromStdin ? ids.length > 0 : ids.length === 0) { console.error(usage); return 2; }
  if (intervalMs !== undefined && awaitMs === undefined) { console.error(usage); return 2; }
  if (fromStdin) {
    let bytes: Buffer | 'overflow';
    try { bytes = await readBoundedStdin(stdin); } catch {
      console.error('error: unable to read job ids from stdin'); return 1;
    }
    const piped = bytes === 'overflow' ? null : parseJobIdArray(bytes);
    if (!piped) { console.error(usage); return 2; }
    ids.push(...piped);
  }
  try {
    const read = (jobIds: string[], keep: number) =>
      at === undefined ? jobHistoryBatch(jobIds, keep) : jobHistoryBatch(jobIds, keep, undefined, { at });
    if (awaitMs !== undefined) {
      const awaited = await awaitJobHistory(ids, limit, awaitMs, intervalMs ?? INTERVAL_MS_DEFAULT, { read });
      const safeAwait = sanitizePublicJson(awaited) as typeof awaited;
      if (json) { console.log(JSON.stringify(safeAwait)); return safeAwait.outcome === 'observed' ? 0 : 3; }
      console.log(`Awaited bridge evidence for ${ids.length} job id(s) on the locally maintained origin/master ref`
        + ` (no fetch, no dispatch); outcome ${safeAwait.outcome} after ${safeAwait.observations} observation(s)`
        + ` in ${safeAwait.elapsedMs}ms.`);
      if (safeAwait.observedIds.length) console.log(`observed: ${safeAwait.observedIds.join(', ')}`);
      if (safeAwait.pendingIds.length) {
        console.log(`pending: ${safeAwait.pendingIds.join(', ')} — still not proven unmerged.`);
      }
      if (safeAwait.snapshot) {
        console.log(`Final snapshot resolved ${at === undefined ? 'origin/master' : 'the requested snapshot'} to`
          + ` ${safeAwait.snapshot.resolvedRef}; scanned ${safeAwait.snapshot.scanned} commits`
          + ` (bound ${safeAwait.snapshot.scanBound};`
          + ` ${safeAwait.snapshot.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
        printJobEvidence(safeAwait.snapshot.jobs);
      } else {
        console.log('No observation completed before the deadline; pending ids are not proven unmerged.');
      }
      return safeAwait.outcome === 'observed' ? 0 : 3;
    }
    const result = await read(ids, limit);
    const safe = sanitizePublicJson(result) as typeof result;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    console.log(`${at === undefined ? 'Resolved origin/master' : 'Resolved requested snapshot'} to ${safe.resolvedRef}; scanned ${safe.scanned} commits`
      + ` (bound ${safe.scanBound}; ${safe.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
    printJobEvidence(safe.jobs);
    return 0;
  } catch { console.error('error: unable to read job history batch from git'); return 1; }
}
