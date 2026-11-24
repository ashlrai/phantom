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
 * divergenceStats() evaluates the CONTRACT-M334 stage-2 exit criteria —
 * at least 200 shadowed decisions, under 2% divergence and ZERO
 * safety-relevant divergences before the gateway may replace the legacy
 * path — but nothing ever calls it, and readGatewayShadow has no caller
 * either: the journal is write-only evidence. Until now a shadow that
 * kept disagreeing with legacy, or kept would-dispatching work the
 * legacy path deliberately blocked, never became work — the flip
 * decision had no instrument feeding it and a latent safety regression
 * sat in a file no report reads.
 *
 * gatewayShadowBacklogItems carries the same journal into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling fleet-evidence sources beside it.
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
 *    lands inside the 7-day window count. The safety item emits only at
 *    GATEWAY_SHADOW_SAFETY_MIN recorded safety-relevant rows — the
 *    contract tolerates zero for the flip, but one transient comparison
 *    is not recurring evidence. The divergence item emits only when the
 *    window holds at least GATEWAY_SHADOW_MIN_DECISIONS shadowed
 *    decisions AND the measured divergence rate reaches
 *    GATEWAY_SHADOW_DIVERGENCE_RATE, the stage-2 tolerance itself — a
 *    small sample or a healthy shadow stays quiet.
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
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const GATEWAY_SHADOW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
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
 * name-day can hold in-window rows are opened; each is tail-read so a
 * runaway file contributes its newest bytes and reports `truncated`.
 */
async function readShadowDays(fabricDir: string, windowStartDay: string): Promise<DayFileRead> {
  let names: string[];
  try {
    names = await readdir(fabricDir);
  } catch {
    return { rows: [], truncated: false };
  }
  const files = names
    .map((name) => ({ name, day: SHADOW_FILE_PATTERN.exec(name)?.[1] }))
    .filter((entry): entry is { name: string; day: string } => entry.day !== undefined && entry.day >= windowStartDay)
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

const EVIDENCE = 'The evidence is fabric/gateway-shadow-<UTC-day>.jsonl under the Phantom state directory (~/.ashlr/fabric), appended by the daemon dispatch path\'s observe-only InferenceGateway shadow when foundry.fabric.gatewayShadow is on — one row per shadowed decision with the legacy outcome, the gateway\'s would-be outcome and the diverged/safetyRelevant verdicts compareDecisions derives (src/core/fabric/gateway-shadow.ts, src/core/daemon/loop.ts shadowGateway). readGatewayShadow and divergenceStats — the CONTRACT-M334 stage-2 exit-criteria evaluator — exist but have no caller, so this journal is the only record; there is no report command for it.';

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
    const { rows, truncated } = await readShadowDays(fabricDir, windowStartDay);

    const windowStartMs = now - windowMs;
    const inWindow = rows.filter((row) => row.atMs >= windowStartMs);
    if (inWindow.length === 0) return [];

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
    const candidates: CloudBacklogItem[] = [];
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

    const limit = Math.max(1, Math.min(opts.limit ?? GATEWAY_SHADOW_MAX_ITEMS, GATEWAY_SHADOW_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
