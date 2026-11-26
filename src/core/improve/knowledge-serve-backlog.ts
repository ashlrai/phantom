/**
 * Approved knowledge notes that never reach a task prompt → self-improvement
 * backlog items.
 *
 * Phantom's learn→inject loop has two halves. The write half — the retro
 * sweep's candidates, the owner's Verse decisions — is covered by the
 * nightly, lesson-trial, knowledge-outcome and playbook-outcome feeds.
 * The read half is not: an APPROVED note becomes useful only when
 * knowledgeBlockFor / withApprovedKnowledge (src/core/learn/retro/inject.ts)
 * renders it into a prompt, and every rendered injection appends the note
 * ids to ~/.ashlr/learn/knowledge-hits.jsonl through recordKnowledgeHits —
 * the append-only hits log readKnowledgeHits folds into per-note
 * {hits, lastHitAt} totals (the same fold buildLessonsState applies as
 * note.hits + log hits for the Lessons view's per-note counters).
 *
 * The injection call sites are narrow and deliberate: the daemon's
 * producerGoalWithGuidance for fleet work-item briefs (recordHits on,
 * trajectoryId run:<attemptId> so knowledge-runs.jsonl correlates the
 * injection to trajectory outcomes), the prepared manager-prompt path
 * (recordHits deferred to the admitted dispatch), and the cloud launch
 * path in src/core/cloud/service.ts where only the 'served' lesson-arm
 * records hits — the 'holdout' arm is the randomized control and must
 * stay uncounted. The Leader's portfolio read (leaderLessons) carries
 * every approved note into Leader evidence uncountered by design. Until
 * now the hits log's only readers were that same Lessons projection —
 * a per-note counter someone had to open the Verse panel to see — so a
 * corpus of approved notes that never reached a single task prompt, or
 * notes whose injections quietly stopped, never became work even though
 * every approved note is machinery the fleet pays to store, rank and
 * carry.
 *
 * knowledgeServeBacklogItems carries the same recorded counters into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue the consumption gap exactly like the sibling
 * knowledge feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The note corpus is read through readKnowledge — the
 *    same bounded store read the Lessons view and the outcome feed
 *    fold — and the hits through readKnowledgeHits, the same fold
 *    buildLessonsState applies. Nothing is written and no network is
 *    touched; any read failure yields no items rather than throwing
 *    into discovery.
 *  - Recorded evidence only. "Zero recorded injections" is literal:
 *    recordKnowledgeHits is fire-and-forget, so the counters are what
 *    the log recorded, never a proof that no prompt ever carried the
 *    note (the Leader's uncountered portfolio read is exactly such a
 *    case). A missing hits file reads as zero recorded hits — the file
 *    is created on the first recorded injection — and the prompts say
 *    "recorded" throughout.
 *  - Live notes only. A row counts only while its note is still
 *    'approved' — the state that keeps it eligible for injection. A
 *    pending note was never injected by design and a rejected note was
 *    already handled, so neither can evidence a consumption gap; a
 *    note missing from the store cannot be resolved and never counts.
 *    An empty or unreadable knowledge read yields no items: with no
 *    approved corpus proven, there is no gap to report.
 *  - Age is proven, never assumed. A note's eligibility clock starts
 *    at decidedAt (the approval write) falling back to createdAt; a
 *    note whose dates do not parse cannot prove it has waited out the
 *    bar and is skipped, counted as undated. Never-served means
 *    effective hits of zero AND at least KNOWLEDGE_SERVE_MIN_AGE_DAYS
 *    days approved — a note approved yesterday legitimately has no
 *    hits yet.
 *  - Recurring means a pattern, not one narrow note. The never-served
 *    cell emits at KNOWLEDGE_SERVE_MIN_NEVER_SERVED qualifying notes —
 *    or for a single note approved at least
 *    KNOWLEDGE_SERVE_LONG_NEVER_DAYS days, where "waiting for a
 *    matching task" stops being a plausible explanation. The stale
 *    cell — notes that DID record injections but whose lastHitAt is at
 *    least KNOWLEDGE_SERVE_STALE_DAYS old — emits only at
 *    KNOWLEDGE_SERVE_MIN_STALE notes, a higher bar because a quiet
 *    spell can be the fleet's work mix drifting rather than broken
 *    machinery.
 *  - Fleet machinery only. The learn store describes this install's
 *    own lesson machinery, so items emit only for the fleet's own
 *    repository ('phantom' last-segment match, the same rule the
 *    sibling knowledge feeds apply); self-improvement pointed at
 *    another repository inherits nothing.
 *  - Dedup is downstream. The item id hashes only the cell kind —
 *    never the counts, ages or note ids — so a refresh re-derives the
 *    same id and appendUserBacklogItems adds only what is new; a
 *    shrinking corpus does not spawn twin items, and a cell that
 *    recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts, ages
 *    and scope tallies are quoted only as recorded, example note text
 *    is scrubbed, flattened and capped, and the brief names the store,
 *    the hits log, the injection call sites, the ranking and cap
 *    constants and the owner-only boundary — with the usual
 *    no-change escape.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readKnowledge, readKnowledgeHits, type HitTotals } from '../learn/retro/store.js';
import type { KnowledgeNoteV1, KnowledgeScope } from '../learn/retro/types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is the two consumption-gap kinds. */
export const KNOWLEDGE_SERVE_MAX_ITEMS = 2;
export const KNOWLEDGE_SERVE_ITEM_HARD_MAX = 4;
/** A never-served note must have been approved at least this long before zero hits is evidence. */
export const KNOWLEDGE_SERVE_MIN_AGE_DAYS = 7;
/** The never-served cell emits at this many qualifying approved notes... */
export const KNOWLEDGE_SERVE_MIN_NEVER_SERVED = 2;
/** ...or for one note approved at least this long — a month of fleet work should have matched it. */
export const KNOWLEDGE_SERVE_LONG_NEVER_DAYS = 30;
/** A served note whose lastHitAt is at least this old counts toward the stale cell. */
export const KNOWLEDGE_SERVE_STALE_DAYS = 30;
/** The stale cell emits at this many qualifying notes — quiet spells are weaker evidence than never-served. */
export const KNOWLEDGE_SERVE_MIN_STALE = 3;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: knowledge evidence is this repo's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** Example note snippets quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_EXAMPLES = 4;
/** Repo/task-kind/path/source tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 6;
const DAY_MS = 86_400_000;

export interface KnowledgeServeItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /**
   * Injected knowledge-store notes (tests); skips the readKnowledge call
   * when set. An explicit null means the store read failed — withheld
   * evidence, never an empty corpus. Same contract as the sibling
   * knowledge feeds.
   */
  notes?: readonly KnowledgeNoteV1[] | null;
  /**
   * Injected hits fold (tests); skips the readKnowledgeHits call when set.
   * An explicit null means the hits read failed — withheld, never
   * zero-filled. Same contract as the store's own reader: per-note
   * recorded totals, absent ids simply have no recorded hits.
   */
  hits?: ReadonlyMap<string, HitTotals> | null;
  /** Clock anchoring ages and staleness (default: now). */
  now?: Date;
  /** Most items one call emits (default KNOWLEDGE_SERVE_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Store-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Fold — the approved corpus against the recorded hits
// ---------------------------------------------------------------------------

/** One approved note's recorded consumption state inside the fold. */
export interface ServeNoteRow {
  id: string;
  /** Scrubbed, flattened note text for prompt examples. */
  snippet: string;
  scope: KnowledgeScope;
  /** The note's recorded provenance label (retro source or 'mason'). */
  source: string;
  /** Approval instant (decidedAt, falling back to createdAt) in ms. */
  approvedAtMs: number;
  /** Whole days since approval at the fold's `now`. */
  ageDays: number;
  /** note.hits + recorded log hits — the same sum buildLessonsState publishes. */
  effectiveHits: number;
  /** Newest recorded injection instant in ms, or null when none was dated. */
  lastHitAtMs: number | null;
  /** Days since the newest recorded injection; null when never hit or undated. */
  quietDays: number | null;
}

/** Per-cell fold before the emit bars apply. */
export interface KnowledgeServeFold {
  /** Approved notes proven eligible and dated — the corpus denominator. */
  approved: number;
  /** Approved notes skipped because neither decidedAt nor createdAt parsed. */
  undated: number;
  /** Approved notes with zero effective hits at least MIN_AGE_DAYS old. */
  neverServed: ServeNoteRow[];
  /** Approved notes with hits whose lastHitAt is at least STALE_DAYS old. */
  stale: ServeNoteRow[];
  /** The oldest approval instant among never-served rows, ms; null when none. */
  neverOldestMs: number | null;
}

const parseMs = (value: string | null | undefined): number | null => {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const EMPTY_SCOPE: KnowledgeScope = { repo: null, pathGlobs: [], taskKinds: [] };

/** Defensive scope read: injected rows are trusted types, but a malformed scope must not crash the fold. */
function scopeOf(value: unknown): KnowledgeScope {
  if (!isRecord(value)) return EMPTY_SCOPE;
  const repo = typeof value['repo'] === 'string' && value['repo'] !== '' ? value['repo'] : null;
  const pathGlobs = Array.isArray(value['pathGlobs']) ? value['pathGlobs'].filter((g): g is string => typeof g === 'string') : [];
  const taskKinds = Array.isArray(value['taskKinds']) ? value['taskKinds'].filter((k): k is KnowledgeScope['taskKinds'][number] => typeof k === 'string') : [];
  return { repo, pathGlobs, taskKinds };
}

/**
 * Pure: fold the approved corpus against the recorded hits into the two
 * consumption-gap cells. Only 'approved' notes count — pending notes were
 * never injected by design and rejected notes were already handled. The
 * effective-hit sum mirrors buildLessonsState (stored hits + log hits);
 * lastHitAt prefers the log's newest recorded instant, then the stored
 * field, exactly as the Lessons projection does.
 */
export function foldKnowledgeServe(
  notes: readonly KnowledgeNoteV1[],
  hits: ReadonlyMap<string, HitTotals>,
  nowMs: number,
): KnowledgeServeFold {
  const fold: KnowledgeServeFold = { approved: 0, undated: 0, neverServed: [], stale: [], neverOldestMs: null };
  for (const note of notes) {
    if (!isRecord(note) || note.status !== 'approved') continue;
    if (typeof note.id !== 'string' || note.id === '') continue;
    const approvedAtMs = parseMs(note.decidedAt) ?? parseMs(note.createdAt);
    if (approvedAtMs === null) { fold.undated++; continue; }
    fold.approved += 1;
    const log = hits.get(note.id);
    const logHits = isRecord(log) && typeof log['hits'] === 'number' && Number.isSafeInteger(log['hits']) && log['hits'] > 0 ? log['hits'] : 0;
    const effectiveHits = (Number.isSafeInteger(note.hits) && note.hits > 0 ? note.hits : 0) + logHits;
    const lastHitAtMs = parseMs(log?.lastHitAt) ?? parseMs(note.lastHitAt);
    const ageDays = Math.floor((nowMs - approvedAtMs) / DAY_MS);
    const row: ServeNoteRow = {
      id: note.id,
      snippet: fieldText(typeof note.text === 'string' ? note.text : ''),
      scope: scopeOf(note.scope),
      source: typeof note.source === 'string' && note.source.length > 0 ? note.source : 'unknown',
      approvedAtMs,
      ageDays,
      effectiveHits,
      lastHitAtMs,
      quietDays: lastHitAtMs === null ? null : Math.floor((nowMs - lastHitAtMs) / DAY_MS),
    };
    if (effectiveHits === 0) {
      if (ageDays >= KNOWLEDGE_SERVE_MIN_AGE_DAYS) {
        fold.neverServed.push(row);
        fold.neverOldestMs = fold.neverOldestMs === null ? approvedAtMs : Math.min(fold.neverOldestMs, approvedAtMs);
      }
      continue;
    }
    if (lastHitAtMs !== null && row.quietDays !== null && row.quietDays >= KNOWLEDGE_SERVE_STALE_DAYS) {
      fold.stale.push(row);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — the recurring bars
// ---------------------------------------------------------------------------

export interface KnowledgeServeCell {
  kind: 'never-served' | 'stale-served';
  /** Qualifying approved notes inside the cell. */
  notes: ServeNoteRow[];
  /** Approved corpus size the cell was measured against. */
  approved: number;
  /** Approved notes skipped for unparseable dates. */
  undated: number;
}

/**
 * Pure: the emit bars. Never-served fires on a pattern (MIN_NEVER_SERVED
 * notes) or on one note old enough that waiting is no longer plausible;
 * stale-served fires only on the higher population bar.
 */
export function knowledgeServeCells(fold: KnowledgeServeFold, nowMs: number): KnowledgeServeCell[] {
  const cells: KnowledgeServeCell[] = [];
  const base = { approved: fold.approved, undated: fold.undated };
  const oldestNeverAgeDays = fold.neverOldestMs === null ? null : Math.floor((nowMs - fold.neverOldestMs) / DAY_MS);
  if (
    fold.neverServed.length >= KNOWLEDGE_SERVE_MIN_NEVER_SERVED ||
    (fold.neverServed.length >= 1 && oldestNeverAgeDays !== null && oldestNeverAgeDays >= KNOWLEDGE_SERVE_LONG_NEVER_DAYS)
  ) {
    cells.push({ kind: 'never-served', notes: fold.neverServed, ...base });
  }
  if (fold.stale.length >= KNOWLEDGE_SERVE_MIN_STALE) {
    cells.push({ kind: 'stale-served', notes: fold.stale, ...base });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is the learn store\'s approved-note corpus (~/.ashlr/learn/knowledge.json, read through readKnowledge — the same store the Lessons view folds) joined to the append-only injection hits log (~/.ashlr/learn/knowledge-hits.jsonl, folded by readKnowledgeHits into per-note {hits, lastHitAt} totals; the store compacts it past 256 KiB into summed rows the same reader understands). Injection happens only through knowledgeBlockFor/withApprovedKnowledge (src/core/learn/retro/inject.ts): the daemon\'s producerGoalWithGuidance for fleet work-item briefs records hits and knowledge-runs trajectory ids, the prepared manager-prompt path records them at the admitted dispatch, and the cloud launch path (src/core/cloud/service.ts) records hits only for the \'served\' lesson arm — the \'holdout\' arm is the randomized control and stays uncounted by design. The Leader\'s portfolio read (leaderLessons) carries every approved note into Leader evidence without recording hits. Until this feed the counters only reached the Verse Lessons panel — a per-note number someone had to open — so approved notes that never reached a task prompt never became work.';

const REPRO = 'Reproduce the fold by reading ~/.ashlr/learn/knowledge.json for notes with status \'approved\' and ~/.ashlr/learn/knowledge-hits.jsonl as JSONL ({id, at} rows, or compacted {id, at, n} rows), then applying the same effective-hits sum the Lessons view uses (stored note.hits + log hits) and the decidedAt/createdAt approval clock. The writers and contracts this repository owns are src/core/learn/retro/store.ts (readKnowledge, readKnowledgeHits, recordKnowledgeHits, the compaction), src/core/learn/retro/inject.ts (knowledgeBlockFor, withApprovedKnowledge, selectKnowledge, scopeMatches, KNOWLEDGE_INJECT_MAX_NOTES = 8, the 16 KiB render cap), src/core/learn/retro/extract.ts (the retro→pending scope proposals), src/core/daemon/loop.ts (producerGoalWithGuidance and the prepared manager-prompt path) and src/core/cloud/service.ts (the served/holdout arm split).';

const NO_CHANGE = 'If the corpus has changed since this evidence — notes edited, rejected or newly approved — the quiet spell reflects the fleet\'s work mix drifting onto other scopes, the matching tasks genuinely never ran, or the right fix is an owner-only act (approving, editing or rejecting a lesson note is a Verse decision only the owner takes) — report no-change and name the evidence.';

interface UsageTally {
  text: string;
  count: number;
}

function tallyOf(map: Map<string, number>, max: number): UsageTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const tallyText = (tallies: readonly UsageTally[]): string =>
  tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');

/** Scope tallies shared by both cells: where the qualifying notes claim to apply. */
function scopeTallies(rows: readonly ServeNoteRow[]): { taskKinds: UsageTally[]; repos: UsageTally[]; pathGlobs: UsageTally[]; sources: UsageTally[] } {
  const taskKinds = new Map<string, number>();
  const repos = new Map<string, number>();
  const pathGlobs = new Map<string, number>();
  const sources = new Map<string, number>();
  for (const row of rows) {
    const kinds = row.scope.taskKinds.length > 0 ? [...row.scope.taskKinds].sort().join('+') : '(any)';
    taskKinds.set(kinds, (taskKinds.get(kinds) ?? 0) + 1);
    repos.set(row.scope.repo ?? '(any repo)', (repos.get(row.scope.repo ?? '(any repo)') ?? 0) + 1);
    pathGlobs.set(row.scope.pathGlobs.length > 0 ? 'scoped paths' : '(any path)', (pathGlobs.get(row.scope.pathGlobs.length > 0 ? 'scoped paths' : '(any path)') ?? 0) + 1);
    sources.set(row.source, (sources.get(row.source) ?? 0) + 1);
  }
  return {
    taskKinds: tallyOf(taskKinds, MAX_PROMPT_TALLIES),
    repos: tallyOf(repos, MAX_PROMPT_TALLIES),
    pathGlobs: tallyOf(pathGlobs, MAX_PROMPT_TALLIES),
    sources: tallyOf(sources, MAX_PROMPT_TALLIES),
  };
}

const exampleText = (rows: readonly ServeNoteRow[]): string => {
  const shown = rows.slice(0, MAX_PROMPT_EXAMPLES);
  const parts = shown.map((row) => {
    const snippet = row.snippet === '' ? row.id : row.snippet;
    const display = snippet.length > 110 ? `${snippet.slice(0, 109)}…` : snippet;
    return `'${display}' (${row.id})`;
  });
  const rest = rows.length - shown.length;
  return rest > 0 ? `${parts.join('; ')}; and ${rest} more` : parts.join('; ');
};

const undatedText = (cell: KnowledgeServeCell): string =>
  cell.undated > 0 ? ` ${cell.undated} further approved ${cell.undated === 1 ? 'note has' : 'notes have'} unparseable dates and could not prove the age bar, so ${cell.undated === 1 ? 'it was' : 'they were'} skipped.` : '';

function neverServedPrompt(cell: KnowledgeServeCell): string {
  const count = cell.notes.length;
  const minAge = Math.min(...cell.notes.map((n) => n.ageDays));
  const maxAge = Math.max(...cell.notes.map((n) => n.ageDays));
  const tallies = scopeTallies(cell.notes);
  return [
    `Phantom's learn→inject loop is holding approved knowledge notes that never reach a task prompt — ${count} of ${cell.approved} approved ${cell.approved === 1 ? 'note has' : 'notes have'} zero recorded injections and ${count === 1 ? 'has' : 'have'} been approved at least ${KNOWLEDGE_SERVE_MIN_AGE_DAYS} days (ages ${minAge}–${maxAge} days), the self-improvement work this backlog exists for.`,
    '',
    `Every rendered injection appends the note ids to ~/.ashlr/learn/knowledge-hits.jsonl; these notes have no recorded hit at all. Scope tally across the cell — task kinds: ${tallyText(tallies.taskKinds)}; repo scope: ${tallyText(tallies.repos)}; paths: ${tallyText(tallies.pathGlobs)}; provenance: ${tallyText(tallies.sources)}. Examples: ${exampleText(cell.notes)}.${undatedText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why approved notes stay unserved: whether learn/retro/extract.ts scope proposals produce scopes the task-prompt path can never satisfy — a taskKinds list the classifier never yields (classifyTaskKind in inject.ts returns fix/feature/refactor/tests/docs/deps/ci/revert/other, never 'leader', so a leader-only scope can never match a task prompt), a repo or pathGlobs no fleet work item satisfies — whether selectKnowledge's ordering (specificity, then recorded hits, then recency, under KNOWLEDGE_INJECT_MAX_NOTES = 8) permanently starves zero-hit notes once the corpus grows, whether renderKnowledgeBlock's 16 KiB cap drops them whole, or whether the lanes their scopes target never run the injection path at all. The Leader's portfolio read carries every approved note uncountered, so "never served" means never injected into a task prompt — not never read. Fix the cause in this repository's lesson machinery. Approving, editing or rejecting a note is an owner-only Verse act no agent may take. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function staleServedPrompt(cell: KnowledgeServeCell): string {
  const count = cell.notes.length;
  const quiet = cell.notes.map((n) => n.quietDays ?? 0);
  const minQuiet = Math.min(...quiet);
  const maxQuiet = Math.max(...quiet);
  const hitsTotal = cell.notes.reduce((sum, n) => sum + n.effectiveHits, 0);
  const lastHits = cell.notes.map((n) => n.lastHitAtMs).filter((ms): ms is number => ms !== null);
  const newestHit = lastHits.length > 0 ? new Date(Math.max(...lastHits)).toISOString() : null;
  const oldestHit = lastHits.length > 0 ? new Date(Math.min(...lastHits)).toISOString() : null;
  const tallies = scopeTallies(cell.notes);
  return [
    `Phantom's learn→inject loop shows approved knowledge notes going quiet — ${count} of ${cell.approved} approved notes that did record prompt injections have had no recorded hit in ${KNOWLEDGE_SERVE_STALE_DAYS}+ days (quiet ${minQuiet}–${maxQuiet} days; ${hitsTotal} recorded injections in total, newest recorded ${newestHit ?? 'unknown'}, oldest ${oldestHit ?? 'unknown'}), the self-improvement work this backlog exists for.`,
    '',
    `These notes proved servable once — the injection path matched them — then stopped recording hits. Scope tally across the cell — task kinds: ${tallyText(tallies.taskKinds)}; repo scope: ${tallyText(tallies.repos)}; paths: ${tallyText(tallies.pathGlobs)}; provenance: ${tallyText(tallies.sources)}. Examples: ${exampleText(cell.notes)}.${undatedText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why served notes went quiet: whether the fleet's work mix drifted so the notes' scopes match less often (a legitimate quiet spell — check whether matching tasks still run before changing anything), whether selectKnowledge's ordering now ranks them below KNOWLEDGE_INJECT_MAX_NOTES = 8 competitors as the corpus grew, whether renderKnowledgeBlock's 16 KiB cap now drops them whole, or whether an injection call site stopped running (a lane that lost its knowledgeBlockFor/withApprovedKnowledge call, or a recordHits flag flipped off outside the designed preview and holdout exceptions). The holdout arm staying uncounted and preview paths staying unrecorded are intended — do not "fix" them. Fix the cause in this repository's lesson machinery. Approving, editing or rejecting a note is an owner-only Verse act no agent may take. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function serveItem(cell: KnowledgeServeCell, repo: string): CloudBacklogItem {
  const never = cell.kind === 'never-served';
  const count = cell.notes.length;
  const noun = count === 1 ? 'note' : 'notes';
  const title = never
    ? `${count} approved knowledge ${noun} ${count === 1 ? 'has' : 'have'} zero recorded prompt injections`
    : `${count} approved knowledge ${noun} stopped recording prompt injections`;
  return {
    id: `knowledge-serve-${sha(`knowledge-serve:${cell.kind}`)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: never ? neverServedPrompt(cell) : staleServedPrompt(cell),
    area: 'knowledge-serve',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the approved-knowledge consumption gap: notes that
 * never reached a task prompt, and notes whose recorded injections went
 * quiet. Total: a failed note or hits read, another repository, or any
 * unexpected failure yields no items rather than throwing into discovery.
 */
export async function knowledgeServeBacklogItems(opts: KnowledgeServeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const notes = opts.notes !== undefined
      ? opts.notes
      : await readKnowledge().catch(() => null);
    // A failed knowledge read withholds every row: no approved corpus proven.
    if (notes === null) return [];
    const hits = opts.hits !== undefined
      ? opts.hits
      : await readKnowledgeHits().catch(() => null);
    // A failed hits read cannot prove "zero recorded" — withhold, never guess.
    if (hits === null) return [];
    const fold = foldKnowledgeServe(notes, hits, nowMs);
    const cells = knowledgeServeCells(fold, nowMs);
    if (cells.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? KNOWLEDGE_SERVE_MAX_ITEMS, KNOWLEDGE_SERVE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => serveItem(cell, repo));
  } catch {
    return [];
  }
}
