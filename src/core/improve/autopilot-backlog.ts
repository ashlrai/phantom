/**
 * PR-autopilot outcomes journal recurring adverse evidence → self-improvement
 * backlog items.
 *
 * `phm autopilot <pr> [--all] [--apply] [--watch]` drives Phantom's own pull
 * requests to green: it diagnoses red CI, review feedback and base conflicts,
 * fixes or recuts through an agent fixer, re-verifies and stops with a reason
 * when a failure is not the PR's. Every tick appends one row to
 * `$ASHLR_HOME/autopilot/outcomes.jsonl` (src/core/autopilot/act.ts record()):
 * the repository, pull request number, head SHA, the diagnose plan action,
 * its reason, what the tick did ('planned', 'pushed', 'recut', 'requeued',
 * 'closed', 'rerun', 'refused', 'verify-failed', 'no-change', 'error',
 * 'none'), scrubbed detail lines and the new head. Until now the journal was
 * write-only audit — its only readers were tests asserting the write — so
 * five adverse evidence kinds never became work:
 *
 *  - `stop` plans on a pull request: diagnose.ts concluded a person must
 *    drive it — the push limit reached, one failure signature surviving its
 *    fix attempts, a recut closed without merging or still conflicting, a
 *    merge-base that already failed once, checks red for reasons outside
 *    the PR. Each row is the fleet's own machinery saying "this PR is
 *    stuck"; recurring across days means the self-driving loop is not
 *    landing the work it exists to land.
 *  - `error` results: the tick itself failed — the PR could not be read, a
 *    gh call (close, re-run, recut-PR open) failed, a merge failed without
 *    conflicts, or a recut branch listing failed. Recurring errors mean the
 *    autopilot's own machinery (auth, checkout, GitHub API, act.ts) is
 *    broken, not the PRs.
 *  - `verify-failed` results: the fixer's change (or conflict resolution)
 *    failed the repo's verify plan before push, so nothing landed. Recurring
 *    verify failures mean the fix loop burns fixer runs without converging.
 *  - `refused` results: an action was attempted and a guard stopped it —
 *    the branch moved since observation, the fixer moved HEAD or the index
 *    outside the conflicted files, protected paths in the diff, conflict
 *    markers or unresolved files remain, a verify-after guard tripped, no
 *    fixer configured, or the push was refused. Kill-switch and pause
 *    refusals are deliberate-off state and never count.
 *  - `no-change` results on `fix-ci`/`address-review` plans: for those plans
 *    the only no-change outcome is "the fixer changed nothing" — the fixer
 *    ran and produced an empty diff. Recurring empty fixes mean the fixer
 *    or its brief is not doing the work.
 *
 * autopilotBacklogItems carries the same journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it exactly
 * like the sibling fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched. A
 *    missing journal reads as an empty ledger; an unreadable or non-file
 *    read yields no items rather than folding partial evidence.
 *  - Repo matching is exact owner/name, case-insensitive: every row names
 *    the repository the tick drove (`--repo`, or the checkout's origin), so
 *    evidence recorded against another remote never lands on this one.
 *  - Rows count only under the writer's contract: v:1, a parseable `at`, a
 *    non-empty repo, a positive PR number, a plan inside the diagnose
 *    action vocabulary and a result inside the TickResult vocabulary.
 *    Malformed lines, foreign shapes and out-of-contract rows are skipped,
 *    never guessed.
 *  - Deliberate-off states never emit: `stop` plans whose reason opens with
 *    the kill-switch, pause or not-this-PR prefixes, and `refused` rows
 *    whose detail carries the mid-act kill-switch/pause stop are operator
 *    state, not stuck work.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a cell emits only when its in-window rows reach
 *    AUTOPILOT_MIN_UNITS across AUTOPILOT_MIN_DAYS distinct UTC days — a
 *    single bad tick or a one-day burst stays quiet. The window is
 *    anchored on each row's own `at`, with the sibling feeds' future-skew
 *    allowance.
 *  - Unknown stays unknown: the journal records what each tick did, never
 *    whether the PR later merged; prompts say so and keep the no-change
 *    escape.
 *  - Truncation is stated, never hidden: when the bounded tail cut older
 *    rows, every prompt says the counts are a lower bound.
 *  - Every journal string is untrusted text: reasons are written raw and
 *    details carry check names, authors and branch names, so both are
 *    scrubbed, flattened and capped before they reach a prompt.
 *  - Dedup is downstream: item ids hash the cell + repository (+ pull
 *    request for per-PR cells), never the counts or timestamps, so a
 *    refresh re-derives the same id and appendUserBacklogItems adds only
 *    what is new; a PR that recovers or merges simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; per-PR stop cells are the only unbounded set and the cap bounds them. */
export const AUTOPILOT_BACKLOG_MAX_ITEMS = 8;
const AUTOPILOT_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const AUTOPILOT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the sibling folds tolerate. */
const AUTOPILOT_FUTURE_SKEW_MS = 60_000;
/** In-window rows a cell needs before its outcome counts as recurring. */
export const AUTOPILOT_MIN_UNITS = 3;
/** Distinct UTC days the rows must span — recurring means recorded across days. */
export const AUTOPILOT_MIN_DAYS = 2;
/**
 * Bounded tail for the journal; a row is a few hundred bytes, so 512 KiB
 * retains thousands of ticks — far more than a week of watch-driven rows.
 */
const AUTOPILOT_TAIL_BYTES = 512 * 1024;
/**
 * The journal's path inside the Ashlr home — the writer's own layout:
 * autopilotDir() in src/core/autopilot/act.ts is join(ashlrHome(),
 * 'autopilot') and record() appends 'outcomes.jsonl' inside it.
 */
const AUTOPILOT_JOURNAL_RELATIVE = join('autopilot', 'outcomes.jsonl');
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Distinct stop reasons / refusal details quoted inside one prompt before the rest is summarized. */
const PROMPT_SAMPLES_MAX = 4;
/** Distinct PR numbers quoted inside one repo-cell prompt before the rest is summarized. */
const PROMPT_PRS_MAX = 6;

/** The diagnose plan actions the writer records (Plan['action'] in diagnose.ts). */
const PLAN_ACTIONS = new Set([
  'done', 'stop', 'wait', 'green', 'merge-base', 'recut',
  'close-superseded', 'fix-ci', 'address-review', 'rerun',
]);
/** The TickResult result vocabulary the writer records (act.ts). */
const RESULTS = new Set([
  'planned', 'pushed', 'recut', 'requeued', 'closed', 'rerun',
  'refused', 'verify-failed', 'no-change', 'error', 'none',
]);
/** Plans whose only no-change outcome is "the fixer changed nothing" (act.ts actInWorktree). */
const FIXER_PLANS = new Set(['fix-ci', 'address-review']);
/**
 * `stop` reasons that are deliberate operator state, never stuck work —
 * exact writer prefixes from diagnose.ts plan(): the kill switch, the
 * pause flag, and a PR outside the autopilot's owned prefixes.
 */
const DELIBERATE_STOP_PREFIXES = ['the kill switch', 'Phantom is paused', "not this autopilot's PR"];
/** The mid-act stopNow() detail strings (act.ts): kill switch or pause engaged while acting. */
const DELIBERATE_REFUSAL = /kill switch was engaged|paused while acting/;

type RepoCellKind = 'tick-error' | 'verify-failed' | 'refused' | 'empty-fix';
type CellKind = RepoCellKind | 'needs-person';

export interface AutopilotItemsOptions {
  /** Backlog target in owner/name form; journal rows must name the same repository. */
  repo: string;
  /** Journal override (default: join(ashlrHome(), 'autopilot', 'outcomes.jsonl')). */
  journalPath?: string;
  /** Most items one call emits (default AUTOPILOT_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
  /** Window in ms (default AUTOPILOT_WINDOW_MS). */
  windowMs?: number;
}

/** One validated outcomes-journal row inside the evidence window. */
export interface AutopilotRow {
  atMs: number;
  utcDay: string;
  repo: string;
  number: number;
  plan: string;
  reason: string;
  result: string;
  detail: string[];
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isDeliberateStop = (reason: string): boolean =>
  DELIBERATE_STOP_PREFIXES.some((prefix) => reason.startsWith(prefix));

const isDeliberateRefusal = (detail: readonly string[]): boolean =>
  detail.some((line) => DELIBERATE_REFUSAL.test(line));

/**
 * Pure: parse journal text into validated rows. Malformed lines, foreign
 * shapes, non-v1 records and rows outside the writer's plan/result
 * vocabulary are skipped — never guessed.
 */
export function parseAutopilotJournal(text: string): AutopilotRow[] {
  const rows: AutopilotRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const r = value as Record<string, unknown>;
    if (r['v'] !== 1) continue;
    const at = r['at'];
    const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
    if (!Number.isFinite(atMs)) continue;
    const repo = r['repo'];
    const number = r['number'];
    const plan = r['plan'];
    const result = r['result'];
    if (typeof repo !== 'string' || repo.trim() === '') continue;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) continue;
    if (typeof plan !== 'string' || !PLAN_ACTIONS.has(plan)) continue;
    if (typeof result !== 'string' || !RESULTS.has(result)) continue;
    const reason = r['reason'];
    const detail = r['detail'];
    rows.push({
      atMs,
      utcDay: utcDayOf(atMs),
      repo: repo.trim(),
      number,
      plan,
      reason: typeof reason === 'string' ? reason.trim() : '',
      result,
      detail: Array.isArray(detail) ? detail.filter((d): d is string => typeof d === 'string') : [],
    });
  }
  return rows;
}

/** One pull request's recurring `stop` evidence inside the window. */
interface StopTrack {
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
  /** Recorded stop reason → how often it recurred (deduped, capped). */
  reasons: Map<string, number>;
}

/** One repo-level adverse cell's tallies inside the window. */
interface RepoTally {
  rows: number;
  days: Set<string>;
  prs: Set<number>;
  firstMs: number;
  lastMs: number;
  /** Recorded detail lines → how often each recurred (deduped, capped). */
  samples: Map<string, number>;
}

interface RepoFold {
  /** pull request number → the PR's stop track. */
  stops: Map<number, StopTrack>;
  /** cell kind → its repo-level tally. */
  cells: Record<RepoCellKind, RepoTally>;
}

const newTally = (): RepoTally => ({ rows: 0, days: new Set(), prs: new Set(), firstMs: Infinity, lastMs: -Infinity, samples: new Map() });

const newRepoFold = (): RepoFold => ({
  stops: new Map(),
  cells: { 'tick-error': newTally(), 'verify-failed': newTally(), 'refused': newTally(), 'empty-fix': newTally() },
});

/** Record one detail line against a tally, deduped and capped. */
function tallySample(tally: RepoTally, detail: readonly string[]): void {
  const seen = new Set<string>();
  for (const raw of detail) {
    const line = fieldText(raw);
    if (line === '' || seen.has(line)) continue;
    seen.add(line);
    if (!tally.samples.has(line) && tally.samples.size >= PROMPT_SAMPLES_MAX * 4) continue;
    tally.samples.set(line, (tally.samples.get(line) ?? 0) + 1);
  }
}

/**
 * Pure: fold validated rows for one repository into the per-PR stop tracks
 * and per-repo adverse tallies. Rows outside the window, stamped beyond the
 * future-skew allowance, or naming another repository contribute nothing.
 */
export function foldAutopilotRows(
  rows: readonly AutopilotRow[],
  repo: string,
  nowMs: number,
  windowMs: number = AUTOPILOT_WINDOW_MS,
): RepoFold {
  const fold = newRepoFold();
  const target = repo.toLowerCase();
  const windowStart = nowMs - windowMs;
  const futureLimit = nowMs + AUTOPILOT_FUTURE_SKEW_MS;
  for (const row of rows) {
    if (row.repo.toLowerCase() !== target) continue;
    if (row.atMs < windowStart || row.atMs > futureLimit) continue;
    if (row.plan === 'stop' && !isDeliberateStop(row.reason)) {
      const track = fold.stops.get(row.number) ?? { rows: 0, days: new Set(), firstMs: Infinity, lastMs: -Infinity, reasons: new Map() };
      track.rows += 1;
      track.days.add(row.utcDay);
      track.firstMs = Math.min(track.firstMs, row.atMs);
      track.lastMs = Math.max(track.lastMs, row.atMs);
      const reason = fieldText(row.reason) || '(unrecorded reason)';
      if (track.reasons.has(reason) || track.reasons.size < PROMPT_SAMPLES_MAX * 4) {
        track.reasons.set(reason, (track.reasons.get(reason) ?? 0) + 1);
      }
      fold.stops.set(row.number, track);
      continue;
    }
    let kind: RepoCellKind | null = null;
    if (row.result === 'error') kind = 'tick-error';
    else if (row.result === 'verify-failed') kind = 'verify-failed';
    else if (row.result === 'refused' && !isDeliberateRefusal(row.detail)) kind = 'refused';
    else if (row.result === 'no-change' && FIXER_PLANS.has(row.plan)) kind = 'empty-fix';
    if (kind === null) continue;
    const tally = fold.cells[kind];
    tally.rows += 1;
    tally.days.add(row.utcDay);
    tally.prs.add(row.number);
    tally.firstMs = Math.min(tally.firstMs, row.atMs);
    tally.lastMs = Math.max(tally.lastMs, row.atMs);
    tallySample(tally, row.detail);
  }
  return fold;
}

const WINDOW_DAYS = Math.round(AUTOPILOT_WINDOW_MS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the pull request merged, closed or gone green since, the ticks recovered, or the cause is owner-only (credentials, billing, a protected gate or sandbox profile) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is autopilot/outcomes.jsonl under the Ashlr home (~/.ashlr or $ASHLR_HOME), appended by `phm autopilot` (src/core/autopilot/act.ts record()) on every tick; each row carries the repository, pull request number, head SHA, the diagnose plan action and reason, the recorded result and scrubbed detail lines.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

/** Top recurring samples of a map, deterministically ordered by count then text. */
function topSamples(map: ReadonlyMap<string, number>, max: number): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([text]) => `'${text}'`);
}

function prList(prs: ReadonlySet<number>): string {
  const sorted = [...prs].sort((a, b) => a - b);
  const shown = sorted.slice(0, PROMPT_PRS_MAX).map((n) => `#${n}`);
  const rest = sorted.length > shown.length ? `, and ${sorted.length - shown.length} more` : '';
  return shown.length > 0 ? `${shown.join(', ')}${rest}` : 'none recorded';
}

function needsPersonPrompt(repo: string, number: number, track: StopTrack, truncated: boolean): string {
  const reasons = topSamples(track.reasons, PROMPT_SAMPLES_MAX);
  const rest = track.reasons.size > reasons.length ? `, and ${track.reasons.size - reasons.length} more distinct reason(s)` : '';
  return [
    `Phantom's PR autopilot keeps concluding that a person must drive ${repo}#${number} — the self-improvement work this backlog exists for.`,
    '',
    `Inside the ${WINDOW_DAYS}-day outcomes window the autopilot recorded ${track.rows} 'stop' decision(s) for this pull request across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)} day span).${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `A 'stop' plan means src/core/autopilot/diagnose.ts decided no further automated action is safe or useful; the recorded reasons include ${reasons.join('; ')}${rest}. Deliberate-off stops — the kill switch, the pause flag, or a PR outside the autopilot's owned prefixes — are never counted.`,
    '',
    `What is in scope: find out why the autopilot cannot land this PR and fix the cause. The recorded reasons map to known stops — the push limit reached, one failure signature surviving its fix attempts, a recut closed without merging or still conflicting, a merge-base that already failed once, or checks red for reasons outside the PR. Check the PR's current state first (gh pr view ${number} --repo ${repo}), then fix the underlying cause — the PR's content, the lane machinery, or the autopilot's own limits and guards in src/core/autopilot/ — or land the PR through the normal merge path. If the PR has since merged, closed or gone green — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function repoCellPrompt(kind: RepoCellKind, repo: string, tally: RepoTally, truncated: boolean): string {
  const samples = topSamples(tally.samples, PROMPT_SAMPLES_MAX);
  const sampleText = samples.length > 0 ? ` Sample recorded detail: ${samples.join('; ')}.` : '';
  const span = `${tally.rows} row(s) across ${tally.days.size} distinct UTC day(s) (${daySpan(tally.firstMs, tally.lastMs)} day span), covering ${tally.prs.size} distinct pull request(s): ${prList(tally.prs)}.${truncationNote(truncated)}`;
  switch (kind) {
    case 'tick-error':
      return [
        `Phantom's PR autopilot keeps failing its own ticks on ${repo} — recorded 'error' results mean the machinery broke, not the pull requests.`,
        '',
        `Inside the ${WINDOW_DAYS}-day outcomes window the journal recorded ${span}${sampleText}`,
        '',
        EVIDENCE,
        '',
        `An 'error' result means the tick itself failed before or during acting: the PR could not be read, a gh call failed (closing a superseded PR, re-running a check, opening the recut's PR), a merge failed without conflicts, or a recut branch listing failed. Recurring errors point at the host running \`phm autopilot\`: gh authentication and connectivity, the checkout's fetch/push path, GitHub API errors, or a bug in src/core/autopilot/act.ts. Read the journal's detail strings for the dominant failure, reproduce with \`phm autopilot --json\` on a current PR, and fix the cause. If recent ticks are clean — report no-change and name the evidence. ${NO_CHANGE}`,
      ].join('\n');
    case 'verify-failed':
      return [
        `Phantom's PR autopilot fixer keeps producing work its own verify step rejects on ${repo} — nothing is pushed when verify fails.`,
        '',
        `Inside the ${WINDOW_DAYS}-day outcomes window the journal recorded ${span}${sampleText}`,
        '',
        EVIDENCE,
        '',
        `A 'verify-failed' result means the fixer's change — or its conflict resolution — failed the repo's verify plan before push: the worktree verify in src/core/autopilot/act.ts (the repo's quick verify profile plus vitest related over the changed files) rejected it. Recurring verify failures mean the fix loop burns fixer runs without converging. Find the dominant verify failure in the journal's detail strings, then fix what is in scope: the verify plan or its resolution (verifyPlan in act.ts), the fixer brief (fixBrief in src/core/autopilot/diagnose.ts), the fixer command itself, or genuinely hard pull requests that need a person. If recent ticks push cleanly — report no-change and name the evidence. ${NO_CHANGE}`,
      ].join('\n');
    case 'refused':
      return [
        `Phantom's PR autopilot keeps having its actions refused by its own guards on ${repo}.`,
        '',
        `Inside the ${WINDOW_DAYS}-day outcomes window the journal recorded ${span}${sampleText}`,
        '',
        EVIDENCE,
        '',
        `A 'refused' result means an action was attempted and a guard stopped it: the branch moved since observation, the fixer moved HEAD or the index outside the conflicted files, protected paths appeared in the diff, conflict markers or unresolved files remained, a verify-after guard tripped, no fixer was configured, or the push was refused. Kill-switch and pause refusals are deliberate-off state and are never counted. Read the journal's detail strings to find the dominant refusal — recurring 'branch moved' means heads churn faster than ticks, 'fixer moved HEAD' or 'index outside the conflicted files' means fixer misbehavior, 'protected path' means a lane touching gated paths, 'no fixer configured' means the invocation lacked --fixer, 'push refused' means remote state or permissions. Fix the dominant cause or the autopilot's handling of it in src/core/autopilot/. If recent ticks act cleanly — report no-change and name the evidence. ${NO_CHANGE}`,
      ].join('\n');
    case 'empty-fix':
      return [
        `Phantom's PR autopilot fixer keeps changing nothing when asked to fix on ${repo} — the fix loop spins without progress.`,
        '',
        `Inside the ${WINDOW_DAYS}-day outcomes window the journal recorded ${span}${sampleText}`,
        '',
        EVIDENCE,
        '',
        `These are 'no-change' results on 'fix-ci' or 'address-review' plans — for those plans the only no-change outcome is "the fixer changed nothing": the fixer ran and produced an empty diff, so nothing was committed or pushed (merge-base and recut no-change rows are benign and never counted). Recurring empty fixes mean the fixer or the brief it receives is not doing the work. Check the fixer command (the --fixer default is 'claude -p --permission-mode acceptEdits'), the brief fixBrief builds in src/core/autopilot/diagnose.ts, and whether the pull requests' failures are fixable by edits at all. If recent ticks land fixes — report no-change and name the evidence. ${NO_CHANGE}`,
      ].join('\n');
  }
}

const REPO_CELL_ORDER: readonly RepoCellKind[] = ['tick-error', 'verify-failed', 'refused', 'empty-fix'];

const TITLES: Record<CellKind, (repo: string, number?: number) => string> = {
  'needs-person': (repo, number) => `Autopilot-stuck PR ${repo}#${number} keeps needing a person`,
  'tick-error': (repo) => `PR autopilot ticks keep erroring on ${repo}`,
  'verify-failed': (repo) => `Autopilot verify keeps rejecting fixes on ${repo}`,
  'refused': (repo) => `Autopilot actions keep being refused on ${repo}`,
  'empty-fix': (repo) => `Autopilot fixer keeps changing nothing on ${repo}`,
};

function itemId(kind: CellKind, repo: string, number?: number): string {
  const hash = createHash('sha256')
    .update(`autopilot:${kind}:${repo.toLowerCase()}${number === undefined ? '' : `#${number}`}`)
    .digest('hex')
    .slice(0, 16);
  return `autopilot-${kind}-${hash}`;
}

function makeItem(kind: CellKind, repo: string, title: string, prompt: string, number?: number): CloudBacklogItem {
  return {
    id: itemId(kind, repo, number),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'autopilot',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

const recurring = (tally: { rows: number; days: ReadonlySet<string> }): boolean =>
  tally.rows >= AUTOPILOT_MIN_UNITS && tally.days.size >= AUTOPILOT_MIN_DAYS;

/**
 * Backlog items for the PR-autopilot outcomes journal's recurring adverse
 * evidence on `repo`. Total: a bad repo label, a missing journal, an
 * unreadable read or any fold failure yields no items rather than throwing
 * into discovery.
 */
export async function autopilotBacklogItems(opts: AutopilotItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? AUTOPILOT_WINDOW_MS;
    const journalPath = opts.journalPath ?? join(ashlrHome(), AUTOPILOT_JOURNAL_RELATIVE);
    const tail = await readLedgerTail(journalPath, AUTOPILOT_TAIL_BYTES);
    // A missing journal is a clean empty source; an unreadable or non-file
    // read means evidence exists that cannot be trusted — fail closed. A
    // truncated tail still folds, lower-bound flagged.
    if (tail.state !== 'read') return [];
    const rows = parseAutopilotJournal(tail.text);
    if (rows.length === 0) return [];
    const fold = foldAutopilotRows(rows, repo, nowMs, windowMs);

    const candidates: CloudBacklogItem[] = [];
    // Per-PR stop cells first — they name the exact stuck pull request.
    const stops = [...fold.stops.entries()]
      .filter(([, track]) => recurring(track))
      .sort((a, b) => b[1].rows - a[1].rows || a[0] - b[0]);
    for (const [number, track] of stops) {
      candidates.push(makeItem(
        'needs-person',
        repo,
        TITLES['needs-person'](repo, number),
        needsPersonPrompt(repo, number, track, tail.truncated === true),
        number,
      ));
    }
    for (const kind of REPO_CELL_ORDER) {
      const tally = fold.cells[kind];
      if (!recurring(tally)) continue;
      candidates.push(makeItem(
        kind,
        repo,
        TITLES[kind](repo),
        repoCellPrompt(kind, repo, tally, tail.truncated === true),
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? AUTOPILOT_BACKLOG_MAX_ITEMS, AUTOPILOT_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
