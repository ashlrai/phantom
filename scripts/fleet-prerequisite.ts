/** Read-only merge prerequisite for a retained fleet job publication. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFleetJobDetail, isFleetJobId, type FleetJobDetailOptions, type FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';
import { defaultGitRunner, type GitRunner } from '../src/core/verse/git-ops.js';

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}(?![\s\S])/;
const SHA = /^[0-9a-f]{40}(?![\s\S])/i;
const FIELDS = 'number,url,state,headRefOid,mergeCommit,mergedAt';
const HELP = `Usage: npx tsx scripts/fleet-prerequisite.ts --job ID --repo owner/name --expected-head SHA [--json]

A RESULT PR publication is a handoff, not proof of a merge. This read-only gate
requires the published PR to be merged at the expected full head SHA, with a
merge commit and merge date. It never merges or launches work. Exit 0 means
ready; all other outcomes exit nonzero.`;

type Status = 'ready' | 'pending' | 'stale' | 'unavailable';
interface Input { job: string; repo: string; expectedHead: string }
interface Evidence {
  jobState: FleetJobDetailV1['state'] | null;
  sources: FleetJobDetailV1['sources'] | null;
  publicationUrl: string | null;
  pr: { number: number; url: string; state: string; headRefOid: string; mergeCommit: string | null; mergedAt: string | null } | null;
}
export interface PrerequisiteResult extends Input {
  schema: 'fleet.prerequisite.v1'; status: Status; reason: string; evidence: Evidence;
}
interface Deps { runner?: GitRunner; detailOptions?: FleetJobDetailOptions }

function prNumber(url: string, repo: string): number | null {
  // Match the literal canonical URL: no credentials, ports, query, fragment, encoding or suffix.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/i.exec(url);
  if (!match || match[0] !== url || `${match[1]}/${match[2]}`.toLowerCase() !== repo.toLowerCase()) return null;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) ? number : null;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
}

export async function fleetPrerequisite(input: Input, deps: Deps = {}): Promise<PrerequisiteResult> {
  const evidence: Evidence = { jobState: null, sources: null, publicationUrl: null, pr: null };
  const result = (status: Status, reason: string): PrerequisiteResult => ({
    schema: 'fleet.prerequisite.v1', ...input, status, reason, evidence,
  });
  if (!isFleetJobId(input.job) || !REPO.test(input.repo) || !SHA.test(input.expectedHead)) {
    return result('unavailable', 'Invalid job, repository, or full 40-character expected head SHA.');
  }
  let detail: FleetJobDetailV1;
  try { detail = await getFleetJobDetail(input.job, deps.detailOptions); }
  catch { return result('unavailable', 'Fleet job detail could not be read.'); }
  evidence.jobState = detail.state;
  evidence.sources = detail.sources;
  evidence.publicationUrl = detail.publish?.prUrl ?? null;
  if (Object.values(detail.sources).includes('degraded')) return result('unavailable', 'Fleet job source is degraded.');
  if (detail.state === 'running') return result('pending', 'A newer job attempt is running; retained publication is not current.');
  if (detail.sources.publish === 'missing' || !evidence.publicationUrl) return result('pending', 'Publication PR evidence is missing.');
  const number = prNumber(evidence.publicationUrl, input.repo);
  if (number === null) return result('unavailable', 'Publication URL is not a canonical PR in the requested repository.');

  let raw: Awaited<ReturnType<GitRunner>>;
  try {
    raw = await (deps.runner ?? defaultGitRunner)('gh', ['pr', 'view', String(number), '--repo', input.repo, '--json', FIELDS],
      { cwd: process.cwd(), timeoutMs: 15000, maxStdoutBytes: 64 * 1024 });
  } catch { return result('unavailable', 'GitHub PR lookup failed.'); }
  if (raw.code !== 0 || raw.timedOut || raw.truncated || raw.missing) return result('unavailable', 'GitHub PR lookup failed, timed out, or was truncated.');
  let pr: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    pr = parsed as Record<string, unknown>;
  } catch { return result('unavailable', 'GitHub PR response is malformed.'); }
  const merge = pr.mergeCommit;
  const oid = merge && typeof merge === 'object' && !Array.isArray(merge) ? (merge as Record<string, unknown>).oid : null;
  if (pr.number !== number || typeof pr.url !== 'string' || prNumber(pr.url, input.repo) !== number
    || !['OPEN', 'CLOSED', 'MERGED'].includes(String(pr.state)) || typeof pr.headRefOid !== 'string' || !SHA.test(pr.headRefOid)
    || !Object.hasOwn(pr, 'mergeCommit') || !Object.hasOwn(pr, 'mergedAt')
    || (pr.state === 'MERGED' && (typeof oid !== 'string' || !SHA.test(oid) || !validDate(pr.mergedAt)))
    || (pr.state !== 'MERGED' && (pr.mergeCommit !== null || pr.mergedAt !== null))) {
    return result('unavailable', 'GitHub PR response has invalid or inconsistent evidence.');
  }
  evidence.pr = { number, url: pr.url, state: String(pr.state), headRefOid: pr.headRefOid,
    mergeCommit: typeof oid === 'string' ? oid : null, mergedAt: typeof pr.mergedAt === 'string' ? pr.mergedAt : null };
  if (pr.headRefOid.toLowerCase() !== input.expectedHead.toLowerCase()) return result('stale', 'PR head differs from the expected head.');
  if (pr.state === 'OPEN') return result('pending', 'PR is open and has not merged.');
  if (pr.state === 'CLOSED') return result('stale', 'PR was closed without merging.');
  return result('ready', 'PR merged at the expected head with a merge commit and date.');
}

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) { console.log(HELP); return 0; }
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--job', '--repo', '--expected-head'].includes(arg) || Object.hasOwn(values, arg) || !argv[i + 1] || argv[i + 1]!.startsWith('--')) {
      console.error(`Invalid arguments.\n${HELP}`); return 2;
    }
    values[arg] = argv[++i]!;
  }
  const result = await fleetPrerequisite({ job: values['--job'] ?? '', repo: values['--repo'] ?? '', expectedHead: values['--expected-head'] ?? '' }, deps);
  console.log(json ? JSON.stringify(result) : `${result.status}: ${result.reason}\n${JSON.stringify(result.evidence)}`);
  return result.status === 'ready' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
