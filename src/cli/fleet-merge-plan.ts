/**
 * `phm fleet merge-plan` — READ-ONLY merge-throughput scoreboard and drain
 * plan for the PR backlog (RQ-MERGE-THROUGHPUT-1).
 *
 * One `gh pr list --state all` page answers what the merge treadmill asks
 * today: backlog size and age, merges and closes per hour, time-to-merge,
 * the ranked reasons open PRs are not landing (conflicts, behind, blocked,
 * failing checks by name), the update-branch rebase candidates, the
 * merge-batch summary, and the open-vs-open superseded duplicates — an open
 * PR a newer open rework already replaces, each with a one-line close reason
 * naming the replacement. With merged rows and the queue's job prompts it
 * also counts the superseded-close set `phm fleet superseded-close` owns.
 * `--previous <report.json>` diffs two reports for before/after deltas.
 *
 * INPUT, never gh: the snapshot comes from `--input <file>` (`-` or a piped
 * stdin for a pipe), a non-TTY standard input, or the state file
 * `<root>/fleet/open-prs.json` (`--root` / ASHLR_RUNS_DIR, default
 * ~/.ashlr-runs). Accepted shapes: a raw `gh pr list` JSON array (add the
 * `state`, `mergedAt`, `closedAt`, `mergeStateStatus`, `mergeable`,
 * `statusCheckRollup`, `autoMergeRequest` and `body` columns for every
 * section), a merge-backlog read ({v:1, items}) or a fleet.pr-hygiene.v1
 * report — envelopes describe open PRs only, so throughput and body-based
 * sections stay unknown for them.
 *
 * Read-only: writes nothing, grants no merge, rebase or close authority.
 * Exit 0 report produced (findings are data), 1 no usable snapshot (missing,
 * unreadable, malformed — the JSON report still says so under `input.state`
 * — or a failed upstream read), 2 bad usage.
 */
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { looksLikeOption } from './args.js';
import { defaultSnapshotRoot, parseSnapshotJson, readPrSnapshot } from './fleet-pr-snapshot.js';
import { planMergeBatches } from '../core/fleet/merge-batch.js';
import {
  MERGE_PLAN_SCHEMA,
  diffMergePlans,
  parseMergePlanPrs,
  planMergePlan,
  type MergePlanReport,
} from '../core/fleet/merge-plan.js';
import { planSupersededClose } from '../core/fleet/superseded-close.js';
import type { MergedFleetPr, OpenFleetPr } from '../core/fleet/superseded-prs.js';

const USAGE = `Usage: phm fleet merge-plan [--input <file>|-] [--repo <owner/name>] [--root <abs>]
  [--hours <n>] [--top <n>] [--previous <report.json>] [--prompts-dir <abs>] [--json]
Scoreboard and drain plan for the PR backlog from one gh pr list snapshot:
open count, state and age, merges/closes per hour, time-to-merge, ranked
failure causes, rebase candidates, the merge-batch summary, and open-vs-open
superseded duplicates with a close reason naming the replacement. Input is a
gh pr list array, a merge-backlog read or a fleet.pr-hygiene.v1 report via
--input, piped stdin, or <root>/fleet/open-prs.json. --previous diffs against
an earlier report. Read-only: never calls gh, never writes. Exit 1 when no
usable snapshot is found.`;

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_PROMPT_FILES = 2_000;

export interface FleetMergePlanDeps {
  stdin?: Readable;
  stdinIsTty?: boolean;
  readText?: (path: string) => Promise<string>;
  /** Prompt directory reader; defaults to `<root>/queue/prompts/*.md`. */
  prompts?: () => Promise<ReadonlyMap<string, string> | null>;
  root?: string;
  now?: () => Date;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

const defaultReadText = async (path: string): Promise<string> => readFile(path, 'utf8');

/** Merged-job prompts (`RQ-*.md` in <root>/queue/prompts); null when unreadable. */
function promptsReader(directory: string, readText: (path: string) => Promise<string>): () => Promise<ReadonlyMap<string, string> | null> {
  return async () => {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const prompts = new Map<string, string>();
      for (const entry of entries.slice(0, MAX_PROMPT_FILES)) {
        const match = /^(RQ-[A-Za-z0-9_-]+)\.md$/.exec(entry.name);
        if (!match || !entry.isFile()) continue;
        const text = await readText(join(directory, entry.name));
        prompts.set(match[1]!, text.slice(0, MAX_PROMPT_BYTES));
      }
      return prompts;
    } catch {
      return null;
    }
  };
}

function failedReport(repo: string | null, now: Date, input: Record<string, unknown>, error: string): MergePlanReport & { input: Record<string, unknown>; error: string } {
  return {
    schema: MERGE_PLAN_SCHEMA, v: 1, repo, generatedAt: now.toISOString(),
    window_hours: 24,
    counts: { rows: 0, open: 0, merged_rows: 0, closed_rows: 0, drafts: 0, unreadable: 0, duplicate_rows: 0 },
    throughput: null,
    open: { states: {}, states_evidence: 'unknown', age_hours: null, oldest: [] },
    failure_causes: [], checks_failing: [],
    duplicates: { state: 'no-body-evidence', edges: 0, families: 0, closed_origin_refs: 0, proposals: [], truncated: 0 },
    actions: {
      rebase_candidates: { state: 'unknown', count: 0, prs: [] },
      batch_plan: null,
      superseded_open: 0,
      superseded_merged: { state: 'no-merged-rows', count: 0, prs: [] },
    },
    input, error,
  };
}

export async function cmdFleetMergePlan(args: string[], deps: FleetMergePlanDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { out(USAGE + '\n'); return 0; }

  let inputPath: string | null = null;
  let repo: string | null = null;
  let json = false;
  let hours = 24;
  let top = 10;
  let previousPath: string | null = null;
  let promptsDir: string | null = null;
  let root = deps.root;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
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
    if (arg === '--hours') {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > 24 * 30) {
        err(`error: --hours requires 1-${24 * 30}, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      hours = Number(value);
      continue;
    }
    if (arg === '--top') {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > 50) {
        err(`error: --top requires 1-50, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      top = Number(value);
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
    if (arg === '--previous') { const v = absolute('--previous'); if (v === null) return 2; previousPath = v; continue; }
    if (arg === '--prompts-dir') { const v = absolute('--prompts-dir'); if (v === null) return 2; promptsDir = v; continue; }
    err(`error: invalid fleet merge-plan argument: ${arg}\n${USAGE}\n`);
    return 2;
  }

  const now = deps.now ?? (() => new Date());
  const rootDir = defaultSnapshotRoot(root);
  const readText = deps.readText ?? defaultReadText;
  const read = await readPrSnapshot(inputPath, {
    stdin: deps.stdin, stdinIsTty: deps.stdinIsTty, readText, root: rootDir,
  });

  if (!read.ok) {
    const report = failedReport(repo, now(), { source: null, path: null, state: read.state }, read.detail);
    if (json) out(JSON.stringify(report) + '\n');
    else err(`fleet merge-plan: ${read.detail}\n`);
    return 1;
  }
  const snapshotJson = parseSnapshotJson(read);
  if (!snapshotJson.ok) {
    const report = failedReport(repo, now(), { source: read.source, path: read.path, state: 'malformed' }, 'input is not JSON');
    if (json) out(JSON.stringify(report) + '\n');
    else err(`fleet merge-plan: ${snapshotJson.detail}\n`);
    return 1;
  }
  const parsed = parseMergePlanPrs(snapshotJson.value);
  if (!parsed.ok) {
    const report = failedReport(repo, now(), { source: read.source, path: read.path, state: 'malformed' }, parsed.reason);
    if (json) out(JSON.stringify(report) + '\n');
    else err(`fleet merge-plan: ${parsed.reason}\n`);
    return 1;
  }

  const resolvedRepo = parsed.repo ?? repo;

  // Superseded-by-merged needs the queue's job prompts; never a silent empty.
  let mergedClose: { prs: number[] } | undefined;
  const open = parsed.prs.filter(pr => pr.state === 'OPEN');
  const merged = parsed.prs.filter(pr => pr.state === 'MERGED');
  if (merged.length > 0) {
    const prompts = await (deps.prompts ?? promptsReader(promptsDir ?? join(rootDir, 'queue', 'prompts'), readText))();
    if (prompts !== null) {
      const rows = planSupersededClose(
        open.map((pr): OpenFleetPr => ({ number: pr.number, title: pr.title, mergeStateStatus: pr.mergeStateStatus })),
        merged.map((pr): MergedFleetPr => ({ number: pr.number, title: pr.title })),
        prompts,
      );
      mergedClose = { prs: rows.map(row => row.number) };
    }
  }

  const report: MergePlanReport & { input: Record<string, unknown>; delta?: unknown } = {
    ...planMergePlan(parsed, { repo: resolvedRepo, hours, top, now: now(), ...(mergedClose === undefined ? {} : { mergedClose }) }),
    input: { kind: parsed.kind, source: read.source, path: read.path, state: 'ok', upstream: parsed.upstream },
  };

  // Batch summary from the same rows — planMergeBatches keeps its own planner.
  const batches = planMergeBatches({ prs: open, repo: resolvedRepo, now: now() });
  report.actions.batch_plan = {
    batches: batches.counts.batches,
    independent: batches.counts.independent,
    serial: batches.counts.serial,
    overlap_edges: batches.counts.overlapEdges,
    expected_rebases: batches.counts.expectedRebases,
  };

  if (previousPath !== null) {
    try {
      report.delta = diffMergePlans(JSON.parse(await readText(previousPath)), report) ?? undefined;
    } catch {
      err(`fleet merge-plan: cannot read previous report ${previousPath}\n`);
      return 1;
    }
  }

  const upstreamBad = parsed.upstream !== 'ok' && parsed.upstream !== 'healthy';
  if (json) {
    out(JSON.stringify(report) + '\n');
    return upstreamBad ? 1 : 0;
  }

  const { counts, throughput } = report;
  out(`merge-plan${report.repo ? ` ${report.repo}` : ''}: ${counts.open} open (${counts.drafts} draft) `
    + `+ ${counts.merged_rows} merged/${counts.closed_rows} closed rows in snapshot\n`);
  if (throughput === null) {
    out('  throughput unknown — no merged/closed rows in the snapshot (use gh pr list --state all)\n');
  } else {
    out(`  ${throughput.merges_in_window} merges / ${throughput.closes_in_window} closes in ${report.window_hours}h `
      + `→ ${throughput.merges_per_hour} merges/h, ${throughput.closes_per_hour} closes/h; `
      + `ttm p50 ${throughput.ttm_minutes?.p50 ?? 'unknown'} min`
      + `${throughput.oldest_merge_observed ? ` (merges back to ${throughput.oldest_merge_observed})` : ''}\n`);
  }
  out(`  open age p50 ${report.open.age_hours?.p50 ?? 'unknown'} h; states: `
    + `${Object.entries(report.open.states).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}\n`);
  for (const cause of report.failure_causes.slice(0, 6)) {
    out(`  cause ${cause.cause}: ${cause.prs} PRs${cause.examples.length ? ` (${cause.examples.map(n => `#${n}`).join(',')})` : ''}\n`);
  }
  for (const check of report.checks_failing.slice(0, 4)) {
    out(`  ${check.cause}: ${check.prs} PRs\n`);
  }
  const { duplicates, actions } = report;
  out(`  duplicates: ${actions.superseded_open} close proposal(s) in ${duplicates.families} rework famil${duplicates.families === 1 ? 'y' : 'ies'}`
    + `${duplicates.state === 'no-body-evidence' ? ' (no body evidence — title grammar only)' : ''}\n`);
  for (const proposal of duplicates.proposals.slice(0, top)) {
    out(`    close #${proposal.number} (${proposal.kind}) — ${proposal.reason}\n`);
  }
  out(`  rebase candidates: ${actions.rebase_candidates.state === 'unknown' ? 'unknown (no merge-state evidence)' : actions.rebase_candidates.count}\n`);
  if (actions.batch_plan) {
    out(`  batch plan: ${actions.batch_plan.batches} batch(es) (${actions.batch_plan.independent} independent, ${actions.batch_plan.serial} serial), `
      + `${actions.batch_plan.expected_rebases} rebase(s) expected — phm fleet merge-batch for the order\n`);
  }
  if (actions.superseded_merged.state !== 'no-merged-rows') {
    out(`  superseded by merged jobs: ${actions.superseded_merged.state === 'no-prompts' ? 'unknown (prompts unreadable)' : `${actions.superseded_merged.count} PRs — phm fleet superseded-close`}\n`);
  }
  if (report.delta) {
    const d = report.delta as Record<string, unknown>;
    out(`  delta vs ${d.previous_generatedAt}: open ${d.open}, merges/h ${d.merges_per_hour}, ttm p50 ${d.ttm_p50_minutes}, superseded-open ${d.superseded_open}\n`);
  }
  return upstreamBad ? 1 : 0;
}
