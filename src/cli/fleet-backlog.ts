/**
 * `ashlr fleet backlog` — read-only triage of the open-PR merge backlog.
 *
 * One `gh pr list --json` read describes every open PR in a repo; each row is
 * validated by parseFleetPrGhState and joined with its local fleet merge-state
 * record (when one exists) so head-moved and terminal records classify
 * honestly. The joined items feed planMergeBacklog and the plan prints as
 * JSON plus a short text summary by category.
 *
 * READ-ONLY: the only gh call is `pr list`. This command never closes,
 * updates or merges a pull request. A failed gh read exits nonzero with a
 * clear message — it never prints an empty plan that looks healthy.
 *
 * Exit codes: 0 success, 1 gh read failure, 2 bad usage.
 */

import { tmpdir } from 'node:os';

import { defaultGitRunner } from '../core/verse/git-ops.js';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import {
  FLEET_PR_GH_VIEW_FIELDS,
  listFleetMergeStateKeys,
  parseFleetPrGhState,
  readFleetMergeState,
  type FleetMergeStateRead,
  type FleetPrGhState,
} from '../core/fleet/fleet-merge-state.js';
import { planMergeBacklog, type MergeBacklogEntry, type MergeBacklogItem } from '../core/fleet/merge-backlog-plan.js';
import { renderBacklogRecutJob } from '../core/fleet/backlog-recut-job.js';
import { makeColors, isTty } from './ui.js';

const { bold, dim, red } = makeColors(isTty());

export const FLEET_BACKLOG_USAGE =
  'ashlr fleet backlog [--repo <owner/name>] [--limit <n>] [--pr <n>]... [--merges <n>] [--recuts <n>] [--json] [--recut-job <n> [--exclude-pr <n>]...]';

/** The fleet workbench's own backlog when --repo is not given. */
const DEFAULT_REPO = 'ashlrai/phantom';
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10_000;
/** A rollup for a few hundred PRs is heavier than the tracker's 2 MB view reads. */
const GH_LIST_MAX_BYTES = 16 * 1024 * 1024;
const GH_LIST_TIMEOUT_MS = 60_000;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Production gh: argv only, bounded, never prompts (git-ops' runner and env). */
const defaultGh: CloudGh = async (args) => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: GH_LIST_TIMEOUT_MS, maxStdoutBytes: GH_LIST_MAX_BYTES,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

/**
 * PR number → merge-state read for one repo, from the local records under
 * ~/.ashlr/authority/fleet-merge. A corrupt record cannot name its PR, so it
 * simply never joins; the PR then classifies on the gh view alone.
 */
export function readFleetBacklogStates(repo: string): ReadonlyMap<number, FleetMergeStateRead> {
  const wanted = repo.toLowerCase();
  const states = new Map<number, FleetMergeStateRead>();
  for (const key of listFleetMergeStateKeys() ?? []) {
    const read = readFleetMergeState(key);
    if (read.state === 'ok' && read.record.repo.toLowerCase() === wanted && read.record.pr !== null) {
      states.set(read.record.pr.number, read);
    }
  }
  return states;
}

export interface FleetBacklogDeps {
  /** Injected gh reader; defaults to the bounded production runner above. */
  gh?: CloudGh;
  /** Injected merge-state join; defaults to the local record store. */
  states?: (repo: string) => ReadonlyMap<number, FleetMergeStateRead>;
  now?: () => Date;
}

type GhRead = { ok: true; rows: unknown[] } | { ok: false; reason: string };

/** The only GitHub call this command makes. */
async function readOpenPrs(repo: string, limit: number, gh: CloudGh, includeTitle = false): Promise<GhRead> {
  const result = await gh([
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', FLEET_PR_GH_VIEW_FIELDS + (includeTitle ? ',title' : ''),
  ]);
  if (!result.ok) {
    const detail = result.stderr.split('\n').map((line) => line.trim()).find(Boolean);
    return { ok: false, reason: `gh pr list failed${detail ? ` (${detail.slice(0, 200)})` : ''}` };
  }
  try {
    const rows: unknown = JSON.parse(result.stdout);
    return Array.isArray(rows) ? { ok: true, rows } : { ok: false, reason: 'gh pr list did not return a JSON array' };
  } catch {
    return { ok: false, reason: 'gh pr list output was not JSON' };
  }
}

/** The serialized entry: the classification and its evidence, never the record's internals. */
function entryJson(entry: MergeBacklogEntry): Record<string, unknown> {
  return {
    repo: entry.repo,
    number: entry.github?.number ?? null,
    github: entry.github,
    record: entry.mergeState.state,
    classification: entry.classification,
  };
}

function laneRefs(entries: readonly MergeBacklogEntry[], max = 12): string {
  if (entries.length === 0) return '—';
  const refs = entries.slice(0, max).map((entry) => {
    const number = entry.github?.number;
    return `${number === undefined ? '?' : `#${number}`} ${dim(`(${entry.classification.reason})`)}`;
  });
  return refs.join(', ') + (entries.length > max ? dim(` … +${entries.length - max} more`) : '');
}

const nonNegativeInt = (raw: string | undefined): number | null => {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
};

export async function cmdFleetBacklog(args: string[], deps: FleetBacklogDeps = {}): Promise<number> {
  const seen = new Set<string>();
  let repo = DEFAULT_REPO;
  let limit = DEFAULT_LIMIT;
  const requested = new Set<number>();
  const excluded = new Set<number>();
  let recutJob: number | undefined;
  // Unbounded defaults: the report classifies the whole page instead of
  // pretending a dispatch pass's lane sizes. --merges/--recuts shape one.
  let merges = Number.MAX_SAFE_INTEGER;
  let recuts = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seen.has(arg)) {
      seen.add(arg);
    } else if (arg === '--repo' && !seen.has(arg)) {
      const value = args[++i];
      if (!REPO_RE.test(value ?? '')) {
        process.stderr.write(red('error: ') + `--repo requires <owner/name>, got: ${value ?? '(missing)'}\nusage: ${FLEET_BACKLOG_USAGE}\n`);
        return 2;
      }
      repo = value!;
      seen.add(arg);
    } else if (arg === '--limit' && !seen.has(arg)) {
      const n = nonNegativeInt(args[i + 1]);
      if (n === null || n < 1 || n > MAX_LIMIT) {
        process.stderr.write(red('error: ') + `--limit requires an integer 1..${MAX_LIMIT}, got: ${args[i + 1] ?? '(missing)'}\nusage: ${FLEET_BACKLOG_USAGE}\n`);
        return 2;
      }
      limit = n;
      i++;
      seen.add(arg);
    } else if (arg === '--pr' || arg === '--exclude-pr' || (arg === '--recut-job' && !seen.has(arg))) {
      const n = nonNegativeInt(args[i + 1]);
      if (n === null || n < 1) {
        process.stderr.write(red('error: ') + `${arg} requires a positive safe integer, got: ${args[i + 1] ?? '(missing)'}\nusage: ${FLEET_BACKLOG_USAGE}\n`);
        return 2;
      }
      if (arg === '--pr') requested.add(n);
      else if (arg === '--exclude-pr') excluded.add(n);
      else { recutJob = n; seen.add(arg); }
      i++;
    } else if ((arg === '--merges' || arg === '--recuts') && !seen.has(arg)) {
      const n = nonNegativeInt(args[i + 1]);
      if (n === null) {
        process.stderr.write(red('error: ') + `${arg} requires a nonnegative integer, got: ${args[i + 1] ?? '(missing)'}\nusage: ${FLEET_BACKLOG_USAGE}\n`);
        return 2;
      }
      if (arg === '--merges') merges = n; else recuts = n;
      i++;
      seen.add(arg);
    } else {
      process.stderr.write(red('error: ') + `invalid fleet backlog argument: ${arg}\nusage: ${FLEET_BACKLOG_USAGE}\n`);
      return 2;
    }
  }

  if ((recutJob === undefined && excluded.size > 0) || (recutJob !== undefined &&
      (requested.size > 0 || seen.has('--json') || seen.has('--merges') || seen.has('--recuts')))) {
    process.stderr.write(red('error: ') + `--recut-job cannot be combined with selection, lane, or JSON options; --exclude-pr requires --recut-job\nusage: ${FLEET_BACKLOG_USAGE}\n`);
    return 2;
  }
  if (recutJob !== undefined && repo.toLowerCase() !== DEFAULT_REPO) {
    process.stderr.write(red('error: ') + 'recut jobs support only ashlrai/phantom\n');
    return 2;
  }

  const gh = deps.gh ?? defaultGh;
  const read = await readOpenPrs(repo, limit, gh, recutJob !== undefined);
  if (!read.ok) {
    process.stderr.write(red('error: ') + `fleet backlog: could not read open PRs for ${repo} — ${read.reason}\n`);
    return 1;
  }

  const states = (deps.states ?? readFleetBacklogStates)(repo);
  const missing: FleetMergeStateRead = { state: 'missing' };
  const items: MergeBacklogItem[] = read.rows.map((raw) => {
    const github: FleetPrGhState | null = parseFleetPrGhState(raw);
    return { repo, mergeState: (github && states.get(github.number)) || missing, github };
  });
  const tracked = items.filter((item) => item.mergeState.state === 'ok').length;
  const unreadable = items.filter((item) => item.github === null).length;
  const complete = read.rows.length < limit;
  if (recutJob !== undefined) {
    const matches = items.filter((item) => item.github?.number === recutJob);
    const plan = planMergeBacklog(matches, { merges: 0, recuts: 1 });
    const entry = plan.recuts[0];
    const index = items.indexOf(matches[0]!);
    const raw = read.rows[index];
    const title = raw !== null && typeof raw === 'object' && 'title' in raw ? raw.title : undefined;
    if (excluded.has(recutJob) || !complete || unreadable > 0 || matches.length !== 1 || !entry?.github ||
        entry.github.baseRef !== 'master' || (entry.mergeState.state === 'ok' && entry.mergeState.record.pr?.ownerLane) ||
        typeof title !== 'string') {
      process.stderr.write(red('error: ') + 'recut job refused: excluded, incomplete, ambiguous, unsupported, or not an observed eligible conflict\n');
      return 1;
    }
    console.log(renderBacklogRecutJob(entry.github.number, entry.github.headSha, title));
    return 0;
  }
  // A malformed observation with a recognizable number makes that identity
  // ambiguous, even if another row for the same PR parsed successfully.
  const ambiguous = new Set<number>();
  if (requested.size > 0) {
    read.rows.forEach((raw, index) => {
      if (items[index]!.github === null && raw !== null && typeof raw === 'object' && 'number' in raw &&
          typeof raw.number === 'number' && requested.has(raw.number)) ambiguous.add(raw.number);
    });
  }
  const selected = requested.size === 0 ? items : items.filter((item) =>
    item.github !== null && requested.has(item.github.number) && !ambiguous.has(item.github.number));
  const found = new Set(selected.flatMap((item) => item.github ? [item.github.number] : []));
  const selection = requested.size === 0 ? undefined : {
    requested: [...requested],
    found: [...requested].filter((number) => found.has(number)),
    missing: [...requested].filter((number) => !found.has(number)),
    complete: [...requested].every((number) => found.has(number)) && unreadable === 0,
  };
  const plan = planMergeBacklog(selected, { merges, recuts });

  if (seen.has('--json')) {
    console.log(JSON.stringify({
      v: 1,
      repo,
      generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
      open: read.rows.length,
      complete,
      ...(selection ? { selection } : {}),
      tracked,
      unreadable,
      counts: plan.counts,
      plan: {
        merges: plan.merges.map(entryJson),
        recuts: plan.recuts.map(entryJson),
        refreshes: plan.refreshes.map(entryJson),
        deferred: plan.deferred.map(entryJson),
      },
    }));
    return 0;
  }

  const c = plan.counts;
  console.log(bold(`Fleet backlog (${repo}): `) + `${read.rows.length} open PR(s)` +
    (complete ? '' : ` — page limit ${limit} reached, more may exist`) +
    `, ${tracked} tracked by merge-state records` +
    (unreadable > 0 ? `, ${unreadable} row(s) gh could not describe` : ''));
  if (selection) {
    const refs = (numbers: number[]) => numbers.length ? numbers.map((number) => `#${number}`).join(', ') : '—';
    console.log(`  selection ${selection.complete ? 'complete' : 'incomplete'}: requested ${refs(selection.requested)}; ` +
      `found ${refs(selection.found)}; missing from fetched page ${refs(selection.missing)}`);
    if (unreadable > 0) console.log('  selection may be affected by unreadable page rows');
  }
  console.log(`  ${c.ready} ready, ${c.behind} behind, ${c.conflicting} conflicting, ${c.repair} repair, ${c.waiting} waiting`);
  console.log(`  ${dim('merges (green-ready):')}    ${laneRefs(plan.merges)}`);
  console.log(`  ${dim('recuts (refix):')}        ${laneRefs(plan.recuts)}`);
  console.log(`  ${dim('refreshes (re-base):')}  ${laneRefs(plan.refreshes)}`);
  console.log(`  ${dim('deferred:')}            ${laneRefs(plan.deferred)}`);
  return 0;
}
