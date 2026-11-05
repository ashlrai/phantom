import { jobCompare, type JobCompareEntry, type JobCompareReport } from '../core/fleet/job-compare.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-compare (RQ-A RQ-B | --stdin) [--json]\n'
  + '--stdin reads a JSON array of exactly two job ids (up to 16 KiB).\n'
  + 'Exactly two distinct exact job ids. Compares what each job\'s newest matching bridge commit left at the literal '
  + 'paths both touched, from one pinned origin/master snapshot. Missing jobs are unmatched, never identical. '
  + 'Evidence only: identical objects are not a correctness, safety or merge verdict.';

const short = (oid: string) => oid.slice(0, 12);

function describe(entry: JobCompareEntry['atFirst']): string {
  return entry ? `${entry.mode} ${entry.type} ${short(entry.oid)}` : 'absent';
}

function printText(report: JobCompareReport): void {
  console.log(`Resolved ${report.ref} to ${report.resolvedRef}; scanned ${report.scanned} commits`
    + ` (bound ${report.scanBound}; ${report.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
  for (const job of report.jobs) {
    if (!job.commit) {
      console.log(`${job.jobId}: unmatched; no matching bridge commit in this bounded scan. Not identical; this does not prove the job never landed.`);
      continue;
    }
    console.log(`${job.jobId}: bridge commit ${job.commit.sha} ${job.commit.date} ${job.commit.pr === null ? '#?' : `#${job.commit.pr}`}`
      + `${job.matchesTruncated ? ' (older matching commits exist)' : ''}.`);
    if (job.omittedPaths) console.log(`  ${job.omittedPaths} more paths beyond the ${job.pathBound}-path bound not compared.`);
  }
  if (!report.comparable) {
    console.log(`Not compared: ${report.unmatched.join(', ')} unmatched. Unmatched jobs are never reported as identical.`);
  } else {
    const t = report.totals;
    console.log(`Compared ${t.shared} shared literal paths: ${t.identical} identical, ${t.different} different,`
      + ` ${t.bothAbsent} both-absent.`);
    if (!report.sharedPathsComplete) {
      console.log('Shared list is bounded by omitted paths; absence from it does not prove disjointness.');
    }
    for (const entry of report.entries) {
      console.log(`  ${entry.status.padEnd(12)} ${entry.path}  [${describe(entry.atFirst)}] vs [${describe(entry.atSecond)}]`);
    }
  }
  console.log(report.caveat);
}

const STDIN_LIMIT = 16 * 1024;
class InvalidStdin extends Error {}

async function readPair(input: AsyncIterable<Uint8Array>): Promise<string[]> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > STDIN_LIMIT) throw new InvalidStdin();
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new InvalidStdin(); }
  if (!Array.isArray(value) || value.length !== 2
    || !value.every(id => typeof id === 'string' && validJobId(id)) || value[0] === value[1]) {
    throw new InvalidStdin();
  }
  return value as string[];
}

interface CompareDeps {
  stdin?: AsyncIterable<Uint8Array>;
  compare?: typeof jobCompare;
}

/** Read-only comparison of two landed jobs; never fetches, mutates or merges. */
export async function cmdFleetJobCompare(args: string[], deps: CompareDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const ids: string[] = [];
  let json = false;
  let stdin = false;
  for (const arg of args) {
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--stdin' && !stdin) { stdin = true; continue; }
    if (arg.startsWith('-') || !validJobId(arg) || ids.includes(arg)) { console.error(usage); return 2; }
    ids.push(arg);
  }
  if (stdin ? ids.length !== 0 : ids.length !== 2) { console.error(usage); return 2; }
  try {
    if (stdin) ids.push(...await readPair(deps.stdin ?? process.stdin));
    const safe = sanitizePublicJson(await (deps.compare ?? jobCompare)(ids[0]!, ids[1]!)) as JobCompareReport;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    printText(safe);
    return 0;
  } catch (error) {
    if (error instanceof InvalidStdin) { console.error(usage); return 2; }
    console.error('error: unable to compare jobs from git'); return 1;
  }
}
