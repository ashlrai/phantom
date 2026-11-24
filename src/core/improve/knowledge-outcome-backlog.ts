/**
 * Knowledge-note trajectory outcome tallies → self-improvement backlog items.
 *
 * When the daemon assembles a fleet producer brief, knowledgeBlockFor /
 * withApprovedKnowledge (src/core/learn/retro/inject.ts) inject the approved
 * knowledge notes whose scope matches the task and — because the call carries
 * `trajectoryId: run:<attemptId>` — recordKnowledgeRuns appends the note ids
 * to ~/.ashlr/learn/knowledge-runs.jsonl. readKnowledgeNoteOutcomes
 * (src/core/learn/retro/knowledge-outcomes.ts) folds those per-injection rows
 * against trajectory records, producing per-note KnowledgeNoteOutcomes:
 * how many distinct trajectories the note was injected into (`runs`), how
 * many resolved to a trajectory record (`joined`), and — once a note reaches
 * MIN_KNOWLEDGE_OUTCOME_JOINS joined runs — the sparse exact terminal
 * `outcomes` and deterministic post-merge `realized` tallies (followed-up,
 * reverted, regressed: the same adverse trio the skill-outcome and
 * post-merge sources count). buildLessonsState attaches those tallies to
 * each approved note's `outcomes` field in the Lessons state
 * (GET /api/verse/learning/lessons → knowledge.approved[].outcomes).
 *
 * Until now those tallies only ever reached that one API payload — the
 * Verse Lessons panel renders the causal holdout `trial` line but not
 * `outcomes`, `phm improve lessons` prints only the holdout report, and no
 * CLI folds them — so an approved note whose served runs keep company with
 * merges that did not hold never became work, even though injected lessons
 * are the self-improvement machinery's own memory: every matching launch
 * pays the prompt bytes and the scope-matching risk.
 *
 * knowledgeOutcomeBacklogItems carries the same gated projection into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the skill-outcome, lesson-trial and
 * the other evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The projection is computed by readKnowledgeNoteOutcomes —
 *    the same bounded, gated read buildLessonsState uses — over the
 *    knowledge-runs ledger (~/.ashlr/learn/knowledge-runs.jsonl, a bounded
 *    no-follow tail read) joined to trajectory records through
 *    listTrajectoryJoinQuality; the note corpus is read through
 *    readKnowledge, the same store the Lessons view folds. Nothing is
 *    written and no network is touched.
 *  - Withheld evidence stays quiet. readKnowledgeNoteOutcomes returns null
 *    when the runs log is degraded or truncated, or when the trajectory
 *    join's dispatch/outcome sources are degraded or incomplete — an
 *    unreadable journal cannot be told from "no record", so a null
 *    projection yields no items rather than a guess. Below
 *    MIN_KNOWLEDGE_OUTCOME_JOINS the projection itself withholds
 *    `outcomes`/`realized`, which emit nothing here either.
 *  - Live notes only. A row emits only while its note is still `approved`
 *    in the knowledge store — the state that keeps it eligible for
 *    injection. A pending note was never injected and a rejected note was
 *    already handled, so neither queues work; a note missing from the
 *    store cannot be resolved and never emits. If the knowledge read
 *    itself fails every per-note row withholds.
 *  - Recurring means recorded. A note emits only at
 *    KNOWLEDGE_OUTCOME_ADVERSE_RECURRING adverse realized outcomes
 *    (reverted + regressed + followed-up — the same adverse trio the
 *    skill-outcome feed counts) among its joined runs, the fleet's
 *    RECURRING_FAILURES convention applied to note-attributed post-merge
 *    evidence, so one unlucky merge never queues a session. `realized`
 *    only exists once joined reaches MIN_KNOWLEDGE_OUTCOME_JOINS, so the
 *    sample floor is implied by the bar.
 *  - Fleet machinery only. Knowledge notes and trajectory outcomes
 *    describe this fleet's own injection machinery, so items emit only
 *    for the fleet's own repository ('phantom' last-segment match, the
 *    same rule the sibling machinery feeds apply); self-improvement
 *    pointed at another repository inherits nothing.
 *  - Association, not causation. These are descriptive tallies — the note
 *    was injected into runs that later had these outcomes; unlike the
 *    cloud holdout trial (lesson-trial.ts) nothing here is randomized, so
 *    the prompt frames the tallies as association evidence and names the
 *    machinery to check (scope matching in learn/retro/inject.ts,
 *    injection assembly and the 16 KiB cap, the retro→pending suggestion
 *    pipeline, the run-correlation join itself) with the usual no-change
 *    escape. Approving, editing or rejecting a note is an owner-only
 *    Verse act; agents fix the machinery around the note.
 *  - Dedup is downstream. The item id embeds a stable hash of the note id
 *    (never the counts or timestamps), so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new; shifted tallies
 *    do not spawn twin items, and a note that stops accruing adverse
 *    outcomes simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, the note text is scrubbed and flattened to one
 *    line, and the brief names the projection, the ledgers and the
 *    surfaces that publish it.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readKnowledgeNoteOutcomes } from '../learn/retro/knowledge-outcomes.js';
import { readKnowledge } from '../learn/retro/store.js';
import type { KnowledgeNoteOutcomes, KnowledgeNoteV1 } from '../learn/retro/types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; per-note rows are bounded by the approved-note count. */
export const KNOWLEDGE_OUTCOME_MAX_ITEMS = 8;
const KNOWLEDGE_OUTCOME_ITEM_HARD_MAX = 25;
/**
 * Adverse realized post-merge outcomes one knowledge note needs among its
 * joined trajectories before it counts as recurring — the fleet's
 * RECURRING_FAILURES convention the sibling feeds apply to their own
 * tallies, and the same adverse trio the skill-outcome feed counts.
 */
export const KNOWLEDGE_OUTCOME_ADVERSE_RECURRING = 3;
/**
 * The projection window: seven days, the same recurrence window the sibling
 * feeds anchor on. Realized post-merge outcomes land days after the merge,
 * so the 24-hour Lessons-view default would under-count them; the longer
 * window is what lets the recurring bar mean recurring.
 */
export const KNOWLEDGE_OUTCOME_WINDOW_HOURS = 24 * 7;
/** Trajectory cohort cap passed to the projection read — the same 500 `phm fleet status` folds. */
export const KNOWLEDGE_OUTCOME_RECORD_LIMIT = 500;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: knowledge evidence is this repo's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** The knowledge-runs ledger only ever records note ids in this shape. */
const NOTE_ID_PATTERN = /^kn_[0-9a-f]{16}$/;

export interface KnowledgeOutcomeItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Projection window in hours (default KNOWLEDGE_OUTCOME_WINDOW_HOURS); forwarded to the real read and quoted in prompts. */
  windowHours?: number;
  /** Trajectory cohort cap for the real read (default KNOWLEDGE_OUTCOME_RECORD_LIMIT). */
  recordLimit?: number;
  /** Most items one call emits (default KNOWLEDGE_OUTCOME_MAX_ITEMS, hard-capped). */
  limit?: number;
  /**
   * Injected projection (tests); skips the trajectory read when set. Same
   * contract as readKnowledgeNoteOutcomes: an explicit null means the
   * evidence is withheld (degraded runs log or degraded/incomplete
   * trajectory sources), never zero-filled counts.
   */
  outcomes?: Map<string, KnowledgeNoteOutcomes> | null;
  /**
   * Injected knowledge-store notes (tests); skips the readKnowledge call
   * when set. Used only to gate rows to still-approved notes.
   */
  notes?: readonly KnowledgeNoteV1[];
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const realizedTally = (realized: KnowledgeNoteOutcomes['realized']): { reverted: number; regressed: number; followedUp: number; adverse: number } => {
  const reverted = realized?.reverted ?? 0;
  const regressed = realized?.regressed ?? 0;
  const followedUp = realized?.['followed-up'] ?? 0;
  return { reverted, regressed, followedUp, adverse: reverted + regressed + followedUp };
};

/** Sparse terminal tallies as a stable `key count` list sorted by key. */
function terminalTally(row: KnowledgeNoteOutcomes): string {
  const entries = Object.entries(row.outcomes ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, count]) => `${key} ${count}`).join(', ');
}

const NO_CHANGE = 'If the note was already edited or rejected since this evidence, the projection window has rolled forward, or the right fix is an owner-only act (approving, editing or rejecting a lesson note is a Verse decision only the owner takes) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is the knowledge-note trajectory outcome projection (src/core/learn/retro/knowledge-outcomes.ts, readKnowledgeNoteOutcomes): knowledgeBlockFor/withApprovedKnowledge (src/core/learn/retro/inject.ts) inject approved notes into fleet producer briefs and, because the call carries trajectoryId `run:<attemptId>`, recordKnowledgeRuns appends the injected note ids to ~/.ashlr/learn/knowledge-runs.jsonl; the projection folds those rows against trajectory records (listTrajectoryJoinQuality over the dispatch, outcome and agent-action ledgers) and publishes the tallies on each approved note\'s `outcomes` field in the Lessons state (buildLessonsState → GET /api/verse/learning/lessons → knowledge.approved[].outcomes). `outcomes`/`realized` publish only once a note reaches the join floor, so absent tallies are unknown, never zero.';

function notePrompt(row: KnowledgeNoteOutcomes, note: KnowledgeNoteV1, windowHours: number): string {
  const snippet = fieldText(note.text) || fieldText(note.id, 160);
  const tally = realizedTally(row.realized);
  const terminal = terminalTally(row);
  const terminalText = terminal === '' ? 'no resolved terminal outcomes recorded' : terminal;
  const realizedText = `reverted ${tally.reverted}, regressed ${tally.regressed}, followed-up ${tally.followedUp}`;
  return [
    `Phantom's knowledge-note trajectory outcome projection recorded recurring adverse post-merge outcomes on the fleet trajectories this approved knowledge note was injected into — merges that later reverted, regressed or needed follow-up fixes — the self-improvement work this backlog exists for.`,
    '',
    `Note '${snippet}' (${note.id}, approved, ${note.hits} recorded injections): inside the ${windowHours}-hour window the note was injected into ${row.runs} distinct ${row.runs === 1 ? 'trajectory' : 'trajectories'}, ${row.joined} resolved to trajectory records; terminal outcomes ${terminalText}; deterministic post-merge realized outcomes ${realizedText} (${tally.adverse} adverse).`,
    '',
    EVIDENCE,
    '',
    'These are descriptive tallies, not a causal verdict — the note was present on runs that ended this way, and nothing here is randomized (the causal served-vs-holdout comparison is the cloud lesson trial, src/core/improve/lesson-trial.ts). What is in scope is the machinery around the note: whether learn/retro/inject.ts scope matching (selectKnowledge) applies this note to task kinds where its guidance misleads, whether the injection assembly or the 16 KiB cap (renderKnowledgeBlock) buries or distorts the useful lessons, whether the retro→pending suggestion pipeline keeps proposing notes of this shape, or whether the trajectoryId correlation in recordKnowledgeRuns mis-attributes runs. Fix the cause in this repository\'s lesson machinery. The note itself is owner-decided — approving, editing or rejecting it is a Verse act no agent may take. Run the affected suite. ' + NO_CHANGE,
  ].join('\n');
}

function noteItem(row: KnowledgeNoteOutcomes, note: KnowledgeNoteV1, repo: string, windowHours: number): CloudBacklogItem {
  const snippet = fieldText(note.text) || fieldText(note.id, 160);
  const display = snippet.length > 120 ? `${snippet.slice(0, 119)}…` : snippet;
  const title = `Knowledge note '${display}' keeps landing adverse trajectory outcomes`;
  return {
    id: `knowledge-outcome-${createHash('sha256').update(`knowledge-outcome:${note.id}`).digest('hex').slice(0, 16)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: notePrompt(row, note, windowHours),
    area: 'knowledge-outcomes',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

interface Candidate {
  noteId: string;
  row: KnowledgeNoteOutcomes;
  tally: ReturnType<typeof realizedTally>;
  note: KnowledgeNoteV1;
}

/**
 * Backlog items for approved knowledge notes whose served fleet trajectories
 * keep landing adverse post-merge outcomes. Total: a withheld projection,
 * another repository, a failed note read, or any unexpected failure yields
 * no items rather than throwing into discovery.
 */
export async function knowledgeOutcomeBacklogItems(opts: KnowledgeOutcomeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const windowHours = opts.windowHours ?? KNOWLEDGE_OUTCOME_WINDOW_HOURS;
    const outcomes = opts.outcomes !== undefined
      ? opts.outcomes
      : await readKnowledgeNoteOutcomes({
        windowHours,
        limit: opts.recordLimit ?? KNOWLEDGE_OUTCOME_RECORD_LIMIT,
      });
    // Withheld evidence (degraded runs log, failed trajectory sources) stays quiet.
    if (outcomes === null) return [];

    // First pass over the projection alone: which note ids cross the
    // recurring adverse bar. Notes are read only when something qualifies.
    const qualifying = new Map<string, { row: KnowledgeNoteOutcomes; tally: ReturnType<typeof realizedTally> }>();
    for (const [noteId, row] of outcomes) {
      if (typeof noteId !== 'string' || !NOTE_ID_PATTERN.test(noteId)) continue;
      if (typeof row !== 'object' || row === null) continue;
      if (!Number.isSafeInteger(row.runs) || row.runs < 0 || !Number.isSafeInteger(row.joined) || row.joined < 0) continue;
      const tally = realizedTally(row.realized);
      if (tally.adverse < KNOWLEDGE_OUTCOME_ADVERSE_RECURRING) continue;
      qualifying.set(noteId, { row, tally });
    }
    if (qualifying.size === 0) return [];

    const notes = opts.notes ?? (await readKnowledge().catch(() => null));
    // A failed knowledge read withholds every row: no note can be proven live.
    if (notes === null) return [];
    const byId = new Map(notes.map((n) => [n.id, n]));

    const candidates: Candidate[] = [];
    for (const [noteId, { row, tally }] of qualifying) {
      const note = byId.get(noteId);
      // Live notes only: the note must still be approved — the state that
      // keeps it eligible for injection.
      if (note?.status !== 'approved') continue;
      candidates.push({ noteId, row, tally, note });
    }
    // Strongest recorded evidence first; identity fields last so the order is total.
    candidates.sort((a, b) =>
      b.tally.adverse - a.tally.adverse
      || b.row.joined - a.row.joined
      || a.noteId.localeCompare(b.noteId));
    const limit = Math.max(1, Math.min(opts.limit ?? KNOWLEDGE_OUTCOME_MAX_ITEMS, KNOWLEDGE_OUTCOME_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map(({ row, note }) => noteItem(row, note, repo, windowHours));
  } catch {
    return [];
  }
}
