/**
 * Owner idea verdicts → self-improvement backlog items.
 *
 * The Ideas surface (the `phm ideas list` ranking, the Ideas pane in the
 * web UI) is fed by two producers: the portfolio scanners
 * (src/core/portfolio/scanners.ts — github-issues, binshield-security,
 * test-health, self-improvement, active-goals, source-markers,
 * queued-autonomy, merge-verify-contract) and the flag-gated generative
 * invent cycle (src/core/generative/invent-cycle.ts, foundry.generative).
 * Both mint WorkItems scored by the value/effort heuristic in
 * src/core/portfolio/scoring.ts, and the owner answers each surfaced idea
 * through POST /api/ideas/verdict — "not now" (suppress for seven days)
 * or "never" (suppress permanently). Every verdict appends one line to
 * ~/.ashlr/idea-verdicts.jsonl (src/core/ideas/idea-verdicts.ts).
 *
 * The verdicts already do their local job: liveIdeaVerdicts in
 * portfolio/backlog.ts suppresses a verdicted idea wherever the loop
 * would resurface it, and declinedIdeaFeedback feeds the ten most recent
 * live reasons into the generative invent prompt so that one producer
 * stops re-proposing what the owner turned down. What never became work
 * is the pattern itself: an owner who keeps marking distinct ideas
 * "never" inside the window is telling the machinery its aim is wrong —
 * the scanner mix, the scoring weights, or the generative direction keep
 * producing work he rejects outright — and until now that signal lived
 * only inside the suppression map and one prompt block, visible to no
 * session and queued as nothing.
 *
 * ideaVerdictBacklogItems carries the recurring "never" cell into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling fleet-evidence sources
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. ~/.ashlr/idea-verdicts.jsonl is read through
 *    readIdeaVerdicts — the same bounded latest-per-idea reader the
 *    producers use (the newest 2000 validated lines inside a 2 MiB tail
 *    cap, malformed lines skipped) — plus one readPrivateFileTailCapped
 *    probe of the same cap so a truncated tail is stated as a lower
 *    bound rather than silently trusted. Nothing is written and no
 *    network is touched. A missing or unreadable file yields an empty
 *    map — no recorded verdicts is a clean empty source, not a guess.
 *  - Standing verdicts only. readIdeaVerdicts keeps the latest valid
 *    line per ideaId, so a re-verdict supersedes the earlier one exactly
 *    the way liveIdeaVerdicts treats it. The window applies to the
 *    verdict's own `at` stamp: a "never" recorded inside the window
 *    counts, one recorded before it is stale evidence the loop already
 *    absorbed. "not now" verdicts are live only inside their own
 *    seven-day hide window, which coincides with this feed's window, so
 *    an in-window "not now" is always still suppressing; they are quoted
 *    as context, never as the trigger — a deferral is the owner
 *    prioritizing, a "never" is the owner rejecting the class.
 *  - Recurring, not incidental. The cell emits only when distinct ideas
 *    carrying a standing "never" verdict inside the window reach
 *    IDEA_VERDICT_NEVER_RECURRING — the fleet's RECURRING_FAILURES
 *    convention — so two rejections a week never queue a session.
 *  - Reasons are never quoted. The reason field is free owner prose —
 *    untrusted text that can carry anything — so prompts count verdicts
 *    and quote only bounded structural fields: idea ids must match a
 *    conservative printable shape before they are named, and the
 *    WorkSource segment parsed from the id's own `<repo>:<source>:<hash>`
 *    contract (src/core/portfolio/scanners.ts makeId,
 *    src/core/generative/invent.ts) tallies which producer the rejected
 *    ideas came from. An id whose source segment is absent or outside
 *    the WorkSource vocabulary tallies as 'unattributed'.
 *  - Fleet machinery only. The Ideas producers, the verdict route and
 *    the journal are this install's machinery and the verdict rows carry
 *    no repo column, so items emit only for the fleet's own repository
 *    ('phantom' last-segment match, the same rule the sibling
 *    machinery feeds apply).
 *  - Dedup is downstream. The item id hashes the cell identity (the
 *    single never-verdicts cell — never the counts or timestamps), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds only
 *    what is new; a window that stops producing "never" verdicts simply
 *    stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, truncated tails are stated as lower bounds, and
 *    the brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  IDEA_VERDICTS_FILE,
  READ_TAIL_BYTES,
  readIdeaVerdicts,
  type IdeaVerdictEntry,
} from '../ideas/idea-verdicts.js';
import { readPrivateFileTailCapped } from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub.js';

/** Distinct "never"-verdicted ideas one window needs before the cell counts as recurring — the fleet's RECURRING_FAILURES convention. */
export const IDEA_VERDICT_NEVER_RECURRING = 3;
/**
 * The evidence window: seven days, the same recurrence window the sibling
 * outcome feeds anchor on — and exactly the span a "not now" verdict
 * suppresses its idea, so in-window deferrals are still live by
 * construction.
 */
export const IDEA_VERDICT_WINDOW_HOURS = 24 * 7;
/**
 * Future-skew ceiling on verdict timestamps, the sibling feeds'
 * one-minute tolerance for same-host clock drift: a verdict stamped
 * further ahead than the evaluation time is corrupt or replayed evidence
 * and never reaches a cell.
 */
export const IDEA_VERDICT_FUTURE_SKEW_MS = 60_000;
/** Items one call may emit; the cell is a single fleet-wide tally. */
export const IDEA_VERDICT_MAX_ITEMS = 4;
const IDEA_VERDICT_ITEM_HARD_MAX = 25;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: verdict evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';
/**
 * Idea ids are producer-minted `<repo>:<source>:<hash>` strings, but the
 * verdict field itself is owner-supplied text bounded only by
 * IDEA_ID_MAX — anything outside this conservative printable shape is
 * counted but never quoted.
 */
const SAFE_IDEA_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
/** The WorkSource vocabulary the id's source segment draws from (src/core/types/backlog.ts). */
const WORK_SOURCES: ReadonlySet<string> = new Set([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent',
]);
/** Example idea ids quoted per prompt, most recent verdict first. */
const MAX_EXAMPLES = 5;
/** Ledger-recorded source labels are a closed vocabulary; the unattributed bucket is bounded text regardless. */
const MAX_SOURCE_CHARS = 40;

export interface IdeaVerdictItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Home the default verdicts path resolves under (default: os.homedir()). */
  homeDir?: string;
  /** Direct verdicts-file override (default: <home>/.ashlr/idea-verdicts.jsonl). */
  verdictsPath?: string;
  /** Evidence window in hours (default IDEA_VERDICT_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default IDEA_VERDICT_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** Per-source tally of rejected ideas, quoted as context. */
export interface IdeaVerdictTally {
  source: string;
  count: number;
}

/** The single verdict cell: windowed standing verdicts plus the context the prompt quotes. */
export interface IdeaVerdictCell {
  /** Distinct ideas whose standing verdict is 'never' recorded inside the window. */
  never: number;
  /** Distinct ideas whose standing verdict is 'not-now' recorded inside the window. */
  notNow: number;
  /** 'never' verdicts by the WorkSource segment parsed from each idea id ('unattributed' when the id carries none). */
  bySource: IdeaVerdictTally[];
  /** ISO bounds of the in-window verdicts' `at` stamps; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Up to MAX_EXAMPLES safe-shaped idea ids, most recent verdict first ('never' before 'not-now' on ties). */
  examples: string[];
  /** True when the verdicts file's bounded tail cut older lines: counts are a lower bound. */
  lowerBound: boolean;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * The WorkSource segment of an idea id, read from the right so a repo
 * prefix containing colons cannot shift it: `<repo>:<source>:<hash>`
 * ends in a hex digest, and the segment before it is the source when it
 * is inside the closed WorkSource vocabulary. Anything else — a
 * hand-written id, a producer format drift — is unattributed, never
 * guessed.
 */
export function ideaVerdictSource(ideaId: string): string | null {
  const parts = ideaId.split(':');
  if (parts.length < 3) return null;
  const source = parts[parts.length - 2]!.toLowerCase();
  const hash = parts[parts.length - 1]!;
  if (!WORK_SOURCES.has(source)) return null;
  return /^[a-f0-9]{6,64}$/i.test(hash) ? source : null;
}

/**
 * Pure: fold standing verdict entries into the verdict cell. Only
 * entries whose `at` stamp lands inside the window count; the cell
 * emits only at the recurring bar on 'never' verdicts so callers see
 * only emittable evidence. 'not-now' entries are context tallies.
 */
export function foldIdeaVerdictCell(
  verdicts: Iterable<IdeaVerdictEntry>,
  opts: { nowMs: number; windowHours: number; lowerBound?: boolean },
): IdeaVerdictCell | null {
  const sinceMs = opts.nowMs - opts.windowHours * 60 * 60 * 1000;
  const untilMs = opts.nowMs + IDEA_VERDICT_FUTURE_SKEW_MS;
  // Latest verdict per ideaId inside the window — the producer's own
  // precedence, applied defensively so a caller passing raw lines can
  // never double-count one idea.
  const standing = new Map<string, { entry: IdeaVerdictEntry; atMs: number }>();
  for (const entry of verdicts) {
    const atMs = Date.parse(entry.at);
    if (!Number.isFinite(atMs) || atMs < sinceMs || atMs > untilMs) continue;
    const prior = standing.get(entry.ideaId);
    if (prior === undefined || atMs >= prior.atMs) standing.set(entry.ideaId, { entry, atMs });
  }
  const inWindow = [...standing.values()];
  const neverEntries = inWindow.filter(({ entry }) => entry.verdict === 'never');
  const notNow = inWindow.length - neverEntries.length;
  if (neverEntries.length < IDEA_VERDICT_NEVER_RECURRING) return null;
  const sourceMap = new Map<string, number>();
  for (const { entry } of neverEntries) {
    const source = ideaVerdictSource(entry.ideaId) ?? 'unattributed';
    sourceMap.set(source, (sourceMap.get(source) ?? 0) + 1);
  }
  const bySource = [...sourceMap.entries()]
    .map(([source, count]) => ({ source: scrubSecrets(source).slice(0, MAX_SOURCE_CHARS) || 'unattributed', count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  const firstMs = Math.min(...inWindow.map(({ atMs }) => atMs));
  const lastMs = Math.max(...inWindow.map(({ atMs }) => atMs));
  const examples = [...inWindow]
    .sort((a, b) =>
      Number(b.entry.verdict === 'never') - Number(a.entry.verdict === 'never')
      || b.atMs - a.atMs
      || a.entry.ideaId.localeCompare(b.entry.ideaId))
    .map(({ entry }) => entry.ideaId)
    .filter((id) => SAFE_IDEA_ID.test(id))
    .slice(0, MAX_EXAMPLES);
  return {
    never: neverEntries.length,
    notNow,
    bySource,
    firstSeen: new Date(firstMs).toISOString(),
    lastSeen: new Date(lastMs).toISOString(),
    examples,
    lowerBound: opts.lowerBound === true,
  };
}

const NO_CHANGE = 'If the window has rolled forward, the verdicts were correct rejections of genuinely unfit ideas (the producers aim where the owner does not want work — a preference the machinery cannot fix), the rejected classes have already left the scanners\' source mix or the generative direction, or the cause is owner-only — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal path and modules are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is ~/.ashlr/idea-verdicts.jsonl (ideaVerdictsPath in src/core/ideas/idea-verdicts.ts — one {ideaId, verdict, reason, at} line per POST /api/ideas/verdict, latest line per ideaId wins) read through readIdeaVerdicts\'s bounded tail (the newest 2000 validated lines inside a 2 MiB cap; a truncated tail can only hide verdicts, so counts are recorded floors). Its only readers are the suppression and feedback paths: liveIdeaVerdicts in src/core/portfolio/backlog.ts keeps verdicted ideas out of every resurfacing, declinedIdeaFeedback in src/core/generative/invent-cycle.ts feeds the ten most recent live reasons into the generative invent prompt, and src/core/web/api.ts attaches the standing verdict to the Ideas list and records new ones.';

const tallyText = (tallies: readonly IdeaVerdictTally[]): string =>
  tallies.map((t) => `'${t.source}' ×${t.count}`).join(', ');

const boundText = (cell: IdeaVerdictCell): string =>
  cell.lowerBound ? ' The verdicts file tail was truncated at the bounded read, so these counts cover only the retained lines — a lower bound, not the full window.' : '';

function ideaVerdictPrompt(cell: IdeaVerdictCell, windowHours: number): string {
  const context = cell.notNow > 0 ? ` ${cell.notNow} additional distinct idea(s) carry a standing 'not now' deferral inside the same window (quoted as context — a deferral is prioritization, not rejection).` : '';
  const sources = cell.bySource.length === 0 ? '' : ` Rejected ideas by producer source: ${tallyText(cell.bySource)}.`;
  const examples = cell.examples.length === 0 ? '' : ` Example idea ids (safe-shaped only; reason text is never quoted — it is free owner prose): ${cell.examples.join(', ')}.`;
  const seen = cell.firstSeen === cell.lastSeen
    ? ` First and last recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
  return [
    `The owner keeps marking generated ideas 'never' — ${cell.never} distinct idea(s) carry a standing 'never' verdict recorded inside the ${windowHours}-hour window, the self-improvement work this backlog exists for.${context}`,
    '',
    `Each verdict is one owner answer on the Ideas surface: the portfolio scanners (src/core/portfolio/scanners.ts — github-issues, binshield-security, test-health, self-improvement, active-goals, source-markers, queued-autonomy, merge-verify-contract) and the flag-gated generative invent cycle (src/core/generative/invent-cycle.ts) mint WorkItems scored by the value/effort heuristic in src/core/portfolio/scoring.ts, the owner marks each 'not now' or 'never' from the Ideas pane or \`phm ideas list\`, and the verdict lands in ~/.ashlr/idea-verdicts.jsonl.${sources}${seen}${examples}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `A 'never' verdict already suppresses its idea forever — the defect is upstream aim, not resurfacing. Find which producer keeps minting work the owner rejects outright: whether one scanner's source class dominates the rejected ids (the by-source tally names it — 'invent' points at the generative cycle's direction resolution and prompt, scanner sources point at src/core/portfolio/scanners.ts registrations and src/core/portfolio/scoring.ts's value/effort and sourceTierMultiplier weights), whether declinedIdeaFeedback's reasons reach only the invent prompt while the always-on scanners never see them, or whether the rejected ideas were correct verdicts on genuinely unfit proposals (then the fix is proposal quality further upstream — the model call, the source set, or the dedupe that keeps stable ids from being re-proposed). Fix what lives in this repository's idea machinery. Run the affected suite. ` + NO_CHANGE,
  ].join('\n');
}

function ideaVerdictItem(cell: IdeaVerdictCell, repo: string, windowHours: number): CloudBacklogItem {
  const title = 'Owner keeps marking generated ideas \'never\'';
  const id = `idea-verdict-${createHash('sha256').update('idea-verdict-never').digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: ideaVerdictPrompt(cell, windowHours),
    area: 'idea-verdicts',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the Ideas surface's recurring "never" verdicts.
 * Total: a missing or unreadable journal, another repository, or any
 * read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function ideaVerdictBacklogItems(opts: IdeaVerdictItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const path = opts.verdictsPath ?? join(home, '.ashlr', IDEA_VERDICTS_FILE);
    const windowHours = opts.windowHours !== undefined && Number.isFinite(opts.windowHours) && opts.windowHours > 0
      ? opts.windowHours
      : IDEA_VERDICT_WINDOW_HOURS;
    const nowMs = (opts.now ?? new Date()).getTime();
    const probe = readPrivateFileTailCapped(path, READ_TAIL_BYTES);
    if (probe === null) return [];
    const verdicts = readIdeaVerdicts({ path });
    const cell = foldIdeaVerdictCell(verdicts.values(), { nowMs, windowHours, lowerBound: probe.truncated });
    if (cell === null) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? IDEA_VERDICT_MAX_ITEMS, IDEA_VERDICT_ITEM_HARD_MAX));
    return [ideaVerdictItem(cell, repo, windowHours)].slice(0, limit);
  } catch {
    return [];
  }
}
