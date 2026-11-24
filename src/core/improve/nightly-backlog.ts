/**
 * Nightly retro proposals → self-improvement backlog items.
 *
 * The nightly local retro (src/core/learn/retro/nightly.ts, gated by
 * foundry.selfImprove) mines fleet, cloud and Devin job/review records into
 * priors, lessons and proposals persisted to ~/.ashlr/learn/retro-proposals.json
 * marked advisoryOnly. Until now the only reader was `phm improve nightly`, a
 * report someone had to run — the mined recurring-failure findings never
 * became work. nightlyLearningBacklogItems folds the validated proposals into
 * CloudBacklogItems for discoverBacklog, so `phm improve discover` and the
 * scheduler's autoDiscover queue them exactly like the fleet outcome-learning
 * source beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only through the canonical validated reader (readNightlyState):
 *    missing state yields no items; corrupt or unsafe state throws, which
 *    this function treats as no items — never a fabricated pattern.
 *  - Bounded: at most `limit` items (default NIGHTLY_LEARNING_MAX_ITEMS,
 *    hard-capped), ranked by the lesson's recorded evidence count so the
 *    most-observed recurring findings win the cap.
 *  - Repo matching is exact owner/repo, case-insensitive: nightly records
 *    always carry owner/repo and the backlog addresses owner/name, so a
 *    lesson for another repository never lands on this one.
 *  - Dedup is downstream. The item id embeds a stable hash of the proposal
 *    id (which itself derives from the lesson's repo/playbook/cause key), so
 *    a refresh re-derives the same id and appendUserBacklogItems adds only
 *    what is new; a lesson gaining evidence does not spawn a twin item.
 *  - Every emitted prompt keeps the proposal's own advisory framing ("grants
 *    no execution or publication authority") and names the record ids to
 *    inspect, capped so one prompt stays bounded.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import type { NightlyCause, NightlyLesson, NightlyProposal } from '../learn/retro/nightly-types.js';

/** Items one call may emit; the proposal list is bounded by the state reader but unbounded in practice. */
export const NIGHTLY_LEARNING_MAX_ITEMS = 8;
const NIGHTLY_LEARNING_ITEM_HARD_MAX = 25;
/** Evidence references named inside one item prompt before the remainder is summarized. */
const PROMPT_EVIDENCE_MAX = 10;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;

const NIGHTLY_CAUSES: ReadonlySet<string> = new Set<NightlyCause>(['verification', 'scope', 'safety', 'review', 'execution']);

export interface NightlyLearningItemsOptions {
  /** Backlog target in owner/name form; nightly proposals must name the same repository. */
  repo: string;
  /** Most items one call emits (default NIGHTLY_LEARNING_MAX_ITEMS, hard-capped). */
  limit?: number;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** The proposal fields the item consumes, or null when the record is not one. */
function proposalRecord(value: unknown): NightlyProposal | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (!isText(r['id']) || !isText(r['repo']) || !isText(r['lessonId']) || !isText(r['prompt'])) return null;
  if (!isText(r['evaluation']) || !isText(r['metric']) || !isText(r['title'])) return null;
  return value as NightlyProposal;
}

/** The lesson fields the item consumes, or null when the record is not one. */
function lessonRecord(value: unknown): NightlyLesson | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const cause = r['cause'];
  if (!isText(r['id']) || !isText(r['repo']) || !isText(cause)) return null;
  if (!NIGHTLY_CAUSES.has(cause)) return null;
  if (r['playbook'] !== null && r['playbook'] !== undefined && !isText(r['playbook'])) return null;
  if (!Array.isArray(r['evidence']) || !r['evidence'].every((e) => typeof e === 'string')) return null;
  return value as NightlyLesson;
}

function nightlyItem(proposal: NightlyProposal, lesson: NightlyLesson, repo: string): CloudBacklogItem {
  const cause = lesson.cause;
  const playbook = lesson.playbook ?? '';
  const title = `Recurring ${cause} findings${playbook === '' ? '' : ` (${playbook})`} on ${repo}`.slice(0, MAX_TITLE_CHARS);
  const shown = lesson.evidence.slice(0, PROMPT_EVIDENCE_MAX);
  const evidenceLine = lesson.evidence.length === 0
    ? 'none recorded'
    : `${shown.join(', ')}${lesson.evidence.length > shown.length ? `, … and ${lesson.evidence.length - shown.length} more` : ''}`;
  const prompt = [
    `Phantom's nightly self-improvement review mined recurring ${cause} findings from its own fleet, cloud and Devin job records — the self-improvement work this backlog exists for.`,
    '',
    proposal.prompt,
    '',
    `Evidence references: ${evidenceLine}`,
    '',
    `Evaluation: ${proposal.evaluation}`,
    `Metric to move: ${proposal.metric}`,
    '',
    'The references are record ids in the local learn store (retro-proposals.json): inspect the referenced jobs and review blocks before changing anything. If the pattern no longer reproduces on the default branch, report no-change and name the evidence.',
  ].join('\n');
  return {
    id: `nightly-${createHash('sha256').update(proposal.id).digest('hex').slice(0, 16)}`,
    title,
    prompt,
    area: `nightly-${cause}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the nightly retro's proposals on `repo`, strongest
 * evidence first. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function nightlyLearningBacklogItems(opts: NightlyLearningItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    const { readNightlyState } = await import('../learn/retro/store.js');
    const state = await readNightlyState();
    if (state === null) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? NIGHTLY_LEARNING_MAX_ITEMS, NIGHTLY_LEARNING_ITEM_HARD_MAX));
    const lessons = new Map<string, NightlyLesson>();
    for (const raw of state.lessons) {
      const lesson = lessonRecord(raw);
      if (lesson !== null) lessons.set(lesson.id, lesson);
    }
    const rows: { proposal: NightlyProposal; lesson: NightlyLesson }[] = [];
    for (const raw of state.proposals) {
      const proposal = proposalRecord(raw);
      if (proposal === null || proposal.repo.toLowerCase() !== repo.toLowerCase()) continue;
      const lesson = lessons.get(proposal.lessonId);
      if (lesson === undefined || lesson.repo.toLowerCase() !== proposal.repo.toLowerCase()) continue;
      rows.push({ proposal, lesson });
    }
    rows.sort((a, b) => b.lesson.evidence.length - a.lesson.evidence.length || a.proposal.id.localeCompare(b.proposal.id));
    return rows.slice(0, limit).map(({ proposal, lesson }) => nightlyItem(proposal, lesson, repo));
  } catch {
    return [];
  }
}
