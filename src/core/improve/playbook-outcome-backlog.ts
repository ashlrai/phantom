/**
 * Playbook-version trajectory outcome tallies → self-improvement backlog items.
 *
 * When a fleet task, cloud task or Devin launch runs under a playbook,
 * the exact version it ran under is recorded: fleet dispatches append
 * runId → playbook@version to ~/.ashlr/playbooks/uses.jsonl
 * (recordPlaybookUse, src/core/playbooks/store.ts) which the learn/retro
 * sweep joins onto the task's retro by lane:key, and cloud/Devin task
 * records carry `playbookRef` from playbookForLaunch
 * (src/core/playbooks/lanes.ts) directly. Every ended run then leaves a
 * RetroV1 under ~/.ashlr/learn/retro/retros/ whose `playbookRef` names
 * the immutable version, and countPlaybookOutcomes
 * (src/core/playbooks/stats.ts) folds those refs into the per-version
 * {merged, refused, reverted, failed, total} buckets `phm playbook show`
 * prints and the playbooks API serves on the version list.
 *
 * Until now those tallies only ever reached `phm playbook show` and
 * GET playbook detail — reports someone had to run and read — so a
 * playbook version whose runs kept being reverted or failed never became
 * work, even though playbooks are the self-improvement machinery's own
 * reusable procedure memory: every matching launch pays the injected
 * prompt bytes (up to PLAYBOOK_INJECT_CAP_BYTES) and the version's
 * instructions shape the run's whole trajectory.
 *
 * playbookOutcomeBacklogItems carries the same projection into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling evidence sources.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The fold reads listRetros (the bounded newest-500
 *    ended-run store) and listLatestPlaybooks (built-ins plus the
 *    on-disk index) and counts with the canonical
 *    countPlaybookOutcomes bucketing. Nothing is written and no
 *    network is touched.
 *  - Live playbooks only. A row emits only while its playbook id still
 *    resolves — built-ins are always live, disk playbooks only while
 *    the id remains in the store. A deleted playbook's history is moot
 *    and queues nothing; an unresolvable id cannot be proven live and
 *    never emits.
 *  - Recurring means recorded. A version emits only at
 *    PLAYBOOK_OUTCOME_ADVERSE_RECURRING adverse runs (reverted + failed —
 *    the buckets countPlaybookOutcomes keeps separate from merged and
 *    refused) across at least PLAYBOOK_OUTCOME_ADVERSE_DAYS distinct UTC
 *    days inside the 7-day window, the fleet's RECURRING_FAILURES
 *    convention applied to version-attributed end states, so one
 *    unlucky run never queues a session. `refused` (gate-refused,
 *    owner-laned, closed, vetoed) is reported in the tally but never
 *    counts toward the bar — those end states are gate and owner
 *    decisions, not evidence about the version's instructions.
 *  - Bounded reads stay honest. listRetros returns the newest
 *    MAX_RETROS ended runs; when every retained retro lands inside the
 *    window the tallies are lower bounds and the prompt says so.
 *    Malformed playbookRef shapes, unparseable endedAt rows and
 *    endedAt stamps beyond the evaluation time plus the sibling feeds'
 *    one-minute future skew never reach a cell.
 *  - Fleet machinery only. Playbooks and trajectory outcomes describe
 *    this install's procedure memory, so items emit only for the
 *    fleet's own repository ('phantom' last-segment match, the same
 *    rule the sibling machinery feeds apply); self-improvement pointed
 *    at another repository inherits nothing.
 *  - Association, not causation. These are descriptive tallies — the
 *    version was attached to runs that ended this way; nothing here is
 *    randomized, so the prompt frames the tallies as association
 *    evidence and names the machinery to check (the uses.jsonl
 *    lane:key join in the retro sweep, playbookRef resolution and
 *    version pinning in resolve.ts, the injection cap, the failure
 *    itself) with the usual no-change escape. Editing a disk playbook
 *    is `phm playbook edit` on the host and editing a built-in is a
 *    change to src/core/playbooks/builtins.ts in this repository;
 *    agents fix the machinery and name host-side acts.
 *  - Dedup is downstream. The item id embeds a stable hash of the
 *    playbook id and version (never the counts or timestamps), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds
 *    only what is new; shifted tallies do not spawn twin items, and a
 *    version that stops accruing adverse outcomes simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the playbook name and macro are scrubbed
 *    and flattened to one line, and the brief names the store, the
 *    join and the surfaces that publish the tallies.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { listRetros, MAX_RETROS } from '../learn/retro/store.js';
import type { RetroV1 } from '../learn/retro/types.js';
import { listLatestPlaybooks } from '../playbooks/store.js';
import { countPlaybookOutcomes } from '../playbooks/stats.js';
import { PLAYBOOK_ID_PATTERN, type PlaybookOutcomeCounts, type PlaybookV1 } from '../playbooks/types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; per-version rows are bounded by playbook count × versions in use. */
export const PLAYBOOK_OUTCOME_MAX_ITEMS = 8;
const PLAYBOOK_OUTCOME_ITEM_HARD_MAX = 25;
/**
 * Adverse ended runs one playbook version needs inside the window before
 * it counts as recurring — the fleet's RECURRING_FAILURES convention the
 * sibling feeds apply to their own tallies: reverted plus the failed
 * bucket (verify-failed, failed, expired), exactly the adverse side of
 * the countPlaybookOutcomes split.
 */
export const PLAYBOOK_OUTCOME_ADVERSE_RECURRING = 3;
/** Distinct UTC days those adverse runs must span — one bad day is not a pattern. */
export const PLAYBOOK_OUTCOME_ADVERSE_DAYS = 2;
/**
 * The projection window: seven days, the same recurrence window the
 * sibling feeds anchor on. Ended runs are sparse evidence — a version
 * may see a handful of dispatches a week — so the longer window is what
 * lets the recurring bar mean recurring.
 */
export const PLAYBOOK_OUTCOME_WINDOW_HOURS = 24 * 7;
/**
 * Future-skew ceiling on retro endedAt, the sibling feeds' one-minute
 * tolerance for same-host clock drift: a retro stamped further ahead than
 * this is corrupt or replayed evidence and never reaches a tally — the
 * same bound every other windowed backlog fold applies to its journal
 * timestamps.
 */
export const PLAYBOOK_OUTCOME_FUTURE_SKEW_MS = 60_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: playbook evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** End kinds countPlaybookOutcomes buckets as `failed`; reverted is the other adverse side. */
const ADVERSE_END_KINDS: ReadonlySet<string> = new Set(['reverted', 'verify-failed', 'failed', 'expired']);

export interface PlaybookOutcomeItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Projection window in hours (default PLAYBOOK_OUTCOME_WINDOW_HOURS); quoted in prompts. */
  windowHours?: number;
  /** Most items one call emits (default PLAYBOOK_OUTCOME_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evaluation instant in epoch ms (default Date.now()); window anchor for tests. */
  now?: number;
  /**
   * Injected retro rows (tests); skips the listRetros read when set.
   * Same contract as the store's bounded read: the fold sees only what
   * it is given, and the truncation note derives from the row count.
   */
  retros?: readonly RetroV1[];
  /**
   * Injected live playbook set (tests); skips the listLatestPlaybooks
   * read when set. Used only to gate rows to still-resolvable playbooks.
   */
  playbooks?: readonly PlaybookV1[];
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** UTC day bucket for an endedAt stamp; null when the stamp does not parse. */
function utcDay(endedAt: string): string | null {
  const ms = Date.parse(endedAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

interface Candidate {
  playbook: PlaybookV1;
  version: number;
  counts: PlaybookOutcomeCounts;
  adverse: number;
  adverseDays: number;
  windowTruncated: boolean;
}

const NO_CHANGE = 'If the version was superseded and nothing still pins it, the failures are task-side rather than playbook-side, the retro attribution is recording the wrong ref, or the right fix is a host-side act only the operator can take (`phm playbook edit` on a disk playbook, a built-in change is this repository\'s own) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is the learn/retro store\'s ended-run records (~/.ashlr/learn/retro/retros/rt_*.json, read through listRetros — the newest 500 bounded) folded by countPlaybookOutcomes (src/core/playbooks/stats.ts) into the per-version {merged, refused, reverted, failed, total} buckets — the same tallies `phm playbook show` prints per version and the playbooks API serves. playbookRef lands on a retro two ways: fleet dispatches record runId → playbook@version in ~/.ashlr/playbooks/uses.jsonl (recordPlaybookUse, joined by the retro sweep\'s lane:key lookup in src/core/learn/retro/sweep.ts) and cloud/Devin task records carry playbookRef from playbookForLaunch (src/core/playbooks/lanes.ts). Until this feed those tallies only reached `phm playbook show` and the playbook detail payload — reports someone had to run and read — so a version whose runs kept being reverted or failing never became work.';

function playbookPrompt(c: Candidate, windowHours: number): string {
  const name = fieldText(c.playbook.meta.name) || fieldText(c.playbook.meta.id, 160);
  const macro = fieldText(c.playbook.meta.macro, 48);
  const macroText = macro !== '' ? `, ${macro}` : '';
  const bound = c.windowTruncated
    ? ` The retro store keeps only the newest ${MAX_RETROS} ended runs and every retained row landed inside the window, so these tallies are lower bounds — older in-window runs may exist beyond the bound.`
    : '';
  return [
    `Phantom's ended-run retros keep recording adverse outcomes for tasks that ran under playbook '${name}' version ${c.version} — runs later reverted and runs that failed verification or expired — the self-improvement work this backlog exists for.`,
    '',
    `Playbook '${name}' (${c.playbook.meta.id}${macroText} · v${c.version}): inside the ${windowHours}-hour window ${c.counts.total} ended ${c.counts.total === 1 ? 'run' : 'runs'} recorded this exact version — merged ${c.counts.merged}, reverted ${c.counts.reverted}, failed ${c.counts.failed} (verify-failed/failed/expired), refused-or-gated ${c.counts.refused}; ${c.adverse} adverse across ${c.adverseDays} distinct UTC day(s).${bound}`,
    '',
    EVIDENCE,
    '',
    `These are descriptive tallies, not a causal verdict — the version was attached to runs that ended this way, and nothing here is randomized. What is in scope is the machinery around the version: whether this version is still the one dispatches resolve (an unpinned !macro or auto-match renders the latest version while !macro@vN / id@vN pins keep this one alive — ` + '`phm playbook list`' + ` and ` + '`phm playbook show ' + c.playbook.meta.id + '`' + ` are the first reads), whether the uses.jsonl lane:key join in the retro sweep mis-attributes refs, whether resolve.ts version pinning keeps handing out a version whose sections no longer fit, whether the PLAYBOOK_INJECT_CAP_BYTES injection cap truncates the checks that would have caught the failures, or whether the end states are task-side and the playbook incidental. A disk playbook's content lives under ~/.ashlr/playbooks — ` + '`phm playbook edit`' + ` on the host writes the next version; a built-in's source is src/core/playbooks/builtins.ts in this repository. Fix the cause in this repository's playbook and retro machinery. Run the affected suite. ` + NO_CHANGE,
  ].join('\n');
}

function playbookItem(c: Candidate, repo: string, windowHours: number): CloudBacklogItem {
  const name = fieldText(c.playbook.meta.name) || fieldText(c.playbook.meta.id, 160);
  const display = name.length > 80 ? `${name.slice(0, 79)}…` : name;
  const title = `Playbook '${display}' v${c.version} keeps landing reverted or failed runs`;
  return {
    id: `playbook-outcome-${createHash('sha256').update(`playbook-outcome:${c.playbook.meta.id}@${c.version}`).digest('hex').slice(0, 16)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: playbookPrompt(c, windowHours),
    area: 'playbook-outcomes',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for live playbook versions whose ended runs inside the
 * window keep landing reverted or failed outcomes. Total: a failed
 * playbook or retro read, another repository, or any unexpected failure
 * yields no items rather than throwing into discovery.
 */
export async function playbookOutcomeBacklogItems(opts: PlaybookOutcomeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const windowHours = opts.windowHours ?? PLAYBOOK_OUTCOME_WINDOW_HOURS;
    const now = opts.now ?? Date.now();
    const windowStart = now - windowHours * 60 * 60 * 1000;

    const playbooks = opts.playbooks !== undefined
      ? opts.playbooks
      : await listLatestPlaybooks().catch(() => null);
    // A failed playbook read withholds every row: no id can be proven live.
    if (playbooks === null) return [];
    const live = new Map(playbooks.map((pb) => [pb.meta.id, pb]));

    const retros = opts.retros !== undefined ? opts.retros : await listRetros();

    // In-window rows carrying a well-formed playbookRef, grouped per
    // id@version. Rows for ids the store no longer resolves are dropped
    // here — they can never emit.
    const cells = new Map<string, { rows: RetroV1[]; adverseDays: Set<string> }>();
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const retro of retros) {
      const endedMs = Date.parse(retro.endedAt);
      if (!Number.isFinite(endedMs)) continue;
      if (endedMs < oldestMs) oldestMs = endedMs;
      if (endedMs < windowStart || endedMs > now + PLAYBOOK_OUTCOME_FUTURE_SKEW_MS) continue;
      const ref = retro.playbookRef;
      if (!ref || typeof ref.id !== 'string' || !PLAYBOOK_ID_PATTERN.test(ref.id)) continue;
      if (!live.has(ref.id)) continue;
      if (!Number.isSafeInteger(ref.version) || ref.version < 1) continue;
      const key = `${ref.id}@${ref.version}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = { rows: [], adverseDays: new Set() };
        cells.set(key, cell);
      }
      cell.rows.push(retro);
      if (typeof retro.endKind === 'string' && ADVERSE_END_KINDS.has(retro.endKind)) {
        const day = utcDay(retro.endedAt);
        if (day !== null) cell.adverseDays.add(day);
      }
    }
    if (cells.size === 0) return [];
    // listRetros returns the newest MAX_RETROS ended runs; when the
    // oldest retained row still lands inside the window, in-window runs
    // beyond the bound may exist and every tally is a lower bound.
    const windowTruncated = retros.length >= MAX_RETROS && Number.isFinite(oldestMs) && oldestMs >= windowStart;

    const candidates: Candidate[] = [];
    for (const [key, cell] of cells) {
      const at = key.lastIndexOf('@');
      const playbookId = key.slice(0, at);
      const version = Number(key.slice(at + 1));
      const playbook = live.get(playbookId);
      if (!playbook) continue;
      // Canonical bucketing — the same counts `phm playbook show` prints.
      const counts = countPlaybookOutcomes(cell.rows, playbookId).get(version);
      if (!counts) continue;
      const adverse = counts.reverted + counts.failed;
      if (adverse < PLAYBOOK_OUTCOME_ADVERSE_RECURRING) continue;
      if (cell.adverseDays.size < PLAYBOOK_OUTCOME_ADVERSE_DAYS) continue;
      candidates.push({ playbook, version, counts, adverse, adverseDays: cell.adverseDays.size, windowTruncated });
    }
    // Strongest recorded evidence first; identity fields last so the order is total.
    candidates.sort((a, b) =>
      b.adverse - a.adverse
      || b.counts.total - a.counts.total
      || a.playbook.meta.id.localeCompare(b.playbook.meta.id)
      || a.version - b.version);
    const limit = Math.max(1, Math.min(opts.limit ?? PLAYBOOK_OUTCOME_MAX_ITEMS, PLAYBOOK_OUTCOME_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((c) => playbookItem(c, repo, windowHours));
  } catch {
    return [];
  }
}
