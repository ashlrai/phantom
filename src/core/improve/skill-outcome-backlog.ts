/**
 * Learned-skill adverse trajectory outcomes → self-improvement backlog items.
 *
 * Phantom's trajectory join (`summarizeTrajectoryLearning`, the fold behind
 * `trajectoryLearning.skillOutcomes` in `phm fleet status --json` and
 * `phm skills list --outcomes`) attributes each production trajectory's
 * resolved terminal outcome and deterministic post-merge realized outcome
 * back to the skill revisions the shadow observer recorded on it. The
 * published per-skill rows count, per (skillId, revision), how many distinct
 * trajectories selected the card and how those trajectories ended — merged,
 * rejected, failed — plus the deterministic post-merge verdicts: reverted,
 * regressed, followed-up. Until now those tallies only ever reached
 * `phm skills list --outcomes` and one line of `phm fleet status`, reports
 * someone had to run and read: a learned skill whose observed selections
 * keep company with merges that did not hold never became work, even though
 * the skill library is the self-improvement machinery's own memory.
 *
 * skillOutcomeBacklogItems carries the same gated projection into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the fleet outcome-learning, nightly
 * retro, policy, local-gate, pass^k, friction, tick-health, cross-review,
 * empty-tag, post-merge, ci-rerun, lost-launch and memory sources beside
 * it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The projection is computed by readSkillTrajectoryOutcomes —
 *    the same bounded, sample-gated read `phm skills list --outcomes` uses —
 *    over the skill-use ledger (~/.ashlr/skills/uses dated jsonl) joined to
 *    the dispatch, outcome, agent-action and post-merge ledgers; the card
 *    corpus is read through readSkillCardCorpus' verified bounded complete
 *    read. Nothing is written and no network is touched.
 *  - Sample-gated evidence only. readSkillTrajectoryOutcomes returns null
 *    when the skill-use ledger is degraded or the trajectory sample gate
 *    has not passed — small samples never publish per-skill counts, so a
 *    null projection yields no items rather than a guess. The card corpus
 *    follows the same healthy-only bar: 'missing' is a clean empty source
 *    (no live cards can exist) and 'degraded' withholds the whole source —
 *    partially corrupt card history cannot prove which revision is live.
 *  - Live revisions only. An outcome row counts only while its exact
 *    (skillId, revision) is still the corpus's newest revision for that
 *    skill and its status is candidate or verified — the card states that
 *    are not already withdrawn. A superseded revision's adverse history is
 *    evidence the fleet already replaced, and a deprecated or revoked card
 *    was already handled; neither queues work. A skillId with no card in a
 *    healthy corpus cannot be resolved to a live revision and never emits.
 *  - Recurring means recorded. A row emits only at
 *    SKILL_OUTCOME_ADVERSE_RECURRING adverse realized outcomes (reverted +
 *    regressed + followed-up — the same adverse trio the post-merge source
 *    counts) inside the projection window, the fleet's RECURRING_FAILURES
 *    convention applied to skill-attributed post-merge evidence, so one
 *    unlucky merge never queues a session.
 *  - Fleet machinery only. Skill cards and trajectory outcomes describe
 *    this fleet's own learned memory, so items emit only for the fleet's
 *    own repository ('phantom' last-segment match, the same rule the
 *    post-merge lane/tier cells and the other machinery feeds apply);
 *    self-improvement pointed at another repository inherits nothing.
 *  - Association, not causation. Skill selections are observe-only shadow
 *    records — the card did not steer those runs — so the prompt frames
 *    the tallies as association evidence and names the machinery to check
 *    (retrieval ranking, nudge drafts, distillation), with the usual
 *    no-change escape when the card is already superseded or withdrawn or
 *    the window no longer reproduces. Skill cards are host-signed ledger
 *    records an agent cannot rewrite; withdrawing one is owner-only.
 *  - Dedup is downstream. The item id embeds a stable hash of the group
 *    identity (skillId + revision — never the counts or timestamps), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds only
 *    what is new; shifted tallies do not spawn twin items, and a card that
 *    stops accruing adverse outcomes simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, the card name and skill id are scrubbed and
 *    flattened to one line, and the brief names the projection, the ledgers
 *    and the report commands with the usual no-change escape.
 */
import { createHash } from 'node:crypto';

import type {
  TrajectorySkillOutcomeRow,
  TrajectorySkillOutcomeSummary,
} from '../autonomy/trajectory-records.js';
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readSkillTrajectoryOutcomes } from '../fleet/skill-outcomes.js';
import {
  readSkillCardCorpus,
  type SkillCardCorpusReadResult,
} from '../fleet/skill-records.js';
import type { SkillCard } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; per-skill rows are bounded upstream but unbounded in practice. */
export const SKILL_OUTCOME_MAX_ITEMS = 8;
const SKILL_OUTCOME_ITEM_HARD_MAX = 25;
/**
 * Adverse realized post-merge outcomes one skill revision needs inside the
 * window before it counts as recurring — the fleet's RECURRING_FAILURES
 * convention the sibling feeds apply to their own tallies.
 */
export const SKILL_OUTCOME_ADVERSE_RECURRING = 3;
/**
 * The projection window: seven days, the same recurrence window the sibling
 * feeds anchor on. Realized post-merge outcomes land days after the merge,
 * so the 24-hour report window `phm skills list --outcomes` uses would
 * under-count them; the longer window is what lets the recurring bar mean
 * recurring.
 */
export const SKILL_OUTCOME_WINDOW_HOURS = 24 * 7;
/** Trajectory cohort cap passed to the projection read — the same 500 `phm fleet status` folds. */
export const SKILL_OUTCOME_RECORD_LIMIT = 500;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
const FLEET_REPO = 'ashlrai/phantom';
/** Ledger-recorded names are unbounded text; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** Card statuses that still describe a live revision; deprecated/revoked cards were already handled. */
const LIVE_STATUSES = new Set<SkillCard['status']>(['candidate', 'verified']);

export interface SkillOutcomeItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Projection window in hours (default SKILL_OUTCOME_WINDOW_HOURS); forwarded to the real read and quoted in prompts. */
  windowHours?: number;
  /** Trajectory cohort cap for the real read (default SKILL_OUTCOME_RECORD_LIMIT). */
  recordLimit?: number;
  /** Most items one call emits (default SKILL_OUTCOME_MAX_ITEMS, hard-capped). */
  limit?: number;
  /**
   * Injected projection (tests); skips the trajectory read when set. Same
   * contract as readSkillTrajectoryOutcomes: an explicit null means the
   * evidence is withheld (degraded ledger or failed sample gate), never
   * zero-filled counts.
   */
  outcomes?: TrajectorySkillOutcomeSummary | null;
  /**
   * Injected card-corpus read (tests); skips the corpus read when set.
   * Same contract as readSkillCardCorpus.
   */
  corpus?: SkillCardCorpusReadResult;
}

/** Ledger-recorded names are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** Newest revision per skillId — the same revision-then-timestamp rule `listSkills` applies. */
function latestCards(cards: readonly SkillCard[]): Map<string, SkillCard> {
  const latest = new Map<string, SkillCard>();
  for (const card of cards) {
    const old = latest.get(card.skillId);
    if (!old || card.revision > old.revision || (card.revision === old.revision && card.ts > old.ts)) {
      latest.set(card.skillId, card);
    }
  }
  return latest;
}

const realizedTally = (row: TrajectorySkillOutcomeRow): { reverted: number; regressed: number; followedUp: number; adverse: number } => {
  const reverted = row.realized?.reverted ?? 0;
  const regressed = row.realized?.regressed ?? 0;
  const followedUp = row.realized?.['followed-up'] ?? 0;
  return { reverted, regressed, followedUp, adverse: reverted + regressed + followedUp };
};

/** Sparse terminal tallies as a stable `key count` list sorted by key. */
function terminalTally(row: TrajectorySkillOutcomeRow): string {
  const entries = Object.entries(row.outcomes)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, count]) => `${key} ${count}`).join(', ');
}

const NO_CHANGE = 'If the card is already superseded or withdrawn, the projection window has rolled forward, or the cause is owner-only (a card withdrawal is a host-signed ledger act only the owner can take) — report no-change and name the evidence.';

function skillOutcomePrompt(row: TrajectorySkillOutcomeRow, card: SkillCard, windowHours: number): string {
  const name = fieldText(card.name) || fieldText(row.skillId, 160);
  const skillId = fieldText(row.skillId, 160);
  const tally = realizedTally(row);
  const terminal = terminalTally(row);
  const terminalText = terminal === '' ? 'no resolved terminal outcomes recorded' : terminal;
  const realizedText = `reverted ${tally.reverted}, regressed ${tally.regressed}, followed-up ${tally.followedUp}`;
  return [
    `Phantom's trajectory outcome projection recorded recurring adverse post-merge outcomes on the production trajectories where learned skill '${name}' (${skillId} revision ${row.skillRevision}, status ${card.status}, source ${card.source}) was observed — merges that later reverted, regressed or needed follow-up fixes — the self-improvement work this backlog exists for.`,
    '',
    `Inside the ${windowHours}-hour window the card was observed on ${row.selections} distinct ${row.selections === 1 ? 'trajectory' : 'trajectories'}: terminal outcomes ${terminalText}; deterministic post-merge realized outcomes ${realizedText} (${tally.adverse} adverse).`,
    '',
    'The evidence is the trajectory-learning projection (`trajectoryLearning.skillOutcomes`, published only after the skill-observation sample gate) over the skill-use ledger (~/.ashlr/skills/uses dated jsonl) joined to the dispatch, outcome, agent-action and post-merge ledgers; `phm skills list --outcomes --json` prints the same per-skill tallies and `phm fleet status --json` exposes trajectoryLearning.skillOutcomes. The card corpus lives under ~/.ashlr/skills/cards (src/core/fleet/skill-records.ts, skill-outcomes.ts; the join is src/core/autonomy/trajectory-records.ts).',
    '',
    'Selections are observe-only records — the card did not steer those runs, so this is association evidence, not proven causation: the pattern this card captures keeps company with work that did not hold. Find out why: check whether the card\'s guidance (name, summary, trigger, steps, taskKinds, commandKinds and tags under ~/.ashlr/skills/cards) is wrong for the task kinds it selects on, whether retrieval ranking (src/core/fleet/skill-retrieval.ts) keeps surfacing it on the wrong work, or whether the nudge drafts (src/core/fleet/skill-nudge.ts) or distillation (src/core/fleet/skill-library.ts) keep re-teaching the failing pattern. Fix the cause in this repository\'s skill machinery. Skill cards are host-signed ledger records an agent cannot rewrite or withdraw; if the right fix is withdrawing or rewriting this card itself, that is owner-only — report no-change and name the evidence. Run the affected suite. ' + NO_CHANGE,
  ].join('\n');
}

function skillOutcomeItem(row: TrajectorySkillOutcomeRow, card: SkillCard, repo: string, windowHours: number): CloudBacklogItem {
  const name = fieldText(card.name) || fieldText(row.skillId, 160);
  const displayName = name.length > 120 ? `${name.slice(0, 119)}…` : name;
  const title = `Learned skill '${displayName}' rev ${row.skillRevision} keeps landing adverse post-merge outcomes`;
  const id = `skill-outcome-${createHash('sha256').update(`skill-outcome:${row.skillId}:${row.skillRevision}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: skillOutcomePrompt(row, card, windowHours),
    area: 'skill-outcomes',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

interface LiveRow {
  row: TrajectorySkillOutcomeRow;
  card: SkillCard;
  tally: ReturnType<typeof realizedTally>;
}

/**
 * Backlog items for learned-skill revisions whose observed trajectory
 * selections keep landing adverse post-merge outcomes. Total: a withheld
 * projection, an untrusted corpus, another repository or any read failure
 * yields no items rather than throwing into discovery.
 */
export async function skillOutcomeBacklogItems(opts: SkillOutcomeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    const repoKey = repo.toLowerCase();
    if (repoKey !== FLEET_REPO && repoKey !== 'phantom') return [];
    const windowHours = opts.windowHours ?? SKILL_OUTCOME_WINDOW_HOURS;
    const outcomes = opts.outcomes !== undefined
      ? opts.outcomes
      : readSkillTrajectoryOutcomes({ windowHours, limit: opts.recordLimit ?? SKILL_OUTCOME_RECORD_LIMIT });
    // Withheld evidence (degraded ledger, failed sample gate) stays quiet.
    if (outcomes === null) return [];
    const corpus = opts.corpus ?? readSkillCardCorpus();
    // Healthy-only evidence bar: 'missing' is a clean empty corpus (no live
    // card can exist), 'degraded' means the revision/status fold cannot be
    // trusted — both yield no items rather than guessing which cards live.
    if (corpus.sourceState !== 'healthy') return [];
    const latest = latestCards(corpus.cards);

    const candidates: LiveRow[] = [];
    for (const row of outcomes.perSkill) {
      if (typeof row.skillId !== 'string' || row.skillId === '' || !Number.isSafeInteger(row.skillRevision) || row.skillRevision < 1) continue;
      const tally = realizedTally(row);
      if (tally.adverse < SKILL_OUTCOME_ADVERSE_RECURRING) continue;
      const card = latest.get(row.skillId);
      // Live revisions only: the exact observed revision must still be the
      // newest card and not already withdrawn.
      if (!card || card.revision !== row.skillRevision || !LIVE_STATUSES.has(card.status)) continue;
      candidates.push({ row, card, tally });
    }
    // Strongest recorded evidence first; identity fields last so the order is total.
    candidates.sort((a, b) =>
      b.tally.adverse - a.tally.adverse
      || b.row.selections - a.row.selections
      || a.row.skillId.localeCompare(b.row.skillId)
      || a.row.skillRevision - b.row.skillRevision);
    const limit = Math.max(1, Math.min(opts.limit ?? SKILL_OUTCOME_MAX_ITEMS, SKILL_OUTCOME_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map(({ row, card }) => skillOutcomeItem(row, card, repo, windowHours));
  } catch {
    return [];
  }
}
