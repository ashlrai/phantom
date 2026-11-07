import { JOB_CURRENT_PATH_BOUND, type JobCurrentReport } from '../core/fleet/job-current.js';
import { jobCurrentBatch, type JobCurrentBatchReport } from '../core/fleet/job-current-batch.js';
import { JOB_BATCH_MAX, JOB_HISTORY_REF } from '../core/fleet/job-history-batch.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-current-batch RQ-ID... [--json]\n'
  + '       ashlr fleet job-current-batch --stdin [--json]  '
  + `1–${JOB_BATCH_MAX} distinct exact job ids; one pinned origin/master snapshot and one shared bounded log scan `
  + `serve every id (up to ${JOB_CURRENT_PATH_BOUND} compared paths each). Evidence, never a correctness verdict.`;

/** Stdin bytes bound; past this the input is rejected without buffering the rest. */
export const JOB_STDIN_MAX_BYTES = 64 * 1024;
export type JobIdStdin = AsyncIterable<Uint8Array | string>;
type GitRunner = (args: string[]) => Promise<string>;

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

function parseJobIdArray(bytes: Buffer): string[] | null {
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(decoded); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > JOB_BATCH_MAX) return null;
  const seen = new Set<string>();
  for (const id of parsed) {
    if (typeof id !== 'string' || !validJobId(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return parsed as string[];
}

/** Read-only recut audit over one immutable origin/master snapshot; never fetches, mutates or merges. */
export async function cmdFleetJobCurrentBatch(
  args: string[], stdin: JobIdStdin = process.stdin, run: GitRunner | undefined = undefined,
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const ids: string[] = [];
  const seenIds = new Set<string>();
  const seenFlags = new Set<string>();
  let json = false, fromStdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seenFlags.has(arg)) { json = true; seenFlags.add(arg); continue; }
    if (arg === '--stdin' && !seenFlags.has(arg)) { fromStdin = true; seenFlags.add(arg); continue; }
    if (arg.startsWith('-') || !validJobId(arg) || seenIds.has(arg) || ids.length >= JOB_BATCH_MAX) {
      console.error(usage); return 2;
    }
    seenIds.add(arg);
    ids.push(arg);
  }
  if (fromStdin ? ids.length > 0 : ids.length === 0) { console.error(usage); return 2; }
  if (fromStdin) {
    let bytes: Buffer | 'overflow';
    try { bytes = await readBoundedStdin(stdin); } catch {
      console.error('error: unable to read job current batch from stdin'); return 1;
    }
    const piped = bytes === 'overflow' ? null : parseJobIdArray(Buffer.from(bytes));
    if (!piped) { console.error(usage); return 2; }
    ids.push(...piped);
  }
  try {
    const safe = sanitizePublicJson(await jobCurrentBatch(ids, run)) as JobCurrentBatchReport;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    console.log(`Resolved ${safe.ref} to ${safe.resolvedRef}; scanned ${safe.scanned} commits`
      + ` (bound ${safe.scanBound}; ${safe.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
    for (const job of safe.jobs) {
      if (!job.commit) {
        console.log(`${job.jobId}: no matching bridge commit in this bounded scan; this does not prove the job never landed.`);
        continue;
      }
      console.log(`${job.jobId}: bridge commit ${job.commit.sha} ${job.commit.date} ${job.commit.pr === null ? '#?' : `#${job.commit.pr}`}`
        + `${job.matchesTruncated ? ' (older matching commits exist)' : ''}.`);
      for (const entry of job.entries) console.log(`  ${entry.status.padEnd(14)} ${entry.path}`);
      if (job.omittedPaths) console.log(`  ${job.omittedPaths} more paths beyond the ${job.pathBound}-path bound not compared.`);
    }
    const t = safe.totals;
    console.log(`${t.jobs} jobs (${t.matched} with a bridge commit): ${t.unchanged} unchanged, ${t.changed} changed,`
      + ` ${t.absentNow} absent-now, ${t.absentAtBoth} absent-at-both — evidence only, not a behavior verdict.`);
    return 0;
  } catch { console.error('error: unable to read job current batch from git'); return 1; }
}
