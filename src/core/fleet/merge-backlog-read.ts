/**
 * core/fleet/merge-backlog-read.ts — one bounded, read-only snapshot of a
 * repo's open-PR merge backlog, shaped for the desktop console's Merges pane.
 *
 * One `gh pr list --json` read describes every open PR; each row is validated
 * by parseFleetPrGhState and joined with its local fleet merge-state record
 * (when one exists) so head-moved and terminal records classify honestly.
 * planMergeBacklog then produces the same advisory classification the CLI's
 * `ashlr fleet backlog` prints — merge now, recut, or refresh the base —
 * reduced here to one `suggestedAction` per PR.
 *
 * READ-ONLY: the only gh call is `pr list`. This module never closes, updates
 * or merges a pull request, and never reads a PR body — titles and refs are
 * bounded text fields only. A failed gh read is reported (`source:
 * 'gh-failed'`), never disguised as a healthy empty backlog.
 *
 * NOTE (bridge): the `gh pr list` read and the PR-number → merge-state join
 * are deliberately duplicated from src/cli/fleet-backlog.ts — that file is
 * owned by another job and stays untouched. Both call sites share
 * FLEET_PR_GH_VIEW_FIELDS, parseFleetPrGhState and planMergeBacklog, so the
 * answers cannot drift.
 */

import { tmpdir } from 'node:os';

import { defaultGitRunner } from '../verse/git-ops.js';
import type { CloudGh } from '../cloud/pr-actions.js';
import {
  FLEET_PR_GH_VIEW_FIELDS,
  listFleetMergeStateKeys,
  parseFleetPrGhState,
  readFleetMergeState,
  type FleetMergeStateRead,
  type FleetPrClassification,
} from './fleet-merge-state.js';
import { planMergeBacklog, type MergeBacklogItem } from './merge-backlog-plan.js';

/** The console view needs the title and update time on top of the planner's fields. */
const MERGE_BACKLOG_GH_FIELDS = `${FLEET_PR_GH_VIEW_FIELDS},title,updatedAt`;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const GH_LIST_TIMEOUT_MS = 20_000;
const GH_LIST_MAX_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 200;
const MAX_UPDATED_AT_CHARS = 40;
/** A fleet job id such as RQ-PHX-ABC31, taken from the PR title or head ref. */
const JOB_RE = /RQ-PHX-[A-Z0-9]+/;

/** Production gh: argv only, bounded, never prompts (git-ops' runner and env). */
const defaultGh: CloudGh = async (args) => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: GH_LIST_TIMEOUT_MS, maxStdoutBytes: GH_LIST_MAX_BYTES,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

/** What the console should do next with one PR, reduced from the planner's lanes. */
export type MergeBacklogAction = 'merge' | 'recut' | 'refresh' | 'wait' | 'none';

export interface MergeBacklogReadItem {
  number: number;
  title: string;
  headRef: string;
  updatedAt: string | null;
  /** GitHub's single merge state: CLEAN, BEHIND, BLOCKED, DIRTY, DRAFT, HAS_HOOKS, UNSTABLE or UNKNOWN. */
  mergeStateStatus: string;
  isDraft: boolean;
  /** The fleet job id parsed from the title or head ref (`RQ-PHX-*`), or null. */
  job: string | null;
  /** The planner's class for this PR (`green-ready`, `conflicted`, …) and its reason. */
  classification: FleetPrClassification;
  suggestedAction: MergeBacklogAction;
}

export interface MergeBacklogReadV1 {
  v: 1;
  /** Canonical owner/name this read describes. */
  repo: string;
  generatedAt: string;
  source: 'ok' | 'gh-failed';
  /** Fixed machine token when source is 'gh-failed'; never gh's stderr. */
  reason?: string;
  items: MergeBacklogReadItem[];
  counts: {
    /** Per mergeStateStatus — e.g. { DIRTY: 1, BLOCKED: 1, CLEAN: 1 }. */
    mergeState: Record<string, number>;
    actions: Record<MergeBacklogAction, number>;
  };
}

export interface MergeBacklogReadInput {
  /** Canonical owner/name; `gh pr list --repo` target. */
  repo: string;
  /** Injected gh reader; defaults to the bounded production runner above. */
  gh?: CloudGh;
  /** Injected merge-state join; defaults to the local record store. */
  states?: (repo: string) => ReadonlyMap<number, FleetMergeStateRead>;
  /** Open-PR page size for the gh read (clamped to 1..500). */
  limit?: number;
  now?: () => Date;
}

const emptyActions = (): Record<MergeBacklogAction, number> =>
  ({ merge: 0, recut: 0, refresh: 0, wait: 0, none: 0 });

function boundText(value: unknown, max = MAX_TEXT_CHARS): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function jobOf(title: string, headRef: string): string | null {
  return JOB_RE.exec(title)?.[0] ?? JOB_RE.exec(headRef)?.[0] ?? null;
}

/**
 * PR number → merge-state read for one repo, from the local records under
 * ~/.ashlr/authority/fleet-merge. Same join fleet-backlog.ts makes: a corrupt
 * record cannot name its PR, so it simply never joins.
 */
export function readMergeBacklogStates(repo: string): ReadonlyMap<number, FleetMergeStateRead> {
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

/** The only GitHub call this module makes. */
async function listOpenPrs(
  repo: string,
  limit: number,
  gh: CloudGh,
): Promise<{ ok: true; rows: unknown[] } | { ok: false; reason: string }> {
  const result = await gh([
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', MERGE_BACKLOG_GH_FIELDS,
  ]);
  if (!result.ok) return { ok: false, reason: 'gh-pr-list-failed' };
  try {
    const rows: unknown = JSON.parse(result.stdout);
    return Array.isArray(rows) ? { ok: true, rows } : { ok: false, reason: 'gh-pr-list-not-an-array' };
  } catch {
    return { ok: false, reason: 'gh-pr-list-not-json' };
  }
}

/**
 * The lane a classified entry lands in decides the suggested action: merges →
 * merge now, recuts → recut on the current base, refreshes → refresh the base
 * and re-verify. Everything deferred is advisory "wait" while it could still
 * resolve itself (pending checks, a moved head, a failed required check the
 * fleet is already re-producing) and "none" when no action exists — closed,
 * or a row GitHub could not describe.
 */
function actionFor(classification: FleetPrClassification): MergeBacklogAction {
  switch (classification.class) {
    case 'green-ready': return 'merge';
    case 'conflicted': return 'recut';
    case 'behind': return 'refresh';
    case 'closed':
    case 'unknown': return 'none';
    default: return 'wait';
  }
}

/**
 * Read one repo's open-PR merge backlog. Never throws a gh failure into the
 * caller: an unavailable gh produces `{ source: 'gh-failed', items: [] }` so
 * the console can say so instead of seeing a fake empty backlog.
 */
export async function readMergeBacklog(input: MergeBacklogReadInput): Promise<MergeBacklogReadV1> {
  const { repo } = input;
  const now = input.now ?? (() => new Date());
  const limit = Number.isSafeInteger(input.limit)
    ? Math.min(Math.max(input.limit as number, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const generatedAt = now().toISOString();

  const read = await listOpenPrs(repo, limit, input.gh ?? defaultGh);
  if (!read.ok) {
    return {
      v: 1, repo, generatedAt, source: 'gh-failed', reason: read.reason,
      items: [], counts: { mergeState: {}, actions: emptyActions() },
    };
  }

  const states = (input.states ?? readMergeBacklogStates)(repo);
  const missing: FleetMergeStateRead = { state: 'missing' };
  const kept: { raw: Record<string, unknown>; item: MergeBacklogItem }[] = [];
  for (const raw of read.rows) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const github = parseFleetPrGhState(row);
    const number = github?.number ?? row['number'];
    if (!Number.isSafeInteger(number) || (number as number) < 1) continue;
    kept.push({ raw: row, item: { repo, mergeState: (github && states.get(github.number)) || missing, github } });
  }

  const planned = planMergeBacklog(
    kept.map(({ item }) => item),
    { merges: Number.MAX_SAFE_INTEGER, recuts: Number.MAX_SAFE_INTEGER },
  );
  // Each entry keeps the same `github` object the row was parsed into, so the
  // classification joins back by reference — not by number, which duplicate
  // observations would make ambiguous. Rows gh could not describe share one
  // outcome: a lone one is `unknown/github-view-unreadable`, several are the
  // planner's `duplicate-pr-observation`.
  const outcomeByGh = new Map<NonNullable<MergeBacklogItem['github']>, { classification: FleetPrClassification; action: MergeBacklogAction }>();
  let unreadableOutcome: { classification: FleetPrClassification; action: MergeBacklogAction } | null = null;
  for (const entry of [...planned.merges, ...planned.recuts, ...planned.refreshes, ...planned.deferred]) {
    const outcome = { classification: entry.classification, action: actionFor(entry.classification) };
    if (entry.github !== null) outcomeByGh.set(entry.github, outcome);
    else unreadableOutcome ??= outcome;
  }
  const fallbackOutcome = {
    classification: { class: 'unknown', work: 'none', reason: 'github-view-unreadable' } as FleetPrClassification,
    action: 'none' as const,
  };

  const counts: MergeBacklogReadV1['counts'] = { mergeState: {}, actions: emptyActions() };
  const items: MergeBacklogReadItem[] = [];
  for (const { raw, item } of kept) {
    const title = boundText(raw['title']);
    const headRef = boundText(item.github?.headRef ?? raw['headRefName']);
    const updatedAtRaw = raw['updatedAt'];
    const updatedAt = typeof updatedAtRaw === 'string' &&
      updatedAtRaw.length <= MAX_UPDATED_AT_CHARS && Number.isFinite(Date.parse(updatedAtRaw))
      ? updatedAtRaw
      : null;
    const mergeStateStatus = (item.github?.mergeStateStatus ??
      boundText(raw['mergeStateStatus'], 40).toUpperCase()) || 'UNKNOWN';
    const outcome = (item.github !== null ? outcomeByGh.get(item.github) : unreadableOutcome) ?? fallbackOutcome;
    counts.mergeState[mergeStateStatus] = (counts.mergeState[mergeStateStatus] ?? 0) + 1;
    counts.actions[outcome.action] += 1;
    items.push({
      number: (item.github?.number ?? raw['number']) as number,
      title,
      headRef,
      updatedAt,
      mergeStateStatus,
      isDraft: item.github?.isDraft ?? raw['isDraft'] === true,
      job: jobOf(title, headRef),
      classification: outcome.classification,
      suggestedAction: outcome.action,
    });
  }

  return { v: 1, repo, generatedAt, source: 'ok', items, counts };
}
