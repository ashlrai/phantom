/**
 * InferenceGateway shadow journal recurring divergence → self-improvement
 * backlog items.
 *
 * When `foundry.fabric.gatewayShadow` is on (and `fabric.gateway` is not
 * already), the daemon's dispatch path runs the M247 InferenceGateway
 * BESIDE the live legacy routing decision — observe-only, the legacy
 * result always wins — and appends one record per shadowed dispatch to
 * `<home>/.ashlr/fabric/gateway-shadow-<UTC-day>.jsonl` through
 * recordGatewayShadow (src/core/fabric/gateway-shadow.ts, called from the
 * daemon loop's shadowGateway). Each row carries the legacy outcome
 * (backend, tier, model, dispatched), the gateway's would-be outcome
 * (backend, tier, model, wouldDispatch) and the two verdicts
 * compareDecisions derives: `diverged` (backend, model or dispatch
 * verdict differs) and `safetyRelevant` (the gateway would have
 * dispatched an item the legacy path blocked on throttle, budget or
 * resource pause).
 *
 * divergenceStats() encodes the CONTRACT-M334 stage-2 exit criteria —
 * at least 200 shadowed decisions, under 2% divergence and ZERO
 * safety-relevant divergences before the gateway may replace the legacy
 * path — but nothing calls it: the journal was write-only evidence, and
 * a shadow that kept disagreeing with legacy, or kept
 * would-dispatching work the legacy path deliberately blocked, never
 * became work — the flip decision had no instrument feeding it and a
 * latent safety regression sat in a file no report reads.
 *
 * gatewayShadowBacklogItems carries the same journal into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling fleet-evidence sources beside it. Two evidence
 * kinds cover the windowed recurrence above; a third evaluates the
 * stage-2 exit criteria over the FULL journal — every
 * gateway-shadow-*.jsonl day-file, not just the 7-day window — so the
 * soak's verdict reaches the backlog: a journal that clears the bar
 * queues the stage-3 gateway default flip, and a journal with enough
 * decisions whose cumulative record fails the bar surfaces the blocker
 * the window cannot see (an old safety-relevant row or an all-time rate
 * over tolerance still bars the flip forever — the journal is
 * append-only and the contract's counters never reset).
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The per-day files are listed and tail-read through
 *    readTail's bounded no-follow read (the last 4 MiB per file, only
 *    files whose UTC day can hold in-window rows); nothing is written
 *    and no network is touched. A missing or unreadable fabric dir
 *    yields no items — shadow off and shadow healthy look identical to
 *    an absent journal, and both correctly emit nothing.
 *  - Rows count only under the record contract the writer emits: an
 *    ISO-parseable ts, boolean diverged and safetyRelevant verdicts and
 *    non-empty legacy/gateway backend strings. Malformed lines and rows
 *    missing those fields are skipped, never guessed — unknown stays
 *    unknown.
 *  - Recency-windowed and recurring means recorded. Only rows whose ts
 *    lands inside the 7-day window count, with the sibling feeds'
 *    one-minute future skew as the ceiling — a ts stamped further ahead
 *    than the evaluation time is corrupt or replayed evidence and never
 *    reaches a tally, and a day-file named past the evaluation day is
 *    never opened. The safety item emits only at
 *    GATEWAY_SHADOW_SAFETY_MIN recorded safety-relevant rows — the
 *    contract tolerates zero for the flip, but one transient comparison
 *    is not recurring evidence. The divergence item emits only when the
 *    window holds at least GATEWAY_SHADOW_MIN_DECISIONS shadowed
 *    decisions AND the measured divergence rate reaches
 *    GATEWAY_SHADOW_DIVERGENCE_RATE, the stage-2 tolerance itself — a
 *    small sample or a healthy shadow stays quiet.
 *  - The flip verdict is cumulative, not windowed. The stage-2 exit
 *    criteria belong to the whole soak, so the verdict read opens every
 *    gateway-shadow-*.jsonl file the instrument would read — same
 *    prefix/suffix filter, same newest-first order — under the same
 *    per-file tail bound plus a total byte cap. Any file that cannot be
 *    read completely makes the verdict incomplete and no verdict item
 *    emits: a partial journal can neither prove the criteria met nor
 *    prove them failed, so unknown stays unknown. Rows count under the
 *    instrument's own looser contract here (string ts, boolean diverged;
 *    safetyRelevant by truthiness) so the verdict matches what
 *    divergenceStats() would report, and it emits only once the journal
 *    holds GATEWAY_SHADOW_FLIP_MIN_DECISIONS rows — the contract's own
 *    evidence bar — as either the ready item or the blocked item.
 *  - Fleet machinery only. Shadow rows record no repository — the
 *    gateway shadows every dispatch this install makes — so items emit
 *    only when the backlog target's repository name is 'phantom', the
 *    same last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids hash the evidence kind only — never
 *    the counts or timestamps — so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; a shadow that
 *    recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts and the
 *    measured rate are quoted only as recorded, backend names are
 *    scrubbed and flattened, truncated tails are stated as a lower
 *    bound, and the brief names the journal, the exit criteria and the
 *    machinery modules with the usual no-change escape when the window
 *    no longer reproduces or the cause is config/owner-side.
 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { gatewayShadowDir } from '../fabric/gateway-shadow.js';
import { readTail } from '../metrics/loop-collect.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; two evidence kinds exist, so the cap is belt-and-braces. */
export const GATEWAY_SHADOW_MAX_ITEMS = 8;
const GATEWAY_SHADOW_ITEM_HARD_MAX = 25;
/**
 * Safety-relevant shadow rows inside the window before the would-dispatch
 * evidence counts as recurring — the fleet's RECURRING_FAILURES
 * convention. The stage-2/3 contract tolerates ZERO for the flip itself;
 * this bar only decides when the journal shows a pattern worth a session.
 */
export const GATEWAY_SHADOW_SAFETY_MIN = 3;
/**
 * Shadowed decisions the window must hold before a divergence rate means
 * anything — well under the contract's own 200-decision minimum, since
 * the feed measures the rate, not flip readiness.
 */
export const GATEWAY_SHADOW_MIN_DECISIONS = 50;
/**
 * The CONTRACT-M334 stage-2 divergence tolerance: the shadow fails the
 * exit criteria at 2% or above, so the feed emits at the same bar.
 */
export const GATEWAY_SHADOW_DIVERGENCE_RATE = 0.02;
/**
 * The CONTRACT-M334 stage-2 exit criteria, mirrored from divergenceStats()
 * (src/core/fabric/gateway-shadow.ts): the soak passes at >=200 shadowed
 * decisions, under 2% divergence and ZERO safety-relevant divergences —
 * the bar the stage-3 'gateway' default flip waits on. The safety bar is
 * the literal zero the contract names; no constant is needed for it.
 */
export const GATEWAY_SHADOW_FLIP_MIN_DECISIONS = 200;
export const GATEWAY_SHADOW_FLIP_MAX_DIVERGENCE_RATE = 0.02;
/** Total bytes the cumulative verdict read may consume across all
 * day-files; beyond it the oldest rows are unreachable and the verdict
 * stays unknown rather than guessing from a partial journal. */
const READINESS_TOTAL_BYTES = 64 * 1024 * 1024;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const GATEWAY_SHADOW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Future-skew ceiling on row ts stamps, the sibling feeds' one-minute
 * tolerance for same-host clock drift: a row stamped further ahead than
 * the evaluation time is corrupt or replayed evidence and never reaches
 * a tally — the same bound every other windowed backlog fold applies to
 * its journal timestamps.
 */
export const GATEWAY_SHADOW_FUTURE_SKEW_MS = 60_000;
/** Per-day file tail bound; a day of shadow rows is far smaller, the cap only guards a runaway file. */
const SHADOW_FILE_TAIL_BYTES = 4 * 1024 * 1024;
/** Day-file name the writer derives from the record's own UTC ts. */
const SHADOW_FILE_PATTERN = /^gateway-shadow-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Backend names are ledger-derived tokens; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 64;
/** Diverging backend pairs named inside one prompt before the rest is summarized. */
const PROMPT_PAIRS_MAX = 3;
/** The fleet's own repository label: shadow evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface GatewayShadowItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Fabric dir holding gateway-shadow-*.jsonl; default gatewayShadowDir() (~/.ashlr/fabric). */
  fabricDir?: string;
  /** Most items one call emits (default GATEWAY_SHADOW_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default GATEWAY_SHADOW_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_NAME_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

interface ShadowRow {
  atMs: number;
  diverged: boolean;
  safetyRelevant: boolean;
  legacyBackend: string;
  gatewayBackend: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function backendOf(side: unknown): string | null {
  if (!isRecord(side)) return null;
  const backend = side['backend'];
  return typeof backend === 'string' && backend.trim() !== '' ? backend.trim() : null;
}

/**
 * One journal line as fold evidence, or null when it does not satisfy the
 * writer's record contract — the same fields readGatewayShadow checks,
 * tightened to the fields this fold reads. Optional context fields
 * (tier, model, dispatched, wouldDispatch, workItemId, source) are
 * deliberately not required: the verdicts are what count.
 */
function shadowRowFrom(line: string): ShadowRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const ts = parsed['ts'];
  const atMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const diverged = parsed['diverged'];
  const safetyRelevant = parsed['safetyRelevant'];
  if (typeof diverged !== 'boolean' || typeof safetyRelevant !== 'boolean') return null;
  const legacyBackend = backendOf(parsed['legacy']);
  const gatewayBackend = backendOf(parsed['gateway']);
  if (legacyBackend === null || gatewayBackend === null) return null;
  return { atMs, diverged, safetyRelevant, legacyBackend, gatewayBackend };
}

interface DayFileRead {
  rows: ShadowRow[];
  truncated: boolean;
}

/**
 * Bounded read of the in-window day files, newest first. Only files whose
 * name-day can hold in-window rows are opened — a day-file named past the
 * evaluation day can only hold future-dated rows, which are corrupt
 * evidence the fold refuses anyway — and each is tail-read so a runaway
 * file contributes its newest bytes and reports `truncated`.
 */
async function readShadowDays(fabricDir: string, windowStartDay: string, untilDay: string): Promise<DayFileRead> {
  let names: string[];
  try {
    names = await readdir(fabricDir);
  } catch {
    return { rows: [], truncated: false };
  }
  const files = names
    .map((name) => ({ name, day: SHADOW_FILE_PATTERN.exec(name)?.[1] }))
    .filter((entry): entry is { name: string; day: string } => entry.day !== undefined && entry.day >= windowStartDay && entry.day <= untilDay)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.name < b.name ? 1 : -1));
  const rows: ShadowRow[] = [];
  let truncated = false;
  for (const file of files) {
    const tail = await readTail(join(fabricDir, file.name), SHADOW_FILE_TAIL_BYTES);
    if (tail === null) continue;
    truncated = truncated || tail.truncated;
    for (const line of tail.text.split('\n')) {
      if (!line.trim()) continue;
      const row = shadowRowFrom(line);
      if (row !== null) rows.push(row);
    }
  }
  return { rows, truncated };
}

/** One journal row under the instrument's own record contract — the same
 * acceptance readGatewayShadow applies (string ts, boolean diverged), so
 * the verdict counts exactly the rows divergenceStats() would count.
 * safetyRelevant stays raw and is counted by truthiness, the same filter
 * divergenceStats uses. */
interface ReadinessRow {
  diverged: boolean;
  safetyRelevant: unknown;
}

function readinessRowFrom(line: string): ReadinessRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const ts = parsed['ts'];
  const diverged = parsed['diverged'];
  if (typeof ts !== 'string' || typeof diverged !== 'boolean') return null;
  return { diverged, safetyRelevant: parsed['safetyRelevant'] };
}

/** The CONTRACT-M334 stage-2 verdict over the complete shadow journal.
 * readFlipVerdict returns null instead of an incomplete verdict: a partial
 * journal can neither prove the criteria met nor prove them failed. */
export interface ShadowFlipVerdict {
  /** Rows the instrument's record contract accepted — divergenceStats()'s `decisions`. */
  decisions: number;
  divergences: number;
  /** safetyRelevant rows counted by truthiness — divergenceStats()'s `safetyRelevant`. */
  safetyRelevant: number;
  divergenceRate: number;
  /** The stage-2 exit criteria: >=200 decisions, <2% divergence, ZERO safety-relevant. */
  ready: boolean;
}

/**
 * Evaluate the stage-2 exit criteria over the FULL shadow journal — every
 * gateway-shadow-*.jsonl file the instrument would read (same prefix/suffix
 * filter, same newest-first order), each under the windowed read's per-file
 * tail bound plus a total byte cap. Any file that truncates or cannot be
 * read makes the verdict incomplete: a partial journal can neither prove
 * the criteria met nor prove them failed, so the fold emits nothing rather
 * than guess — unknown stays unknown. A missing or empty fabric dir is a
 * complete read of zero rows: the soak simply has not run. Never throws.
 */
async function readFlipVerdict(fabricDir: string): Promise<ShadowFlipVerdict | null> {
  let names: string[];
  try {
    names = await readdir(fabricDir);
  } catch {
    return null;
  }
  const files = names
    .filter((name) => name.startsWith('gateway-shadow-') && name.endsWith('.jsonl'))
    .sort()
    .reverse();
  const rows: ReadinessRow[] = [];
  let bytes = 0;
  let complete = true;
  for (const name of files) {
    if (bytes >= READINESS_TOTAL_BYTES) {
      complete = false;
      break;
    }
    const tail = await readTail(join(fabricDir, name), SHADOW_FILE_TAIL_BYTES);
    if (tail === null || tail.truncated) {
      complete = false;
      break;
    }
    bytes += Buffer.byteLength(tail.text, 'utf8');
    for (const line of tail.text.split('\n')) {
      if (!line.trim()) continue;
      const row = readinessRowFrom(line);
      if (row !== null) rows.push(row);
    }
  }
  if (!complete) return null;
  const decisions = rows.length;
  const divergences = rows.filter((row) => row.diverged).length;
  const safetyRelevant = rows.filter((row) => row.safetyRelevant).length;
  const divergenceRate = decisions > 0 ? divergences / decisions : 0;
  return {
    decisions,
    divergences,
    safetyRelevant,
    divergenceRate,
    ready: decisions >= GATEWAY_SHADOW_FLIP_MIN_DECISIONS
      && divergenceRate < GATEWAY_SHADOW_FLIP_MAX_DIVERGENCE_RATE
      && safetyRelevant === 0,
  };
}

const EVIDENCE = 'The evidence is fabric/gateway-shadow-<UTC-day>.jsonl under the Phantom state directory (~/.ashlr/fabric), appended by the daemon dispatch path\'s observe-only InferenceGateway shadow when foundry.fabric.gatewayShadow is on — one row per shadowed decision with the legacy outcome, the gateway\'s would-be outcome and the diverged/safetyRelevant verdicts compareDecisions derives (src/core/fabric/gateway-shadow.ts, src/core/daemon/loop.ts shadowGateway). divergenceStats() in the same module encodes the CONTRACT-M334 stage-2 exit criteria; this feed evaluates the same criteria — >=200 decisions, <2% divergence, ZERO safety-relevant — over the full journal for the flip verdict, while the windowed items measure only the last 7 days.';

const NO_CHANGE = 'If the window has rolled forward, foundry.fabric.gatewayShadow is off or fabric.gateway already flipped on, the disagreements were a transient routing-state window, or the cause is owner-side config — report no-change and name the evidence.';

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

interface PairTally {
  diverged: number;
  total: number;
}

/** A diverging backend pair as the prompt quotes it. */
interface PromptPair extends PairTally {
  legacyBackend: string;
  gatewayBackend: string;
}

function safetyPrompt(count: number, decisions: number, truncated: boolean): string {
  const lines = [
    `Phantom's InferenceGateway shadow keeps would-dispatching work the legacy routing path deliberately blocked — the shadow journal recorded ${count} safety-relevant divergence(s) inside the ${Math.round(GATEWAY_SHADOW_WINDOW_MS / 86_400_000)}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each safety-relevant row is a decision where the gateway's wouldDispatch was true while the legacy path's dispatched was false — the legacy block was a subscription throttle, budget pause or resource pause. The CONTRACT-M334 stage-3 flip bar is ZERO safety-relevant divergences: if the gateway ever replaced the legacy path, every one of these would have been an unattended dispatch the fleet chose to hold.`,
    '',
    `The window also recorded ${decisions} shadowed decision(s) total.`,
    '',
    EVIDENCE,
    ...(truncated ? ['', 'The journal tail read hit its per-file bound, so the oldest in-window rows may be missing — the counts are a lower bound, not the whole story.'] : []),
    '',
    `Find out which side is wrong: compare the gateway's decide path (src/core/fabric gateway routing behind gatewayDecide) with the legacy throttle/budget/resource guards it shadows in the daemon loop — does the gateway see the same capacity and budget state, or is it missing a guard the legacy path applies? If the legacy blocks were correct fleet posture the gateway cannot see, the fix is in the gateway's inputs; if the legacy path over-blocks, the fix is there. Check foundry.fabric.gatewayShadow/gateway in the effective config before changing routing code. ${NO_CHANGE}`,
  ];
  return lines.join('\n');
}

function divergencePrompt(decisions: number, diverged: number, safetyCount: number, pairs: readonly PromptPair[], truncated: boolean): string {
  const rate = diverged / decisions;
  const pairText = pairs.length === 0
    ? 'none attributable to a backend pair'
    : pairs
      .map((pair) => `'${pair.legacyBackend}'→'${pair.gatewayBackend}' (${pair.diverged} of ${pair.total})`)
      .join(', ');
  const lines = [
    `Phantom's InferenceGateway shadow keeps disagreeing with the legacy routing path at or above the stage-2 tolerance — ${diverged} of ${decisions} shadowed decisions inside the ${Math.round(GATEWAY_SHADOW_WINDOW_MS / 86_400_000)}-day window diverged (${pct(rate)}), at or above the CONTRACT-M334 2% bar, the self-improvement work this backlog exists for.`,
    '',
    `Divergence means the gateway picked a different backend, model or dispatch verdict than the legacy path that actually ran. The shadow is observe-only so nothing broke — but the stage-2 exit criteria (>=200 decisions, <2% divergence, zero safety-relevant) cannot pass while this holds, and the flip decision has no honest signal. Largest recorded disagreements: ${pairText}. The window also recorded ${safetyCount} safety-relevant divergence(s).`,
    '',
    EVIDENCE,
    ...(truncated ? ['', 'The journal tail read hit its per-file bound, so the oldest in-window rows may be missing — the counts are a lower bound, not the whole story.'] : []),
    '',
    `Find out which side is wrong per disagreement: replay a few recorded workItemIds through both paths — does the M247 gateway (src/core/fabric, gatewayDecide) apply the same capacity, budget, throttle and learned-router inputs the legacy path does, or does it diverge on stale or missing state? If one side is systematically wrong, fix it; if the disagreement is legitimate policy difference, document why the criteria should treat it. Check foundry.fabric.gatewayShadow/gateway in the effective config before changing routing code. ${NO_CHANGE}`,
  ];
  return lines.join('\n');
}

function safetyItem(count: number, decisions: number, truncated: boolean, repo: string): CloudBacklogItem {
  const id = `gateway-shadow-safety-${createHash('sha256').update('gateway-shadow:safety').digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `InferenceGateway shadow keeps would-dispatching what legacy blocks`.slice(0, MAX_TITLE_CHARS),
    prompt: safetyPrompt(count, decisions, truncated),
    area: 'gateway-shadow',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function divergenceItem(decisions: number, diverged: number, safetyCount: number, pairs: readonly PromptPair[], truncated: boolean, repo: string): CloudBacklogItem {
  const id = `gateway-shadow-divergence-${createHash('sha256').update('gateway-shadow:divergence').digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `InferenceGateway shadow divergence is at/above the stage-2 bar`.slice(0, MAX_TITLE_CHARS),
    prompt: divergencePrompt(decisions, diverged, safetyCount, pairs, truncated),
    area: 'gateway-shadow',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function flipReadyPrompt(v: ShadowFlipVerdict): string {
  const lines = [
    `Phantom's InferenceGateway shadow soak met the CONTRACT-M334 stage-2 exit criteria — the complete shadow journal holds ${v.decisions} shadowed decisions with ${v.divergences} divergence(s) (${pct(v.divergenceRate)}) and zero safety-relevant rows, clearing the >=${GATEWAY_SHADOW_FLIP_MIN_DECISIONS} decisions / <${pct(GATEWAY_SHADOW_FLIP_MAX_DIVERGENCE_RATE)} divergence / ZERO safety-relevant bar that gates the stage-3 'gateway' default flip — the self-improvement work this backlog exists for.`,
    '',
    `Stage 3 flips defaults one line each, in contract order: concurrentDispatch → true (maxSlotsPerBackend: 2), then gateway → true one release later, then workhorseDispatch → true with the configured workhorse. Each flip is a one-line, revert-friendly commit, and a failed criterion at any stage reverts the newest flip and returns to stage 2. This item's work is the gateway default flip: check whether the concurrentDispatch flip has landed and the release cadence the contract names has passed, then make the one-line change flipping foundry.fabric.gateway's default to true.`,
    '',
    EVIDENCE,
    '',
    `The verdict reads the whole journal — every gateway-shadow-*.jsonl day-file, not the ${Math.round(GATEWAY_SHADOW_WINDOW_MS / 86_400_000)}-day window the sibling items use — with the same math divergenceStats() (src/core/fabric/gateway-shadow.ts) encodes for the contract instrument.`,
    '',
    `Check foundry.fabric.gatewayShadow and foundry.fabric.gateway in the effective config before changing defaults: if the gateway flip already landed, the shadow flag is off, or the journal was reset after this verdict, report no-change and name the evidence.`,
  ];
  return lines.join('\n');
}

function flipBlockedPrompt(v: ShadowFlipVerdict): string {
  const safetyText = v.safetyRelevant === 1 ? '1 safety-relevant row' : `${v.safetyRelevant} safety-relevant rows`;
  const lines = [
    `Phantom's InferenceGateway shadow soak has produced a verdict and it is no — the complete shadow journal holds ${v.decisions} shadowed decisions with ${v.divergences} divergence(s) (${pct(v.divergenceRate)} against the <${pct(GATEWAY_SHADOW_FLIP_MAX_DIVERGENCE_RATE)} bar) and ${safetyText} against the ZERO bar, so the CONTRACT-M334 stage-2 exit criteria cannot pass on this journal and the stage-3 'gateway' default flip stays barred — the self-improvement work this backlog exists for.`,
    '',
    `The verdict is cumulative, not windowed: the journal is append-only and the contract's counters never reset, so a soak that failed early and then ran clean still reads blocked here — every recorded safety-relevant divergence counts against the ZERO bar for the life of the journal and the all-time divergence rate counts against the tolerance. The windowed sibling items only see the last ${Math.round(GATEWAY_SHADOW_WINDOW_MS / 86_400_000)} days; this verdict sees every row the shadow ever wrote.`,
    '',
    `Find out whether the recorded disagreements were a transient routing-state window or a real input gap: replay recorded workItemIds through the M247 gateway (src/core/fabric, gatewayDecide) and the legacy throttle/budget/resource guards it shadows in the daemon loop. If the divergence source is fixed the soak still needs a counter reset — the contract names one only for a failed stage-3 criterion and no reset mechanism exists in code or the journal format, so restarting the count is an owner/contract decision, not more shadow data. If the criteria themselves should change, that is a contract amendment. Check foundry.fabric.gatewayShadow/gateway in the effective config first. ${NO_CHANGE}`,
  ];
  return lines.join('\n');
}

function flipReadyItem(v: ShadowFlipVerdict, repo: string): CloudBacklogItem {
  const id = `gateway-shadow-flip-ready-${createHash('sha256').update('gateway-shadow:flip-ready').digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `InferenceGateway shadow passed the stage-2 exit criteria — queue the gateway flip`.slice(0, MAX_TITLE_CHARS),
    prompt: flipReadyPrompt(v),
    area: 'gateway-shadow',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function flipBlockedItem(v: ShadowFlipVerdict, repo: string): CloudBacklogItem {
  const id = `gateway-shadow-flip-blocked-${createHash('sha256').update('gateway-shadow:flip-blocked').digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `InferenceGateway shadow soak failed the stage-2 exit criteria`.slice(0, MAX_TITLE_CHARS),
    prompt: flipBlockedPrompt(v),
    area: 'gateway-shadow',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

interface PairCell extends PairTally {
  key: string;
  legacyBackend: string;
  gatewayBackend: string;
}

/**
 * Backlog items for the gateway shadow journal's recurring safety and
 * divergence evidence. Total: a missing fabric dir, another repository or
 * any read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function gatewayShadowBacklogItems(opts: GatewayShadowItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const now = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : GATEWAY_SHADOW_WINDOW_MS;
    const fabricDir = opts.fabricDir ?? gatewayShadowDir();
    const windowStartDay = new Date(now - windowMs).toISOString().slice(0, 10);
    const untilDay = new Date(now + GATEWAY_SHADOW_FUTURE_SKEW_MS).toISOString().slice(0, 10);
    const { rows, truncated } = await readShadowDays(fabricDir, windowStartDay, untilDay);

    const windowStartMs = now - windowMs;
    const untilMs = now + GATEWAY_SHADOW_FUTURE_SKEW_MS;
    const inWindow = rows.filter((row) => row.atMs >= windowStartMs && row.atMs <= untilMs);

    const candidates: CloudBacklogItem[] = [];
    if (inWindow.length > 0) {
      let safetyCount = 0;
      let divergedCount = 0;
      const pairs = new Map<string, PairCell>();
      for (const row of inWindow) {
        if (row.safetyRelevant) safetyCount += 1;
        if (row.diverged) divergedCount += 1;
        const legacyBackend = fieldText(row.legacyBackend);
        const gatewayBackend = fieldText(row.gatewayBackend);
        if (legacyBackend === '' || gatewayBackend === '') continue;
        const key = `${legacyBackend}${gatewayBackend}`;
        const cell = pairs.get(key) ?? { key, legacyBackend, gatewayBackend, diverged: 0, total: 0 };
        cell.total += 1;
        if (row.diverged) cell.diverged += 1;
        pairs.set(key, cell);
      }

      const decisions = inWindow.length;
      // The safety kind is contract-fatal for the flip, so its item survives limit truncation first.
      if (safetyCount >= GATEWAY_SHADOW_SAFETY_MIN) candidates.push(safetyItem(safetyCount, decisions, truncated, repo));
      if (decisions >= GATEWAY_SHADOW_MIN_DECISIONS && divergedCount / decisions >= GATEWAY_SHADOW_DIVERGENCE_RATE) {
        const topPairs = [...pairs.values()]
          .filter((cell) => cell.diverged > 0)
          .sort((a, b) => b.diverged - a.diverged || b.total - a.total || a.key.localeCompare(b.key))
          .slice(0, PROMPT_PAIRS_MAX)
          .map((cell) => ({ diverged: cell.diverged, total: cell.total, legacyBackend: cell.legacyBackend, gatewayBackend: cell.gatewayBackend }));
        candidates.push(divergenceItem(decisions, divergedCount, safetyCount, topPairs, truncated, repo));
      }
    }

    // The CONTRACT-M334 stage-2 verdict is cumulative, not windowed: it
    // reads every day-file the shadow ever wrote, so a soak that ended
    // before the window — or failed on rows the window no longer holds —
    // still reports its verdict. An inconclusive read emits nothing:
    // unknown stays unknown.
    const verdict = await readFlipVerdict(fabricDir);
    if (verdict !== null) {
      if (verdict.ready) candidates.push(flipReadyItem(verdict, repo));
      else if (verdict.decisions >= GATEWAY_SHADOW_FLIP_MIN_DECISIONS) candidates.push(flipBlockedItem(verdict, repo));
    }

    const limit = Math.max(1, Math.min(opts.limit ?? GATEWAY_SHADOW_MAX_ITEMS, GATEWAY_SHADOW_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
