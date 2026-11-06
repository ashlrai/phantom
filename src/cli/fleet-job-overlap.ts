import { type Readable } from 'node:stream';
import { JOB_LIMIT_MAX, validJobId } from '../core/fleet/job-path-history.js';
import { JOB_BATCH_MAX } from '../core/fleet/job-history-batch.js';
import { JOB_OVERLAP_MIN_IDS, jobOverlap, type JobOverlapResult } from '../core/fleet/job-overlap.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** --stdin input cap, counted in raw bytes while reading. */
const STDIN_MAX_BYTES = 16 * 1024;
const DEFAULT_INPUT_TIMEOUT_MS = 5000;
type Input = Readable & { isTTY?: boolean };

const usage = 'Usage: ashlr fleet job-overlap RQ-ID... [--limit N] [--json]\n'
  + '       ashlr fleet job-overlap --stdin [--limit N] [--json] < ids.json\n'
  + `${JOB_OVERLAP_MIN_IDS}–${JOB_BATCH_MAX} distinct exact job ids; --limit is 1–${JOB_LIMIT_MAX} matching commits per id (default 20). `
  + `--stdin reads one piped JSON array of those ids (max ${STDIN_MAX_BYTES} bytes) and cannot be mixed with RQ-ID arguments. `
  + 'Only literal paths on landed bridge commits are compared — never queued claims or prospective diffs.';

const STDIN_REFUSAL = {
  'stdin-tty': 'stdin must be piped; interactive input is refused',
  'oversize': `input exceeds ${STDIN_MAX_BYTES} bytes`,
  'input-timeout': 'input did not reach end-of-input in time',
  'read-failed': 'stdin could not be read',
} as const;

export interface FleetJobOverlapDeps {
  /** Injected stdin for tests; defaults to process.stdin. */
  input?: Input;
  /** Injected reader for tests; defaults to jobOverlap. */
  overlap?: (jobIds: string[], limit: number) => Promise<JobOverlapResult>;
  /** Finite stdin deadline; defaults to 5000 ms. */
  inputTimeoutMs?: number;
}

const stdinRefusal = (reason: string): number => {
  console.error(`error: ${reason}`);
  console.error(usage);
  return 2;
};

/**
 * Collect raw bytes up to STDIN_MAX_BYTES, or give up on a stall. Rejects as
 * soon as the cap is crossed, and removes every listener and pauses the stream
 * on every exit path.
 */
function readInput(input: Input, timeoutMs: number): Promise<Buffer | keyof typeof STDIN_REFUSAL> {
  if (input.isTTY) return Promise.resolve('stdin-tty');
  if (input.destroyed || input.readableEnded) return Promise.resolve('read-failed');
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (result: Buffer | keyof typeof STDIN_REFUSAL): void => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onFailure);
      input.removeListener('close', onFailure);
      input.pause();
      resolve(result);
    };
    const onFailure = (): void => finish('read-failed');
    const onEnd = (): void => finish(Buffer.concat(chunks, size));
    const onData = (chunk: unknown): void => {
      if (!(chunk instanceof Uint8Array)) return finish('read-failed');
      size += chunk.byteLength;
      if (size > STDIN_MAX_BYTES) return finish('oversize');
      chunks.push(Buffer.from(chunk));
    };
    const timer = setTimeout(() => finish('input-timeout'), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onFailure);
    input.once('close', onFailure);
  });
}

/**
 * A strict JSON array of 2–JOB_BATCH_MAX distinct exact job ids, in input order.
 * Every refusal is a fixed message: neither the raw input nor a parser exception is echoed.
 */
function parseStdinIds(bytes: Buffer): string[] | string {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return 'input must be a UTF-8 JSON array'; }
  if (!Array.isArray(parsed)) return 'input must be a JSON array';
  if (parsed.length < JOB_OVERLAP_MIN_IDS || parsed.length > JOB_BATCH_MAX) {
    return `input must list ${JOB_OVERLAP_MIN_IDS} to ${JOB_BATCH_MAX} job ids`;
  }
  const seen = new Set<string>();
  for (const id of parsed) {
    if (typeof id !== 'string') return 'every entry must be a string';
    if (!validJobId(id)) return 'every entry must be an exact RQ job id';
    if (seen.has(id)) return 'job ids must be distinct';
    seen.add(id);
  }
  return parsed as string[];
}

/** Read-only planner audit of which landed jobs in a proposed batch touched the same literal paths. Never fetches, queues or merges. */
export async function cmdFleetJobOverlap(args: string[], deps: FleetJobOverlapDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const ids: string[] = [];
  const seenIds = new Set<string>();
  const seenFlags = new Set<string>();
  let limit = 20, json = false, stdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seenFlags.has(arg)) { json = true; seenFlags.add(arg); continue; }
    if (arg === '--stdin' && !seenFlags.has(arg)) { stdin = true; seenFlags.add(arg); continue; }
    if (arg === '--limit' && !seenFlags.has(arg)) {
      seenFlags.add(arg);
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) { console.error(usage); return 2; }
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > JOB_LIMIT_MAX) { console.error(usage); return 2; }
      continue;
    }
    if (arg.startsWith('-') || !validJobId(arg) || seenIds.has(arg) || ids.length >= JOB_BATCH_MAX) {
      console.error(usage); return 2;
    }
    seenIds.add(arg);
    ids.push(arg);
  }
  if (stdin) {
    if (ids.length) return stdinRefusal('--stdin cannot be mixed with positional job ids');
    const bytes = await readInput(deps.input ?? process.stdin, deps.inputTimeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS);
    if (typeof bytes === 'string') return stdinRefusal(STDIN_REFUSAL[bytes]);
    const parsed = parseStdinIds(bytes);
    if (typeof parsed === 'string') return stdinRefusal(parsed);
    ids.push(...parsed);
  }
  if (ids.length < JOB_OVERLAP_MIN_IDS) { console.error(usage); return 2; }
  try {
    const safe = sanitizePublicJson(await (deps.overlap ?? jobOverlap)(ids, limit)) as JobOverlapResult;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    console.log(`Resolved ${safe.ref} to ${safe.resolvedRef}; scanned ${safe.scanned} commits`
      + ` (bound ${safe.scanBound}; ${safe.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
    for (const job of safe.jobs) {
      console.log(`${job.jobId}: ${job.commits} kept commits, ${job.paths} paths`
        + `${job.matchesTruncated ? '; more matches than --limit kept' : ''}.`);
    }
    if (!safe.sharedPaths.length) {
      console.log('No shared paths observed in this bounded history; that is not proof of safety or permission to dispatch.');
      return 0;
    }
    console.log(`Shared paths (${safe.sharedPaths.length}):`);
    for (const group of safe.sharedPaths) console.log(`  ${group.path}: ${group.jobIds.join(', ')}`);
    return 0;
  } catch { console.error('error: unable to read job overlap from git'); return 1; }
}
