/**
 * ~/.ashlr/telemetry/fleet-hop-spool.jsonl fleet-hop delivery outbox →
 * self-improvement backlog items.
 *
 * Every queue.v1 fleet_hop event — one JSON line per PR station exit the
 * Mac bridge emits through `phantom exec -- node scripts/fleet-hop.mjs`
 * — is built by buildFleetHop and delivered by deliver
 * (src/core/observability/fleet-hop.ts). When the POST to the PostHog
 * capture endpoint fails, or POSTHOG_AGENT_FLEET_TOKEN is unset in the
 * emitting environment ('no key' is itself a spool cause), the event is
 * appended to this spool instead of being sent. The spool is the
 * outbox: replayFleetHopSpool dedups by $insert_id, re-sends what it
 * can and rewrites the file with only the events that still failed —
 * and nothing runs it on a schedule; the only drain is a manual
 * `phantom exec -- node scripts/fleet-hop.mjs --replay`. The append
 * path has no cap, so an unkeyed or unreachable endpoint grows the
 * file without bound, and replayFleetHopSpool reads the whole file
 * into memory on each pass.
 *
 * The spool already has readers, but none that turn its state into
 * work: collectFleetHopEvents (src/core/observability/rollup.ts) scans
 * up to 32 MiB of it as the merged-PR cost rollup's source — and by
 * contract that view is only the undelivered floor, since delivered
 * hops never enter the file — while replayFleetHopSpool itself is the
 * only other reader. Until now no fold asked the question the backlog
 * exists for: is telemetry egress actually working? A spool holding
 * hops across many days is delivery that has been failing (or a key
 * that has been missing, or a replay that has never run) for just as
 * long — evidence-capture degradation nobody ever saw.
 * fleetHopSpoolBacklogItems carries the same rows into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The spool is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network is
 *    touched. A missing or unreadable file yields no items; a
 *    malformed line is skipped, never guessed.
 *  - Rows count only under the writer's contract: event 'fleet_hop',
 *    a parseable envelope timestamp, a properties object carrying
 *    schema 'queue.v1', an id-shaped station and a bounded
 *    distinct_id — the fields buildFleetHop guarantees on every row
 *    it spools. Foreign shapes are malformed, never folded.
 *  - This journal is pending state, not an event stream: every row in
 *    it is a hop still waiting for delivery confirmation, so there is
 *    no evidence window — a row parked for thirty days is stronger
 *    evidence than one parked for an hour, not stale history. What
 *    makes the backlog recurring is the days the pending rows span:
 *    a cell emits only at FLEET_HOP_SPOOL_MIN_ROWS in-window-contract
 *    rows across FLEET_HOP_SPOOL_MIN_DAYS distinct UTC days, the
 *    fleet's RECURRING_FAILURES convention applied to undelivered
 *    telemetry. firstSeen/lastSeen report the oldest and newest
 *    pending hop honestly, and test:true synthetic rows count toward
 *    recurrence (a broken pipe fails test traffic too) while their
 *    share is reported as context.
 *  - Truncation is stated, never hidden: when the bounded tail cut
 *    older bytes — likely on exactly the hosts this item exists for,
 *    since the spool is unbounded — every prompt says the counts are
 *    a lower bound and the file's byte size is reported so the
 *    growth itself is visible.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the spool describes this
 *    install's telemetry pipe and carries no single target repo.
 *    Dedup is downstream: the item id hashes the constant cell
 *    identity, so a refresh re-derives the same id and a drained
 *    spool simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { FLEET_HOP_EVENT, FLEET_HOP_ID_RE, fleetHopSpoolPath } from '../observability/fleet-hop.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the cell space is the single spool cell. */
export const FLEET_HOP_SPOOL_BACKLOG_MAX_ITEMS = 4;
const FLEET_HOP_SPOOL_BACKLOG_ITEM_HARD_MAX = 10;
/** A cell emits only at this many contract-valid pending rows... */
export const FLEET_HOP_SPOOL_MIN_ROWS = 3;
/** ...spanning at least this many distinct UTC days of pending hops. */
export const FLEET_HOP_SPOOL_MIN_DAYS = 2;
/** Bounded no-follow tail; the writer never compacts, so a large spool's oldest rows may sit outside it. */
export const FLEET_HOP_SPOOL_TAIL_BYTES = 512 * 1024;
/** The fleet's own repository label: spool evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Envelope timestamp bound; the writer's ISO exit_ts is ~24 chars. */
const MAX_TS_CHARS = 64;
/** distinct_id is 'agent:<id>' or 'station:<station>'; bounded well past the writer's own id cap. */
const MAX_DISTINCT_ID_CHARS = 200;
/** Distinct station labels quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_STATIONS = 6;
/** The writer's schema tag on every spooled row's properties. */
const HOP_SCHEMA = 'queue.v1';

export interface FleetHopSpoolItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Spool override (default: fleetHopSpoolPath(), ~/.ashlr/telemetry/fleet-hop-spool.jsonl). */
  spoolPath?: string;
  /** Most items one call emits (default FLEET_HOP_SPOOL_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

function parseInstant(value: unknown): number | null {
  if (!boundedString(value, MAX_TS_CHARS)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Row contract — one spooled FleetHopEvent exactly as spool() appends it
// ---------------------------------------------------------------------------

interface FleetHopRow {
  tsMs: number;
  station: string;
  /** The writer marks synthetic traffic test:true; it still proves delivery failed. */
  test: boolean;
}

/**
 * Structural validation of one persisted line against the writer's
 * FleetHopEvent contract: the envelope event name, a parseable
 * timestamp, and a properties object carrying the schema tag, an
 * id-shaped station and a bounded distinct_id — the fields
 * buildFleetHop guarantees on every row it spools. Returns null for a
 * corrupted or foreign row so the caller counts it malformed and skips
 * it rather than let damaged evidence masquerade as a real pending hop.
 */
function projectHop(parsed: unknown): FleetHopRow | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (row['event'] !== FLEET_HOP_EVENT) return null;
  const tsMs = parseInstant(row['timestamp']);
  if (tsMs === null) return null;
  if (!boundedString(row['distinct_id'], MAX_DISTINCT_ID_CHARS)) return null;
  const props = row['properties'];
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return null;
  const p = props as Record<string, unknown>;
  if (p['schema'] !== HOP_SCHEMA) return null;
  const station = p['station'];
  if (typeof station !== 'string' || !FLEET_HOP_ID_RE.test(station)) return null;
  return { tsMs, station, test: p['test'] === true };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the spool tail
// ---------------------------------------------------------------------------

export interface FleetHopSpoolFold {
  /** Contract-valid pending rows — every one still awaits delivery confirmation. */
  hops: number;
  /** Of those, rows the writer marked test:true synthetic traffic. */
  testHops: number;
  /** Distinct station labels across the rows (the lifecycle points hops exited at). */
  stations: Set<string>;
  /** Distinct UTC days the pending rows' timestamps fall on. */
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
  /** Non-blank lines that failed the writer's row contract. */
  malformed: number;
}

/**
 * Pure: fold spool text(s) — oldest first — into pending-delivery
 * evidence. There is no window: every parsed row is a hop still
 * waiting, so rows of any age count; only lines that fail the writer's
 * row contract are skipped, never guessed.
 */
export function foldFleetHopSpool(texts: readonly string[]): FleetHopSpoolFold {
  const fold: FleetHopSpoolFold = { hops: 0, testHops: 0, stations: new Set(), days: new Set(), firstMs: null, lastMs: null, malformed: 0 };
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fold.malformed++;
        continue;
      }
      const hop = projectHop(parsed);
      if (hop === null) { fold.malformed++; continue; }
      fold.hops += 1;
      if (hop.test) fold.testHops += 1;
      fold.stations.add(hop.station);
      fold.days.add(dayOf(hop.tsMs));
      fold.firstMs = fold.firstMs === null ? hop.tsMs : Math.min(fold.firstMs, hop.tsMs);
      fold.lastMs = fold.lastMs === null ? hop.tsMs : Math.max(fold.lastMs, hop.tsMs);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface FleetHopSpoolCell {
  kind: 'fleet-hop-spool';
  /** Contract-valid pending rows in the retained tail. */
  hops: number;
  /** Of those, rows marked test:true. */
  testHops: number;
  /** Distinct station labels seen, capped for the prompt. */
  stations: number;
  stationSample: string[];
  /** Sorted distinct UTC days the pending rows span. */
  days: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** Spool file size in bytes when it could be statted; null when unknown. */
  spoolBytes: number | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

/**
 * Pure: the recurring bars one cell must clear — pending rows across
 * distinct UTC days, the fleet's RECURRING_FAILURES convention applied
 * to undelivered telemetry. At most one cell exists: the adverse
 * condition is the delivery pipe itself, not any per-hop attribute.
 */
export function fleetHopSpoolCells(
  fold: FleetHopSpoolFold,
  opts: { lowerBound?: boolean; spoolBytes?: number | null } = {},
): FleetHopSpoolCell[] {
  if (fold.hops < FLEET_HOP_SPOOL_MIN_ROWS || fold.days.size < FLEET_HOP_SPOOL_MIN_DAYS) return [];
  const sample = [...fold.stations].sort().slice(0, MAX_PROMPT_STATIONS);
  return [{
    kind: 'fleet-hop-spool',
    hops: fold.hops,
    testHops: fold.testHops,
    stations: fold.stations.size,
    stationSample: sample,
    days: [...fold.days].sort(),
    firstSeen: isoOrNull(fold.firstMs),
    lastSeen: isoOrNull(fold.lastMs),
    spoolBytes: opts.spoolBytes ?? null,
    lowerBound: opts.lowerBound === true,
  }];
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/telemetry/fleet-hop-spool.jsonl — fleetHopSpoolPath in src/core/observability/fleet-hop.ts resolves it under the user\'s home — one queue.v1 fleet_hop event per line, appended by spool() whenever deliver() cannot confirm the PostHog capture POST (a failed send or a missing POSTHOG_AGENT_FLEET_TOKEN, whose name appears in the file\'s own delivery detail only as \'no key\'). Until now the file\'s only readers were point-in-time: collectFleetHopEvents (src/core/observability/rollup.ts) scans it as the merged-PR cost rollup\'s undelivered floor and replayFleetHopSpool retries it — but nothing scheduled the replay and no fold ever asked whether telemetry egress was working, so hops backing up across days never became work.';

const REPRO = 'Reproduce the fold by reading ~/.ashlr/telemetry/fleet-hop-spool.jsonl directly and keeping lines that parse as {event:\'fleet_hop\', timestamp, distinct_id, properties:{schema:\'queue.v1\', station, ...}}, then counting distinct UTC days across the envelope timestamps. The writer, delivery and replay this repository owns are src/core/observability/fleet-hop.ts (buildFleetHop, deliver, spool, replayFleetHopSpool) behind scripts/fleet-hop.mjs; the local consumer is collectFleetHopEvents in src/core/observability/rollup.ts.';

const NO_CHANGE = 'If `phantom exec -- node scripts/fleet-hop.mjs --replay` has since drained the spool the file will be small or absent on the next read; if this host intentionally runs unkeyed — the fleet hop pipe is opt-in telemetry, not a correctness dependency — the accumulation is a known parked outbox rather than a defect; if the pending rows are all test:true synthetic traffic on a host that never emits real hops, the pipe is idle by design. In each case report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: FleetHopSpoolCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Oldest pending hop recorded ${cell.firstSeen}.`
    : ` Pending hops recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: FleetHopSpoolCell): string =>
  cell.lowerBound ? ' The bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full spool.' : '';

const bytesText = (cell: FleetHopSpoolCell): string =>
  cell.spoolBytes === null ? '' : ` The spool file is ${cell.spoolBytes} bytes and the append path has no cap.`;

function fleetHopSpoolPrompt(cell: FleetHopSpoolCell): string {
  const testText = cell.testHops > 0 ? ` ${cell.testHops} row(s) are marked test:true synthetic traffic.` : '';
  const stationText = cell.stations > 0
    ? ` ${cell.stations} distinct station(s) appear${cell.stationSample.length > 0 ? ` (${cell.stationSample.join(', ')})` : ''}.`
    : '';
  const detail = [
    'Phantom\'s fleet-hop telemetry spool keeps holding hops PostHog never confirmed',
    '',
    `${cell.hops} fleet_hop event(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) still sit in ~/.ashlr/telemetry/fleet-hop-spool.jsonl — the self-improvement work this backlog exists for.`,
    '',
    `Each line is one queue.v1 fleet_hop event emitFleetHop could not deliver: the POST to the PostHog capture endpoint failed or POSTHOG_AGENT_FLEET_TOKEN was unset in the emitting environment, so deliver() appended it to the spool instead of sending. Nothing drains the spool on a schedule — replayFleetHopSpool runs only through a manual \`phantom exec -- node scripts/fleet-hop.mjs --replay\` — so an event stays until a replay succeeds, and the file grows without bound while the pipe stays broken.${testText}${stationText}${seenText(cell)}${bytesText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    'Find why hops keep failing delivery: check whether POSTHOG_AGENT_FLEET_TOKEN is set in the environment the emitting `phantom exec` wrappers run under (names only — never print the value), whether the PostHog host is reachable from the emitting hosts, and whether a scheduled replay should exist — today only a manual --replay drains the spool, so even a recovered endpoint leaves events parked until someone runs it, and replayFleetHopSpool reads the whole file into memory on each pass. If the growth is bounded and recent, the pipe may be mid-recovery; if it spans weeks, egress has been dark that long. Fix what lives here — the emit/deliver/spool path in src/core/observability/fleet-hop.ts, a scheduled drain, or the emitting wrappers\' environment — not the symptom.',
    '',
    NO_CHANGE,
    '',
    REPRO,
  ];
  return detail.join('\n');
}

function fleetHopSpoolTitle(): string {
  return 'Fleet-hop telemetry spool keeps undelivered hops'.slice(0, MAX_TITLE_CHARS);
}

function fleetHopSpoolItem(cell: FleetHopSpoolCell, repo: string): CloudBacklogItem {
  return {
    id: `fleet-hop-${sha('fleet-hop-spool')}`,
    title: fleetHopSpoolTitle(),
    prompt: fleetHopSpoolPrompt(cell),
    area: 'fleet-telemetry',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** File size for the prompt's growth evidence; null when it cannot be statted as a regular file. */
async function spoolSize(spoolPath: string): Promise<number | null> {
  try {
    const info = await stat(spoolPath);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Backlog items for the fleet-hop spool's recurring undelivered
 * evidence. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function fleetHopSpoolBacklogItems(opts: FleetHopSpoolItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const spoolPath = opts.spoolPath ?? fleetHopSpoolPath();
    const read = await readLedgerTail(spoolPath, FLEET_HOP_SPOOL_TAIL_BYTES);
    if (read.state !== 'read') return [];
    // The spool is pending state, not an event stream: every parsed row
    // awaits delivery, so the fold counts all of them — the tail's
    // truncated flag, not a time window, bounds the evidence.
    const fold = foldFleetHopSpool([read.text]);
    const cells = fleetHopSpoolCells(fold, { lowerBound: read.truncated, spoolBytes: await spoolSize(spoolPath) });
    const limit = Math.max(1, Math.min(opts.limit ?? FLEET_HOP_SPOOL_BACKLOG_MAX_ITEMS, FLEET_HOP_SPOOL_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => fleetHopSpoolItem(cell, repo));
  } catch {
    return [];
  }
}
