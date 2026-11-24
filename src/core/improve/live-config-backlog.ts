/**
 * Live fleet-config audit journal recurring evidence → self-improvement backlog items.
 *
 * `phm fleet config set|unset` (src/cli/fleet-config.ts) writes the fleet's
 * runtime-dynamic config layer — the highest-precedence layer above pinned
 * defaults, slots.json, budget-overrides.json and one-shot CLI overrides.
 * Every applied change appends one row to
 * <runs>/queue/live-config-audit.jsonl:
 *
 *   { v: 1, at: <ISO-8601>, op: 'set'|'unset', key, from, to, by, reason }
 *
 * (schema fleet.config.audit.v1; the writer is change() in
 * src/core/fleet/dynconfig.ts). The writer validates the key against the
 * mutable vocabulary (mutableKeySpec / RESTART_REQUIRED deny-wins),
 * requires a non-empty actor and a bounded reason, writes
 * temp+rename under a lock, and refuses the change entirely when the
 * audit append fails — so every row is a real, applied override write.
 * `by` and `reason` are free text and are never folded; only the count of
 * distinct recorded actors is.
 *
 * Until now the journal's only reader was readConfigAudit backing `phm
 * fleet config audit`'s point-in-time display (newest-first, capped), so
 * a knob that kept being hand-retuned never became work.
 * liveConfigBacklogItems carries the journal into discoverBacklog:
 *
 *  - per-key churn: one mutable key rewritten at the recurring bars
 *    inside the 7-day window — lane bounds (lanes.<lane>.target|floor|
 *    ceiling|hard_cap), the fleet hard_cap, the *.off kill switches,
 *    local.worker_gb and the compact.lanes.*_below_gb freeze lines.
 *    Each rewrite is a hand correction above every lower layer,
 *    including the pinned dispatcher's own lane controller, so
 *    recurrence means the steady-state value is wrong somewhere below
 *    the live layer — or the override is fighting a controller that
 *    already owns the knob.
 *  - off-contract rows: audit rows whose key is well-formed but sits
 *    outside the writer's current mutable vocabulary — a key retired
 *    from MUTABLE_KEY_PATTERNS since the row was written, or a
 *    hand-edited ledger — folded as one global cell so vocabulary
 *    drift stays visible instead of silently dropping.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched.
 *    Missing, non-file or unreadable evidence yields no items.
 *  - The journal carries no repository column — the writer hardcodes
 *    the fleet's own runs dir — so like the custody, self-tick and
 *    launch-cost feeds, items emit only when the backlog's repo name
 *    is the fleet's own; another repository inherits nothing.
 *  - Recurring means recorded. A cell emits only at
 *    LIVE_CONFIG_MIN_ROWS change rows across LIVE_CONFIG_MIN_DAYS
 *    distinct UTC days inside the 7-day window — one override write
 *    proves nothing (a deliberate incident response legitimately
 *    retunes a knob once).
 *  - Unknown stays unknown. Malformed lines, rows missing v/op/at/key
 *    or carrying an invalid op or unparseable timestamp are skipped,
 *    never guessed; keys failing even the writer's key grammar are
 *    skipped rather than folded under an unsafe name; a truncated
 *    tail still yields honest lower-bound counts and says so in the
 *    prompt.
 *  - Actor and reason text is never emitted: `by` values are only
 *    counted (distinct recorded actors) and `reason` is never read
 *    into the fold at all.
 *  - Dedup is downstream. Item ids hash the cell kind + key +
 *    repository (never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the brief names the journal, the writer
 *    and its CLI, and the usual no-change escape when the window no
 *    longer reproduces or the cause is owner-only.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { LIVE_CONFIG_AUDIT_FILE, mutableKeySpec } from '../fleet/dynconfig.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the mutable-key set is small and closed. */
export const LIVE_CONFIG_MAX_ITEMS = 8;
const LIVE_CONFIG_ITEM_HARD_MAX = 25;
/** The window every fold anchors on: the fleet's recurring-evidence week. */
export const LIVE_CONFIG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Change rows one cell needs inside the window… */
export const LIVE_CONFIG_MIN_ROWS = 3;
/** …spread across at least this many distinct UTC days. */
export const LIVE_CONFIG_MIN_DAYS = 2;
/**
 * Bounded tail for the journal. Audit rows are ~250 bytes and writes
 * are deliberate operator acts — far below the landed-close cadence —
 * so 1 MiB retains far more than the 7-day window even in a heavy
 * retuning week.
 */
export const LIVE_CONFIG_TAIL_BYTES = 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The writer's own key grammar (dynconfig classifyKey): dot-separated
 *  segments of [A-Za-z0-9_.-], at most 120 chars. Keys failing even this
 *  are skipped as malformed rather than folded under an unsafe name. */
const KEY_RE = /^[A-Za-z0-9_.-]{1,120}$/;
/** Distinct 'to' values quoted inside one prompt before the remainder is summarized. */
const PROMPT_VALUES_MAX = 6;
/** Distinct recorded actors tracked per cell; the Set only ever feeds a count. */
const ACTORS_MAX = 64;
/** Distinct 'to' values tracked per cell (prompt quotes a bounded prefix). */
const VALUES_MAX = 64;
/** Actor strings are unbounded free text; bound what the fold retains. */
const ACTOR_MAX = 120;
/** The journal's path inside the fleet runs dir (dynconfig appends it). */
const LIVE_CONFIG_AUDIT_RELATIVE = join('queue', LIVE_CONFIG_AUDIT_FILE);
/** The repository name the writer's install describes; the gate matches on it. */
const FLEET_REPO_NAME = 'phantom';
/** The repository name both vocabularies record: the last path segment, lowercased. */
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();

export interface LiveConfigItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet repo only. */
  repo: string;
  /** Journal override (default: <runsDir>/queue/live-config-audit.jsonl). */
  journalPath?: string;
  /** Runs dir for the journal default; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default LIVE_CONFIG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated audit row inside the journal. */
export interface LiveConfigAuditRow {
  atMs: number;
  utcDay: string;
  op: 'set' | 'unset';
  /** The recorded key when it is in the writer's current mutable vocabulary, else null. */
  key: string | null;
  /** The recorded 'to' value when it is a finite number, else null. */
  to: number | null;
  /** The recorded actor string — counted for distinct actors, never emitted. */
  by: string | null;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Pure: parse journal text into validated audit rows. Malformed lines and
 * rows missing v/op/at or carrying an invalid op, unparseable timestamp or
 * unsafe key shape are skipped — never guessed. A well-formed row whose
 * key sits outside the current mutable vocabulary keeps key: null so the
 * fold can count it as off-contract instead of dropping it. Mirrors the
 * writer's emitted shape: numeric v 1, 'set'|'unset' op, ISO `at`,
 * string key, and optional from/to/by/reason fields which are validated
 * leniently — a bad auxiliary field never discards the change itself.
 */
export function parseLiveConfigAuditJournal(text: string): LiveConfigAuditRow[] {
  const rows: LiveConfigAuditRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const r = value as Record<string, unknown>;
    if (r['v'] !== 1) continue;
    const op = r['op'];
    if (op !== 'set' && op !== 'unset') continue;
    const at = r['at'];
    if (typeof at !== 'string') continue;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) continue;
    const key = r['key'];
    if (typeof key !== 'string' || !KEY_RE.test(key)) continue;
    const by = r['by'];
    rows.push({
      atMs,
      utcDay: utcDayOf(atMs),
      op,
      key: mutableKeySpec(key) === null ? null : key,
      to: op === 'set' ? finiteNumber(r['to']) : null,
      by: typeof by === 'string' && by.trim() !== '' ? by.trim().slice(0, ACTOR_MAX) : null,
    });
  }
  return rows;
}

/** One key's (or the off-contract cell's) change track inside the window. */
interface ChangeTrack {
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
  sets: number;
  unsets: number;
  /** Distinct recorded actors — counted only, never emitted. */
  actors: Set<string>;
  /** Distinct finite 'to' values recorded on 'set' rows. */
  values: Set<number>;
}

/**
 * firstMs/lastMs start at the infinities so the first tracked row seeds
 * both; empty tracks never reach a prompt (meetsBar requires rows).
 */
const newTrack = (): ChangeTrack => ({
  rows: 0,
  days: new Set(),
  firstMs: Number.POSITIVE_INFINITY,
  lastMs: Number.NEGATIVE_INFINITY,
  sets: 0,
  unsets: 0,
  actors: new Set(),
  values: new Set(),
});

function trackRow(track: ChangeTrack, row: LiveConfigAuditRow): void {
  track.rows += 1;
  track.days.add(row.utcDay);
  track.firstMs = Math.min(track.firstMs, row.atMs);
  track.lastMs = Math.max(track.lastMs, row.atMs);
  if (row.op === 'set') track.sets += 1; else track.unsets += 1;
  if (row.by !== null && track.actors.size < ACTORS_MAX) track.actors.add(row.by);
  if (row.to !== null && track.values.size < VALUES_MAX) track.values.add(row.to);
}

/** The fold's output: per-key churn cells plus the global off-contract tally. */
export interface LiveConfigFold {
  /** mutable key → change track. */
  churn: Map<string, ChangeTrack>;
  /** Audit rows whose key is outside the current mutable vocabulary. */
  offContract: ChangeTrack;
}

/**
 * Pure: fold validated rows into the churn and off-contract cells. Rows
 * outside the window contribute nothing. Contract rows (recognized
 * mutable key) fold per key; off-contract rows (key null) fold globally.
 */
export function foldLiveConfigAuditRows(
  rows: readonly LiveConfigAuditRow[],
  nowMs: number,
  windowMs: number = LIVE_CONFIG_WINDOW_MS,
): LiveConfigFold {
  const fold: LiveConfigFold = { churn: new Map(), offContract: newTrack() };
  const windowStart = nowMs - windowMs;
  for (const row of rows) {
    if (row.atMs < windowStart) continue;
    if (row.key === null) {
      trackRow(fold.offContract, row);
      continue;
    }
    let track = fold.churn.get(row.key);
    if (track === undefined) {
      track = newTrack();
      fold.churn.set(row.key, track);
    }
    trackRow(track, row);
  }
  return fold;
}

const WINDOW_DAYS = Math.round(LIVE_CONFIG_WINDOW_MS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the key has held its value since, or the churn traces to a deliberate incident response that has ended — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is queue/live-config-audit.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), appended by `phm fleet config set|unset` (src/cli/fleet-config.ts delegating to change() in src/core/fleet/dynconfig.ts) — one {v, at, op, key, from, to, by, reason} row per applied live-config write, mode 0600, and the writer refuses any change it cannot audit. Until now its only reader was `phm fleet config audit`\'s point-in-time display (readConfigAudit, newest-first and capped) — no reader folded the recurrence.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

const spanText = (track: ChangeTrack): string =>
  `first ${new Date(track.firstMs).toISOString()}, last ${new Date(track.lastMs).toISOString()}`;

const meetsBar = (track: ChangeTrack): boolean =>
  track.rows >= LIVE_CONFIG_MIN_ROWS && track.days.size >= LIVE_CONFIG_MIN_DAYS;

/** What one recorded 'to' value list looks like inside a prompt. */
function valuesText(track: ChangeTrack): string {
  if (track.values.size === 0) return '';
  const sorted = [...track.values].sort((a, b) => a - b);
  const shown = sorted.slice(0, PROMPT_VALUES_MAX).map((v) => String(v)).join(', ');
  const more = track.values.size > PROMPT_VALUES_MAX ? `, and ${track.values.size - PROMPT_VALUES_MAX} more distinct` : '';
  return ` The override took ${track.values.size} distinct recorded value(s): ${shown}${more}.`;
}

const opsText = (track: ChangeTrack): string =>
  `${track.sets} 'set' and ${track.unsets} 'unset' op(s)`;

/** Per-key cells sorted by recorded rows then key name — deterministic across refreshes. */
function sortedCells(map: Map<string, ChangeTrack>): Array<{ key: string; track: ChangeTrack }> {
  return [...map.entries()]
    .map(([key, track]) => ({ key, track }))
    .sort((a, b) => b.track.rows - a.track.rows || a.key.localeCompare(b.key));
}

/** The mutable vocabulary is small and closed; name what each key class is. */
interface KeyClass { noun: string; guidance: string }

function keyClass(key: string): KeyClass {
  if (key === 'hard_cap') {
    return {
      noun: 'the fleet-wide slot cap',
      guidance: 'Each row rewrote the fleet-wide concurrency cap — the number of fleet jobs allowed to run at once. A cap that keeps being set by hand means the fleet\'s real concurrency ceiling is being discovered operationally instead of configured: check whether slots.json or the pinned dispatcher\'s own admission should carry the steady-state value, and whether the rewrites cluster around capacity incidents that point at a deeper cause (host memory, lane balance, stuck jobs holding slots).',
    };
  }
  if (key === 'local.worker_gb') {
    return {
      noun: 'the per-local-worker memory assumption',
      guidance: 'Each row rewrote the GB one local worker is assumed to need until real samples exist — `phm local capacity` divides free memory by this figure (or by the median of recent local worker samples once they exist) to size the local lane. Check `phm local capacity --json` for the current perWorkerGb source and sampleCount: if samples exist the override is dead weight, and if they do not, recurring rewrites mean the default 6 GB assumption keeps being wrong for this host\'s real worker footprint.',
    };
  }
  if (key.startsWith('compact.lanes.')) {
    return {
      noun: 'a disk-compact freeze threshold',
      guidance: 'Each row rewrote a disk-compact freeze/halve GB line — the free-space figures at which `phm fleet disk` and `phm fleet disk-sweep` freeze or halve lane concurrency. Check the host\'s disk trend (`phm disk-maint` dry run, fleet disk reports) against the hand-set lines: recurring rewrites mean the thresholds keep being corrected for a disk that fills faster or slower than the defaults assume, or that compaction is not reclaiming enough and the lines are being nudged instead of the leak fixed.',
    };
  }
  const off = /\.off$/.exec(key);
  if (off !== null) {
    const what = key === 'autofill.off'
      ? 'it stops self-tick from filling starved lanes'
      : key === 'empty_stop.off'
        ? 'it stops self-tick from retiring READY jobs of empty-heavy families'
        : key === 'mason.digest.off'
          ? 'it stops the hourly Mason update posts'
          : 'a fleet kill switch';
    return {
      noun: `the ${key} kill switch`,
      guidance: `${what} — each row flipped this switch on or off. Alternating 'set' and 'unset' ops mean the suppressed behavior keeps recurring and the switch is being used as the fix: the switch exists to stop a behavior, so the recurring behavior is the work. Find what keeps tripping it (for a lane-filling switch, queue supply or yield; for a stop switch, the empty-family yield the market already tracks; for the digest, whatever kept making the hourly post noisy) and fix that, or leave the switch in its intended state and remove the override so the lower layers own it.`,
    };
  }
  const lane = /^lanes\.([a-z][a-z0-9-]{1,30})\.(target|floor|ceiling|hard_cap)$/.exec(key);
  if (lane !== null) {
    return {
      noun: `lane ${lane[1]}'s ${lane[2]} bound`,
      guidance: `Each row rewrote one lane's slot bound above slots.json, budget-overrides.json and the pinned dispatcher's own lane controller — the controller already adapts lane levels from host evidence, and \`phm fleet lane-adapt\` reconstructs its recorded moves. A bound that keeps being set by hand means either the needed level sits outside the controller's range or the steady-state belongs in slots.json: check \`phm fleet lane-adapt --json\` for what the controller did to this lane in the same window, the lane's posture reasons in metrics/work-market.jsonl, and whether the rewrites cluster around incidents that have since resolved.`,
    };
  }
  return {
    noun: `the mutable key ${key}`,
    guidance: 'Each row rewrote this runtime-mutable fleet config key. Check `phm fleet config audit` for the recorded who/when/why and whether the value has since stabilized; if the steady-state belongs in a lower layer (slots.json, budget-overrides.json or a pinned default) the live override should be unset rather than repeatedly rewritten.',
  };
}

function churnPrompt(key: string, track: ChangeTrack, truncated: boolean): string {
  const cls = keyClass(key);
  const toggled = track.sets > 0 && track.unsets > 0 ? ' The recorded ops alternate between writing and removing the override.' : '';
  return [
    `\`phm fleet config\` keeps rewriting the live override for \`${key}\` — ${cls.noun} on this install's runtime fleet config.`,
    '',
    `Inside the ${WINDOW_DAYS}-day audit window the ledger recorded ${track.rows} change row(s) for \`${key}\` across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}): ${opsText(track)}, ${track.actors.size} distinct recorded actor(s).${valuesText(track)}${toggled}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `${cls.guidance} If the key has held its value since the window or the churn traces to a resolved incident — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function offContractPrompt(track: ChangeTrack, truncated: boolean): string {
  return [
    `The live fleet-config audit journal keeps recording change rows whose keys sit outside the writer's current mutable vocabulary — either a key was retired from MUTABLE_KEY_PATTERNS since the rows were written, or the ledger was hand-edited.`,
    '',
    `Inside the ${WINDOW_DAYS}-day audit window the ledger recorded ${track.rows} off-contract change row(s) across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}): ${opsText(track)}, ${track.actors.size} distinct recorded actor(s).${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    'The writer (change() in src/core/fleet/dynconfig.ts) only ever appends rows for keys that pass mutableKeySpec after the RESTART_REQUIRED deny check, so recurring off-contract rows mean the vocabulary moved under older rows or something wrote the file outside the CLI. Read the rows with `phm fleet config audit --json` and compare their keys against `phm fleet config restart-required --json`\'s mutable list: a retired key is historical evidence (the fold is correct to keep it visible), a live key missing from the mutable list is a regression in the allowlist, and a key that was never mutable is an unauthorized write path worth finding. If every off-contract row predates a known vocabulary change — report no-change and name the evidence. ' + NO_CHANGE,
  ].join('\n');
}

function itemId(kind: string, repo: string, key: string | null): string {
  const cell = key === null ? kind : `${kind}:${key}`;
  const hash = createHash('sha256').update(`live-config:${cell}:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `live-config-${kind}-${hash}`;
}

function makeItem(kind: string, repo: string, key: string | null, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(kind, repo, key),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'live-config',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the live fleet-config audit journal's recurring
 * per-key churn and off-contract rows. Total: any read or fold failure
 * yields no items rather than throwing into discovery.
 */
export async function liveConfigBacklogItems(opts: LiveConfigItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const journalPath = opts.journalPath ?? join(runsDir, LIVE_CONFIG_AUDIT_RELATIVE);
    const tail = await readLedgerTail(journalPath, LIVE_CONFIG_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const rows = parseLiveConfigAuditJournal(tail.text);
    const fold = foldLiveConfigAuditRows(rows, nowMs);

    const candidates: CloudBacklogItem[] = [];
    if (meetsBar(fold.offContract)) {
      candidates.push(makeItem(
        'off-contract',
        repo,
        null,
        `Live fleet-config audit keeps recording off-vocabulary keys on ${repo}`,
        offContractPrompt(fold.offContract, tail.truncated),
      ));
    }
    for (const { key, track } of sortedCells(fold.churn)) {
      if (!meetsBar(track)) continue;
      candidates.push(makeItem(
        'churn',
        repo,
        key,
        `Live fleet config ${key} keeps being hand-retuned on ${repo}`,
        churnPrompt(key, track, tail.truncated),
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? LIVE_CONFIG_MAX_ITEMS, LIVE_CONFIG_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
