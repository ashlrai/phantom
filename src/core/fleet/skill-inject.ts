/**
 * skill-inject.ts — active verified-skill prompt injection: the consumption
 * half of the learned-skill loop.
 *
 * The skill pipeline already writes verified cards (skill-library.ts
 * learnFromApplied, gated on realized merge + post-merge credit release +
 * provenance + evidence pack), ranks them (skill-retrieval.ts
 * selectVerifiedSkills — verified status, verified-proposal source,
 * attestation-verified, credit-released, untainted), and measures shadow
 * selections after the fact (skill-shadow-observer.ts). What was missing is
 * the last mile: nothing put a selected card in front of the agent. This
 * module renders the same verified selection into the fleet producer goal
 * and records `active`/`injected` skill-use events, so trajectory outcome
 * attribution measures skills that actually steered a run — not only the
 * shadow association the observe-only path records.
 *
 * Honesty rules carried over from the retrieval/observer path:
 *   - Only selectVerifiedSkills' eligible set can inject: a candidate,
 *     imported, deprecated, revoked, unattested or credit-unreleased card
 *     never reaches a prompt.
 *   - The block is metadata-only (card name + summary, both already scrubbed
 *     and bounded at write time); no diff, prompt, output or reasoning text.
 *   - The whole block is capped (SKILL_GUIDANCE_CAP_BYTES) and a skill that
 *     does not fit whole is left out, never cut mid-line.
 *   - No selection ⇒ the prompt is returned byte-identical, so a fleet with
 *     no eligible cards behaves exactly as before.
 *   - Event recording is best-effort and never throws; a lost event is a
 *     lost observation, never a lost launch.
 */
import type { SkillCard, SkillUseEvent } from '../types.js';
import { recordSkillUseEvent } from './skill-records.js';
import {
  selectVerifiedSkills,
  SKILL_RETRIEVAL_POLICY_VERSION,
  type ShadowSkillSelection,
  type ShadowSkillSummary,
  type SkillRetrievalQuery,
} from './skill-retrieval.js';
import {
  buildSkillUseEvent,
  type StrongSkillAttemptIdentity,
} from './skill-use-identity.js';

/** Hard cap on the rendered guidance block, in UTF-8 bytes. */
export const SKILL_GUIDANCE_CAP_BYTES = 2048;

/** Per-field bound applied while rendering, independent of the card caps. */
const FIELD_MAX_CHARS = 240;

const HEADING = '## Verified learned skills for this task';
const PREAMBLE =
  'These are workflows Phantom verified on merged work and selected for this task. ' +
  'Treat them as guidance; the task above still decides what to change.';

function utf8(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The retrieval query a fleet work item poses — same fields the shadow observer sends. */
export function skillGuidanceQuery(
  item: { title?: string; detail?: string; source?: string; tags?: readonly string[] },
  route?: SkillRetrievalQuery['route'],
): SkillRetrievalQuery {
  return {
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
    ...(item.source !== undefined ? { source: item.source } : {}),
    ...(item.tags !== undefined ? { tags: item.tags } : {}),
    ...(route !== undefined ? { route } : {}),
  };
}

export interface PreparedSkillGuidance {
  /** Rendered markdown block, '' when nothing eligible was selected. */
  block: string;
  /** The verified selection the block was rendered from (empty when none). */
  selection: ShadowSkillSelection;
}

/**
 * Select eligible verified skills for a query and render the guidance block.
 * Pure and never throws; an unreadable selection degrades to an empty block.
 */
export function prepareSkillGuidance(
  cards: readonly SkillCard[] | readonly unknown[] | null | undefined,
  query: SkillRetrievalQuery | null | undefined,
  capBytes: number = SKILL_GUIDANCE_CAP_BYTES,
): PreparedSkillGuidance {
  try {
    const selection = selectVerifiedSkills(cards, query);
    return { block: renderSkillGuidanceBlock(selection.selected, capBytes), selection };
  } catch {
    return { block: '', selection: emptySelection() };
  }
}

function emptySelection(): ShadowSkillSelection {
  return { mode: 'shadow', policyVersion: SKILL_RETRIEVAL_POLICY_VERSION, consideredCount: 0, eligibleCount: 0, selectedSkillIds: [], selected: [] };
}

/**
 * Render selected skills as a bounded markdown block. Skills are included in
 * rank order while each fits whole under the cap; the first that does not fit
 * ends the list (later, lower-ranked skills are never reached).
 */
export function renderSkillGuidanceBlock(
  skills: readonly ShadowSkillSummary[] | null | undefined,
  capBytes: number = SKILL_GUIDANCE_CAP_BYTES,
): string {
  try {
    if (!Array.isArray(skills) || skills.length === 0) return '';
    const header = `${HEADING}\n${PREAMBLE}`;
    const lines: string[] = [];
    let used = utf8(header) + 1;
    for (const skill of skills) {
      const name = oneLine(skill.name, FIELD_MAX_CHARS);
      const summary = oneLine(skill.summary, FIELD_MAX_CHARS);
      if (!name) continue;
      const line = summary ? `- ${name}: ${summary}` : `- ${name}`;
      const cost = utf8(line) + 1;
      if (used + cost > capBytes) break;
      lines.push(line);
      used += cost;
    }
    if (lines.length === 0) return '';
    return `${header}\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * Append rendered skill guidance to a prompt and record one `active`/
 * `injected` skill-use event per selected skill against the dispatch
 * identity. No selection ⇒ the prompt returns byte-identical. Recording is
 * fire-and-forget: a persistence failure never blocks or alters the launch.
 */
export function withVerifiedSkillGuidance(
  prompt: string,
  item: { title?: string; detail?: string; source?: string; tags?: readonly string[] },
  cards: readonly SkillCard[] | readonly unknown[] | null | undefined,
  runId: string,
  opts: {
    route?: SkillRetrievalQuery['route'];
    trajectoryId?: string;
    proposalId?: string;
    selectedAt?: string;
    record?: boolean;
    capBytes?: number;
  } = {},
): string {
  try {
    const prepared = prepareSkillGuidance(cards, skillGuidanceQuery(item, opts.route), opts.capBytes);
    if (!prepared.block) return prompt;
    const withBlock = `${prompt}\n\n${prepared.block}`;
    if (opts.record !== false) {
      recordSkillInjections(prepared.selection.selected, {
        trajectoryId: opts.trajectoryId ?? `run:${runId}`,
        runId,
        ...(opts.proposalId !== undefined ? { proposalId: opts.proposalId } : {}),
      }, opts.selectedAt ?? new Date().toISOString(), opts.route);
    }
    return withBlock;
  } catch {
    return prompt;
  }
}

/**
 * Record `active`/`injected` events for skills actually rendered into a
 * prompt. Never throws; malformed selections contribute no events.
 */
export function recordSkillInjections(
  skills: readonly ShadowSkillSummary[] | null | undefined,
  identity: StrongSkillAttemptIdentity,
  selectedAt: string,
  route?: SkillRetrievalQuery['route'],
): void {
  try {
    if (!Array.isArray(skills) || skills.length === 0) return;
    const events: SkillUseEvent[] = [];
    const routePick = {
      backend: route?.backend ?? null,
      tier: route?.tier ?? null,
      model: route?.model ?? null,
    };
    for (const skill of skills) {
      const event = buildSkillUseEvent({
        identity,
        selectedAt,
        skill: {
          skillId: skill.skillId,
          revision: skill.revision,
          contentHash: skill.contentHash,
          rank: skill.rank,
          score: skill.score,
        },
        route: routePick,
        mode: 'active',
        stage: 'injected',
      });
      if (event) events.push(event);
    }
    if (events.length > 0) recordSkillUseEvent(events);
  } catch { /* best-effort — a lost event is a lost observation */ }
}
