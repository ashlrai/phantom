/**
 * Cloud lesson holdout trial verdicts → self-improvement backlog items.
 *
 * Phantom runs a randomized holdout on cloud launches (improve/lesson-trial.ts):
 * a task eligible for lessons is hash-assigned to `served` (the lessons block
 * is injected) or `holdout` (the same prompt without it), and the trial
 * compares landing rates between the arms — overall and per knowledge note.
 * The verdicts were computed read-time and published only through
 * `phm improve lessons`, the Verse Lessons view's `knowledge.trial` and each
 * approved note's `trial` field — reports someone had to run and read. A
 * lesson whose holdout arm keeps landing better never became work even
 * though lesson injection is the self-improvement machinery's own memory:
 * every served run pays the prompt bytes and the scope-matching risk, so a
 * measured negative effect is exactly the evidence this backlog exists to
 * turn into a fix.
 *
 * lessonTrialBacklogItems carries the same computation into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it exactly
 * like the skill-outcome, post-merge, nightly retro and the other evidence
 * sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The trial is computed by lessonTrial over the same bounded
 *    cloud-task read `phm improve lessons` uses
 *    (listCloudTasks(Number.MAX_SAFE_INTEGER)) joined to the revert set
 *    revertedPrKeys derives from the outcome ledger, cloud task outcomes and
 *    the standing revert ledger; note statuses come from readKnowledge, the
 *    same store the Lessons view folds. Nothing is written and no network is
 *    touched.
 *  - Withheld evidence stays quiet. lessonTrialState's contract applies: a
 *    task-store or ledger read failure yields a null trial and no items —
 *    never a guessed verdict. Below MIN_ARM_TASKS per arm the trial itself
 *    reports 'unknown', which emits nothing.
 *  - Only the adverse verdict emits. 'helps' needs no work, and
 *    'no-difference' is the trial's expected null — the 95% interval
 *    containing zero is not evidence of harm. 'hurts' means the interval
 *    excludes zero on the negative side: served runs landed measurably
 *    worse than the holdout that ran the identical prompt without lessons.
 *  - Live notes only. A per-note row emits only while its note is still
 *    `approved` in the knowledge store — the state that keeps it eligible
 *    for injection. A rejected note was already handled and a pending note
 *    was never injected (it cannot accrue trial runs), so neither queues
 *    work; a note missing from the store cannot be resolved and never
 *    emits. If the knowledge read itself fails the per-note rows withhold
 *    while the overall verdict — which needs no note lookup — still emits.
 *  - Fleet machinery only. Lessons and the holdout describe this fleet's
 *    own cloud runs, so items emit only for the fleet's own repository
 *    ('phantom' last-segment match, the same rule the sibling machinery
 *    feeds apply); self-improvement pointed at another repository inherits
 *    nothing.
 *  - Causal framing stays honest. The holdout is randomized per task id, so
 *    the effect is a real comparison — but the prompt still quotes only the
 *    recorded arm tallies, delta and interval, and names the machinery to
 *    check (scope matching in learn/retro/inject.ts, injection assembly and
 *    cap, the retro→pending suggestion pipeline, arm assignment) with the
 *    usual no-change escape. Approving, editing or rejecting a note is an
 *    owner-only Verse act; agents fix the machinery around the note.
 *  - Dedup is downstream. The item id embeds a stable hash of the scope
 *    identity (the note id, or 'overall' — never the tallies or verdict),
 *    so a refresh re-derives the same id and appendUserBacklogItems adds
 *    only what is new; shifted rates do not spawn twin items, and a scope
 *    that stops measuring 'hurts' simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: arm counts, rates,
 *    delta and interval are quoted only as recorded, note text is scrubbed
 *    and flattened to one line, and the brief names the trial, the task
 *    store, the reports and the source files.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN, listCloudTasks } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readKnowledge } from '../learn/retro/store.js';
import type { KnowledgeNoteV1 } from '../learn/retro/types.js';
import { pairRepeatedVerifiedFailures, readBestOfNRecordsDetailed, type BestOfNRecord, type RepeatedFailureClass } from '../fleet/best-of-n-ledger.js';
import { lessonHoldoutFraction, lessonTrial, type LessonEffect, type LessonTrialReport } from './lesson-trial.js';
import { revertedPrKeys } from './reverted.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; per-note rows are bounded by the approved-note count. */
export const LESSON_TRIAL_MAX_ITEMS = 8;
const LESSON_TRIAL_ITEM_HARD_MAX = 25;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: lesson evidence is this repo's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** Scope id for the all-notes effect row; byNote rows always carry a note id. */
const OVERALL_SCOPE = 'all';

export interface LessonTrialItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Most items one call emits (default LESSON_TRIAL_MAX_ITEMS, hard-capped). */
  limit?: number;
  /**
   * Injected trial report (tests); skips the cloud-task and revert-ledger
   * reads when set. An explicit null means the evidence is withheld (a
   * store or ledger read failed), never a guessed verdict.
   */
  trial?: LessonTrialReport | null;
  /**
   * Injected knowledge-store notes (tests); skips the readKnowledge call
   * when set. Used only to gate per-note rows to still-approved notes.
   */
  notes?: readonly KnowledgeNoteV1[];
  /** Injected best-of-N records (tests) for proposal-only repeated-failure lessons. */
  bestOfNRecords?: readonly BestOfNRecord[];
}

export interface FailureLessonItemsOptions {
  repo: string;
  records?: readonly BestOfNRecord[];
  minOccurrences?: number;
  limit?: number;
  holdout?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/**
 * The same computation `phm improve lessons` and the Lessons view run:
 * one bounded cloud-task scan feeding both the trial and the revert set,
 * so a merged-then-reverted PR never counts as landed. null = a store or
 * ledger read failed — withheld, never zero-filled.
 */
function readTrial(): LessonTrialReport | null {
  try {
    const tasks = listCloudTasks(Number.MAX_SAFE_INTEGER);
    return lessonTrial(tasks, revertedPrKeys(tasks));
  } catch {
    return null;
  }
}

/** Note statuses for the live-note gate; null = the store read failed. */
async function readNotes(): Promise<KnowledgeNoteV1[] | null> {
  try {
    return await readKnowledge();
  } catch {
    return null;
  }
}

const pct = (rate: number | null): string => (rate === null ? 'n/a' : `${Math.round(rate * 100)}%`);
const pts = (n: number): string => `${n >= 0 ? '+' : ''}${Math.round(n * 100)}`;

function armText(e: LessonEffect): string {
  return `served ${e.served.landed}/${e.served.tasks} landed (${pct(e.served.rate)}), holdout ${e.holdout.landed}/${e.holdout.tasks} landed (${pct(e.holdout.rate)})`;
}

function ciText(e: LessonEffect): string {
  return e.ci95 === null ? 'no interval recorded' : `95% CI ${pts(e.ci95[0])} to ${pts(e.ci95[1])} points`;
}

const EVIDENCE = 'The evidence is the cloud lesson holdout trial (src/core/improve/lesson-trial.ts): at launch each task eligible for lessons is hash-assigned to `served` (lessons injected) or `holdout` (identical prompt without them, src/core/cloud/service.ts via learn/retro/inject.ts), both arms record the applicable note ids on the task file, and a run counts as landed when its PR merged and was not reverted (revertedPrKeys joins the outcome ledger, cloud task outcomes and the standing revert ledger). `phm improve lessons --json` prints the same report and the Verse Lessons view exposes it as knowledge.trial; cloud task files live under ~/.ashlr/cloud/tasks and the knowledge store under ~/.ashlr/learn/retro.';

const NO_CHANGE = 'If the note was already edited or rejected since this evidence, the task store has rolled forward past these runs, or the right fix is an owner-only act (approving, editing or rejecting a lesson note is a Verse decision only the owner takes) — report no-change and name the evidence.';

function notePrompt(e: LessonEffect, note: KnowledgeNoteV1): string {
  const snippet = fieldText(note.text) || fieldText(e.scope, 160);
  return [
    `Phantom's cloud lesson holdout trial measured this approved knowledge note hurting landing rates: among finished cloud tasks where it was in the applicable lessons set, runs served the lessons block landed measurably worse than the randomized holdout that ran the identical prompt without lessons.`,
    '',
    `Note '${snippet}' (${e.scope}, approved, ${note.hits} recorded injections): ${armText(e)}; effect ${e.delta === null ? 'unknown' : `${pts(e.delta)} points`}, ${ciText(e)}, verdict ${e.verdict}.`,
    '',
    EVIDENCE,
    '',
    `The note itself is owner-decided — approving, editing or rejecting it is a Verse act no agent may take. What is in scope is the machinery around it: whether learn/retro/inject.ts scope matching applies this note to task kinds where its guidance misleads, whether the injection assembly or byte cap buries the useful lessons, whether the retro→pending suggestion pipeline keeps proposing notes of this shape, or whether the arm assignment or landing fold in lesson-trial.ts is biased. Check src/core/learn/retro/inject.ts, src/core/improve/lesson-trial.ts and the launch path in src/core/cloud/service.ts, fix the cause in this repository, and run the affected suite. ${NO_CHANGE}`,
  ].join('\n');
}

function overallPrompt(e: LessonEffect, excluded: LessonTrialReport['excluded']): string {
  return [
    `Phantom's cloud lesson holdout trial measured the served arm landing worse than the holdout across every eligible finished cloud task: runs that got the lessons block merged-and-held less often than the randomized holdout that ran the identical prompt without any lessons.`,
    '',
    `Overall: ${armText(e)}; effect ${e.delta === null ? 'unknown' : `${pts(e.delta)} points`}, ${ciText(e)}, verdict ${e.verdict}. Finished eligible runs left out of both arms: ${excluded.launchFailed} launch failures, ${excluded.unfinished} unfinished.`,
    '',
    EVIDENCE,
    '',
    'No single note needs to be at fault — the signal is the feature as a whole. What is in scope is the machinery: whether learn/retro/inject.ts scope matching or the injection assembly and byte cap degrades prompts broadly, whether the approved-note corpus (suggested by the retro pipeline under ~/.ashlr/learn/retro) has drifted to low-value guidance, whether lessonArm assignment or the landed fold in lesson-trial.ts is biased, or whether a small number of notes drive the effect (per-note rows in `phm improve lessons --json` name them). Fix the cause in this repository and run the affected suite. ' + NO_CHANGE,
  ].join('\n');
}

function itemId(scope: string): string {
  return `lesson-trial-${createHash('sha256').update(`lesson-trial:${scope}`).digest('hex').slice(0, 16)}`;
}

function noteItem(e: LessonEffect, note: KnowledgeNoteV1, repo: string): CloudBacklogItem {
  const snippet = fieldText(note.text) || fieldText(e.scope, 160);
  const display = snippet.length > 120 ? `${snippet.slice(0, 119)}…` : snippet;
  return {
    id: itemId(e.scope),
    title: `Cloud lesson '${display}' keeps hurting landing in the holdout trial`.slice(0, MAX_TITLE_CHARS),
    prompt: notePrompt(e, note),
    area: 'lesson-trial',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function overallItem(e: LessonEffect, excluded: LessonTrialReport['excluded'], repo: string): CloudBacklogItem {
  return {
    id: itemId(OVERALL_SCOPE),
    title: 'Cloud lesson holdout: served runs land worse than holdout'.slice(0, MAX_TITLE_CHARS),
    prompt: overallPrompt(e, excluded),
    area: 'lesson-trial',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

interface Candidate {
  effect: LessonEffect;
  note?: KnowledgeNoteV1;
}

/**
 * Backlog items for lesson-trial scopes whose holdout verdict is 'hurts'.
 * Total: a withheld trial, another repository, a failed note read for the
 * per-note rows, or any unexpected failure yields fewer/no items rather
 * than throwing into discovery.
 */
export async function lessonTrialBacklogItems(opts: LessonTrialItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const trial = opts.trial !== undefined ? opts.trial : readTrial();
    // Withheld evidence (store/ledger read failure) stays quiet.
    if (trial === null) return [];

    const candidates: Candidate[] = [];
    if (trial.overall.verdict === 'hurts') candidates.push({ effect: trial.overall });

    const hurting = trial.byNote.filter((e) => e.verdict === 'hurts' && e.scope !== OVERALL_SCOPE);
    if (hurting.length > 0) {
      const notes = opts.notes ?? (await readNotes());
      if (notes !== null) {
        const byId = new Map(notes.map((n) => [n.id, n]));
        for (const e of hurting) {
          const note = byId.get(e.scope);
          // Live notes only: the note must still be approved — the state
          // that keeps it eligible for injection.
          if (note?.status === 'approved') candidates.push({ effect: e, note });
        }
      }
    }

    // The overall machinery signal first, then per-note rows strongest
    // evidence first; identity fields last so the order is total.
    candidates.sort((a, b) => {
      const aOverall = a.effect.scope === OVERALL_SCOPE ? 0 : 1;
      const bOverall = b.effect.scope === OVERALL_SCOPE ? 0 : 1;
      return aOverall - bOverall
        || (a.effect.delta ?? 0) - (b.effect.delta ?? 0)
        || b.effect.served.tasks - a.effect.served.tasks
        || a.effect.scope.localeCompare(b.effect.scope);
    });
    const limit = Math.max(1, Math.min(opts.limit ?? LESSON_TRIAL_MAX_ITEMS, LESSON_TRIAL_ITEM_HARD_MAX));
    const trialItems = candidates.slice(0, limit).map((c) =>
      c.note !== undefined ? noteItem(c.effect, c.note, repo) : overallItem(c.effect, trial.excluded, repo));
    const remaining = limit - trialItems.length;
    return remaining <= 0 ? trialItems : [
      ...trialItems,
      ...failureLessonBacklogItems({ repo, records: opts.bestOfNRecords, limit: Math.min(1, remaining), holdout: trial.holdout }),
    ];
  } catch {
    return [];
  }
}

function failureLessonItem(group: RepeatedFailureClass, repo: string, holdout: number): CloudBacklogItem {
  const cls = fieldText(group.failureClass, 80);
  const examples = group.pairs.slice(0, 3).map((p) =>
    `${fieldText(p.workItemId, 48)}: failed(${fieldText(p.failedEngine, 24)}/${fieldText(p.failedModel ?? 'unknown', 32)}, "${fieldText(p.failureSummary, 64)}") -> verified(${fieldText(p.verifiedEngine, 24)}/${fieldText(p.verifiedModel ?? 'unknown', 32)}, proposal ${fieldText(p.verifiedProposalId, 48)})`).join('; ');
  return {
    id: `lesson-failure-${createHash('sha256').update(`lesson-failure:${group.failureClass}`).digest('hex').slice(0, 16)}`,
    title: `Propose lesson for repeated failure '${cls}' (${group.pairs.length} verified pairs)`.slice(0, MAX_TITLE_CHARS),
    prompt: `Proposal-only lesson candidate (unserved until owner review) from ${group.pairs.length} paired best-of-N tasks sharing repeated failure class '${cls}'.\n\nPaired scrubbed evidence (metadata only, no raw traces): ${examples}.\n\nDraft one bounded, reviewable lesson note for owner approval; leave it unserved until approved, then measure under the current ${Math.round(holdout * 100)}% randomized holdout (src/core/improve/lesson-trial.ts) on fresh tasks. Track human rescue/retry touches per 100 tasks of this class alongside served vs holdout accepted outcomes and cost. ${NO_CHANGE}`,
    area: 'lesson-trial',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** Proposal-only backlog items from repeated verified failure->success pairs; quiet if either artifact is missing or ledger degraded. */
export function failureLessonBacklogItems(opts: FailureLessonItemsOptions): CloudBacklogItem[] {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const records = opts.records ?? (() => {
      const read = readBestOfNRecordsDetailed({ inspectionOnly: true });
      return read.complete ? read.records : [];
    })();
    const groups = pairRepeatedVerifiedFailures(records, opts.minOccurrences ?? 2);
    if (groups.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 1, LESSON_TRIAL_MAX_ITEMS));
    return groups.slice(0, limit).map((g) => failureLessonItem(g, repo, opts.holdout ?? lessonHoldoutFraction()));
  } catch {
    return [];
  }
}
