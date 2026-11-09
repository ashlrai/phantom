/**
 * `phm fleet rebase-plan` — turn the snapshot's conflicting bridge PRs into
 * ready.tsv-ready rebase-job specs (RQ-SWE3-MERGEBATCH-WIRE-1).
 *
 * `fleet merge-batch` predicts which open PRs share files (the conflict
 * graph); queuegen/restock generate queue work. This is the link: the
 * conflicting `bridge:` population (the same set `fleet rebase-status`
 * counts) is clustered by file overlap — same-file PRs ride in one job so a
 * worker resolves their shared conflicts together, disjoint clusters spread
 * as parallel jobs — and every cluster renders as a job spec carrying the
 * router-queue `- READY` line, the `queue/prompts/<id>.md` prompt body, and
 * the ready.tsv row fields. Oversized clusters split into file-connected
 * chunks chained by `after=` (they land PARKED-DEP and unpark in order).
 *
 * INPUT, never gh: same snapshot contract as `fleet merge-batch` — `--input`,
 * a piped stdin, or `<root>/fleet/open-prs.json` — as a raw `gh pr list`
 * array, a merge-backlog read, or a fleet.pr-hygiene.v1 report.
 *
 * COVERAGE and HOLD LIST: the live queue is read from `<queue-dir>`
 * (default `<root>/queue`): `router-queue.md` lines and `ready.tsv` rows
 * already covering a conflicting PR exclude it (`--no-coverage` disables),
 * and `hold-list.txt` entries (`<repo>#<pr>`) are never planned
 * (`--hold-file` overrides). Both degrade to honest states, never guesses.
 *
 * EMIT: `--emit json` (default; the fleet.rebase-plan.v1 plan with full job
 * specs), `--emit lines` (the `- READY` router-queue lines — append to
 * router-queue.md), `--emit rows` (ready.tsv rows — the writer must create
 * `<queue-dir>/prompts/<id>.md` with the spec's `prompt` body first).
 * Read-only: writes nothing, grants no rebase or merge authority. Exit 0
 * plan produced, 1 no usable snapshot or a failed upstream read, 2 bad usage.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { looksLikeOption } from './args.js';
import { defaultSnapshotRoot, parseSnapshotJson, readPrSnapshot } from './fleet-pr-snapshot.js';
import { parseMergeBatchPrs } from '../core/fleet/merge-batch.js';
import {
  REBASE_PLAN_SCHEMA,
  REBASE_PLAN_MAX_JOB_MEMBERS,
  parseHoldList,
  planRebaseJobs,
  renderReadyRow,
  type RebasePlan,
  type RebasePlanExistingJob,
} from '../core/fleet/rebase-plan.js';

const USAGE = `Usage: phm fleet rebase-plan [--input <file>|-] [--repo <owner/name>] [--root <abs>]
  [--queue-dir <abs>] [--hold-file <path>] [--no-coverage] [--defer-behind-clean]
  [--pool <lane>] [--tier <tier>] [--priority <P0-P3>] [--max-prs <1-16>]
  [--emit json|lines|rows] [--json]
Cluster conflicting bridge PRs by file overlap and emit rebase-job specs:
same-file clusters become one job, disjoint clusters spread. Input is a
gh pr list array, a merge-backlog read or a fleet.pr-hygiene.v1 report via
--input, piped stdin, or <root>/fleet/open-prs.json. Existing queue lines in
<queue-dir>/router-queue.md and ready.tsv rows cover PRs already queued;
hold-list.txt entries skip held PRs. --emit lines prints router-queue rows;
--emit rows prints ready.tsv rows (writer creates the prompt files).
Conflicting PRs replaced by an open RQ-RECUT rework PR are dropped;
--defer-behind-clean also waits out PRs sharing a file with a clean PR.
Read-only: never calls gh, never writes. Exit 1 when no usable snapshot.`;

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const PRIORITY_RE = /^P[0-3]$/;
const POOL_RE = /^[a-z][a-z-]{0,30}$/;
/** Status-first parked row cell: PARKED-DEP.lane, PARKED-MERGERATE.lane, PARKED-SPLIT.lane, … */
const PARK_DEP = /^PARKED-[A-Z][A-Z-]*(?:\.|$)/i;
const REBASE_ID = /RQ-(?:REBASE|RECUT)[A-Za-z0-9._-]*/;
const LINE_STATUS = /^- ([A-Z][A-Z-]*)\b/;
const REPO_ATTR = /\brepo=(?:[A-Za-z0-9._-]+\/)?([A-Za-z0-9._-]+)/;
const EMIT = new Set(['json', 'lines', 'rows']);
/** Status words a named column can carry (mirrors lane-console's KNOWN_STATUSES). */
const KNOWN_STATUS = new Set([
  'READY', 'CLAIMED', 'PR-OPEN', 'BLOCKED', 'HOLD', 'DONE', 'PROPOSED', 'LAND',
  'LANDED', 'MERGED', 'RUNNING', 'STARTING', 'QUEUED', 'WAITING', 'FAILED',
  'CANCELLED', 'SPLIT-PARENT', 'HELD', 'PUBLISHING', 'PUBLISHED', 'FINISHED',
  'PUBLISH_UNKNOWN', 'DISPATCHED', 'IN-PROGRESS', 'WORKING', 'HOLD-SECURITY',
]);

export interface FleetRebasePlanDeps {
  stdin?: Readable;
  stdinIsTty?: boolean;
  readText?: (path: string) => Promise<string>;
  /** State-file root; defaults to ASHLR_RUNS_DIR ?? ~/.ashlr-runs. */
  root?: string;
  /** Queue directory; defaults to <root>/queue. */
  queueDir?: string;
  now?: () => Date;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface CoverageRead {
  state: 'ok' | 'missing' | 'degraded';
  jobs: RebasePlanExistingJob[];
}

/** router-queue.md: every line carrying an RQ-REBASE id, with its status word and repo attr. */
function jobsFromRouterQueue(text: string): RebasePlanExistingJob[] {
  const jobs: RebasePlanExistingJob[] = [];
  for (const line of text.split(/\r?\n/)) {
    const status = LINE_STATUS.exec(line)?.[1];
    const id = REBASE_ID.exec(line)?.[0];
    if (!status || !id) continue;
    jobs.push({ id, status, repo: REPO_ATTR.exec(line)?.[1] ?? null, text: line.slice(0, 2_000) });
  }
  return jobs;
}

/**
 * ready.tsv: id + status + repo per row, across the four row grammars restock
 * writes and reads — status-first parked (PARKED-DEP.lane id lane tier repo pf),
 * dispatcher parked (id repo PARKED-DEP.lane tier pf), status-first/header
 * (status|id … repo), and the plain five-column id repo pool tier pf row.
 */
function jobsFromReadyTsv(text: string): RebasePlanExistingJob[] {
  const jobs: RebasePlanExistingJob[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = line.split('\t').map(cell => cell.trim());
    let id: string | undefined;
    let status = 'READY';
    let repo: string | null = null;
    if (cells[0] === 'id' || cells[0] === 'job') continue; // header row
    if (PARK_DEP.test(cells[0] ?? '') && cells.length > 1) {
      status = cells[0]!.split('.')[0]!;                        // status-first parked
      id = cells[1];
      repo = cells[4] ?? null;
    } else if (cells.length > 2 && PARK_DEP.test(cells[2]!)) {
      status = cells[2]!.split('.')[0]!;                        // dispatcher parked
      id = cells[0];
      repo = cells[1] ?? null;
    } else if (KNOWN_STATUS.has(cells[0]?.toUpperCase() ?? '')) {
      status = cells[0]!.toUpperCase();                         // status-first row
      id = cells[1];
      repo = cells[4] ?? null;
    } else {
      id = cells[0];
      const maybeStatus = cells[1]?.toUpperCase();
      if (maybeStatus !== undefined && KNOWN_STATUS.has(maybeStatus)) {
        status = maybeStatus;                                   // id status pool tier repo …
        repo = cells[4] ?? null;
      } else {
        repo = cells[1] ?? null;                                // id repo pool tier promptfile
      }
    }
    if (id === undefined || !REBASE_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    jobs.push({ id, status, repo, text: '' });
  }
  return jobs;
}

async function readCoverage(queueDir: string, readText: (path: string) => Promise<string>): Promise<CoverageRead> {
  const jobs: RebasePlanExistingJob[] = [];
  let missing = 0;
  let read = 0;
  for (const file of ['router-queue.md', 'ready.tsv'] as const) {
    try {
      const text = await readText(join(queueDir, file));
      read += 1;
      jobs.push(...(file === 'router-queue.md' ? jobsFromRouterQueue(text) : jobsFromReadyTsv(text)));
    } catch {
      missing += 1;
    }
  }
  if (read === 0) return { state: 'missing', jobs: [] };
  return { state: missing > 0 ? 'degraded' : 'ok', jobs };
}

function failedPlan(repo: string | null, now: Date, input: Record<string, unknown>, error: string): RebasePlan & { input: Record<string, unknown>; error: string } {
  return {
    schema: REBASE_PLAN_SCHEMA, v: 1, repo, generatedAt: now.toISOString(),
    input, error,
    counts: { open: 0, unreadable: 0, duplicates: 0, conflicting: 0, held: 0, covered: 0, superseded: 0, exhausted: 0, deferred: 0, jobs: 0, clusters: 0, singles: 0, chunks: 0, chained: 0, pinned: 0, noFileData: 0 },
    coverage: { state: 'skipped', coveredPrs: [] },
    exhausted: [],
    jobs: [],
  };
}

export async function cmdFleetRebasePlan(args: string[], deps: FleetRebasePlanDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { out(USAGE + '\n'); return 0; }

  let inputPath: string | null = null;
  let repo: string | null = null;
  let json = false;
  let emit: 'json' | 'lines' | 'rows' | null = null;
  let coverage = true;
  let holdFile: string | null = null;
  let pool = 'any';
  let tier = 'work';
  let priority = 'P1';
  let maxPrs: number | null = null;
  let deferBehindClean = false;
  let root = deps.root;
  let queueDir = deps.queueDir;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--no-coverage' && coverage) { coverage = false; continue; }
    if (arg === '--defer-behind-clean') { deferBehindClean = true; continue; }
    if (arg === '--emit') {
      const value = args[++i];
      if (!EMIT.has(value ?? '')) { err(`error: --emit requires json|lines|rows, got: ${value ?? '(missing)'}\n${USAGE}\n`); return 2; }
      emit = value as 'json' | 'lines' | 'rows';
      continue;
    }
    if (arg === '--input' && inputPath === null) {
      const value = args[++i];
      if (value === undefined || (looksLikeOption(value) && value !== '-')) {
        err(`error: --input requires a file path (or - for stdin)\n${USAGE}\n`);
        return 2;
      }
      inputPath = value;
      continue;
    }
    if (arg === '--repo' && repo === null) {
      const value = args[++i];
      if (!REPO_RE.test(value ?? '')) {
        err(`error: --repo requires <owner/name>, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      repo = value!;
      continue;
    }
    const absolute = (flag: string): string | null => {
      const value = args[++i];
      if (value === undefined || !isAbsolute(value)) {
        err(`error: ${flag} requires an absolute path, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return null;
      }
      return value;
    };
    if (arg === '--root') { const v = absolute('--root'); if (v === null) return 2; root = v; continue; }
    if (arg === '--queue-dir') { const v = absolute('--queue-dir'); if (v === null) return 2; queueDir = v; continue; }
    if (arg === '--hold-file') { const v = absolute('--hold-file'); if (v === null) return 2; holdFile = v; continue; }
    if (arg === '--pool') {
      const value = args[++i];
      if (!POOL_RE.test(value ?? '')) { err(`error: --pool requires a lane id, got: ${value ?? '(missing)'}\n${USAGE}\n`); return 2; }
      pool = value!;
      continue;
    }
    if (arg === '--tier') {
      const value = args[++i];
      if (value === undefined || looksLikeOption(value)) { err(`error: --tier requires a queue tier\n${USAGE}\n`); return 2; }
      tier = value;
      continue;
    }
    if (arg === '--priority') {
      const value = args[++i];
      if (!PRIORITY_RE.test(value ?? '')) { err(`error: --priority requires P0–P3, got: ${value ?? '(missing)'}\n${USAGE}\n`); return 2; }
      priority = value!;
      continue;
    }
    if (arg === '--max-prs') {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > REBASE_PLAN_MAX_JOB_MEMBERS) {
        err(`error: --max-prs requires 1–${REBASE_PLAN_MAX_JOB_MEMBERS}, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      maxPrs = Number(value);
      continue;
    }
    err(`error: invalid fleet rebase-plan argument: ${arg}\n${USAGE}\n`);
    return 2;
  }
  const format = emit ?? (json ? 'json' : 'human');

  const now = deps.now ?? (() => new Date());
  const rootDir = defaultSnapshotRoot(root);
  const read = await readPrSnapshot(inputPath, {
    stdin: deps.stdin, stdinIsTty: deps.stdinIsTty, readText: deps.readText, root: rootDir,
  });

  if (!read.ok) {
    const report = failedPlan(repo, now(), { source: null, path: null, state: read.state }, read.detail);
    if (format === 'json') out(JSON.stringify(report) + '\n');
    else err(`fleet rebase-plan: ${read.detail}\n`);
    return 1;
  }

  const snapshotJson = parseSnapshotJson(read);
  if (!snapshotJson.ok) {
    const report = failedPlan(repo, now(), { source: read.source, path: read.path, state: 'malformed' }, 'input is not JSON');
    if (format === 'json') out(JSON.stringify(report) + '\n');
    else err(`fleet rebase-plan: ${snapshotJson.detail}\n`);
    return 1;
  }

  const parsed = parseMergeBatchPrs(snapshotJson.value);
  if (!parsed.ok) {
    const report = failedPlan(repo, now(), { source: read.source, path: read.path, state: 'malformed' }, parsed.reason);
    if (format === 'json') out(JSON.stringify(report) + '\n');
    else err(`fleet rebase-plan: ${parsed.reason}\n`);
    return 1;
  }

  const resolvedRepo = parsed.repo ?? repo;
  const readText = deps.readText ?? (async (path: string) => readFile(path, 'utf8'));
  const queue = queueDir ?? join(rootDir, 'queue');
  let existing: RebasePlanExistingJob[] | undefined;
  let existingState: 'ok' | 'missing' | 'degraded' | undefined;
  if (coverage) {
    const covered = await readCoverage(queue, readText);
    existing = covered.jobs;
    existingState = covered.state;
  }

  let hold: Set<string> | undefined;
  let holdSource: 'ok' | 'missing' = 'missing';
  const holdPath = holdFile ?? join(queue, 'hold-list.txt');
  try {
    hold = parseHoldList(await readText(holdPath));
    holdSource = 'ok';
  } catch {
    holdSource = 'missing';
  }

  let plan: RebasePlan;
  try {
    plan = planRebaseJobs({
      prs: parsed.prs,
      repo: resolvedRepo,
      unreadable: parsed.unreadable,
      duplicates: parsed.duplicates,
      now: now(),
      pool, tier, priority,
      ...(maxPrs === null ? {} : { maxPrs }),
      deferBehindClean,
      existing, existingState, hold,
    });
  } catch (error) {
    err(`error: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }

  const report = {
    ...plan,
    input: { kind: parsed.kind, source: read.source, path: read.path, state: 'ok', upstream: parsed.upstream },
    sources: { queue: existingState ?? 'skipped', hold: holdSource },
  };
  const upstreamBad = parsed.upstream !== 'ok' && parsed.upstream !== 'healthy';

  if (format === 'json') {
    out(JSON.stringify(report) + '\n');
    return upstreamBad ? 1 : 0;
  }
  if (format === 'lines') {
    for (const job of plan.jobs) out(job.line + '\n');
    return upstreamBad ? 1 : 0;
  }
  if (format === 'rows') {
    if (plan.jobs.some(job => job.pool === 'any')) {
      err("note: rows carry pool 'any', which restock's row check refuses — pass --pool <lane> for direct ready.tsv materialization\n");
    }
    for (const job of plan.jobs) out(renderReadyRow(job, queue) + '\n');
    return upstreamBad ? 1 : 0;
  }

  const { counts } = report;
  out(`rebase-plan${report.repo ? ` ${report.repo}` : ''}: ${counts.open} open → ${counts.conflicting} conflicting bridge PRs → `
    + `${counts.jobs} job(s) (${counts.clusters} cluster, ${counts.singles} single${counts.chained ? `, ${counts.chained} chained` : ''})`
    + `${counts.covered ? `; ${counts.covered} already queued` : ''}${counts.held ? `; ${counts.held} held` : ''}${counts.superseded ? `; ${counts.superseded} superseded by rework` : ''}${counts.exhausted ? `; ${counts.exhausted} refused (one rebase attempt each)` : ''}${counts.deferred ? `; ${counts.deferred} deferred behind clean PRs` : ''}${counts.pinned ? `; ${counts.pinned} pinned` : ''}\n`);
  if (upstreamBad) out(`  snapshot upstream read is '${parsed.upstream}' — items may be incomplete\n`);
  if (resolvedRepo === null) out('  repo unknown — pass --repo so queue coverage and the hold list can attribute rows\n');
  if (existingState === 'missing') out('  queue coverage not read (no router-queue.md/ready.tsv) — specs may duplicate live jobs\n');
  if (holdSource === 'missing') out('  no hold-list.txt — held PRs not filtered\n');
  for (const refusal of plan.exhausted) {
    out(`  refused #${refusal.number}: ${refusal.reason === 'is-rebase'
      ? 'is itself a rebase PR that conflicts again; close it or recut the origin'
      : `already rebased by #${refusal.via}; fix or close that PR, do not rebase again`}\n`);
  }
  for (const job of plan.jobs) {
    const label = job.kind === 'single' ? `single #${job.prs[0]}` : `${job.kind === 'cluster' ? 'cluster' : 'chunk'} ×${job.prs.length} ${job.prs.map(n => `#${n}`).join(',')}`;
    out(`  ${job.id} — ${label}${job.after.length ? ` after ${job.after.join(',')}` : ''}${job.pinned ? ' [Security pin required]' : ''}${job.evidence === 'no-file-data' ? ' (no file data)' : ''}\n`);
  }
  return upstreamBad ? 1 : 0;
}
