/**
 * Nodes-offload evidence → self-improvement backlog items.
 *
 * `phm nodes offload` is the opt-in rule that sends a ready job to
 * another computer when this one would hold the launch
 * (src/core/fleet/nodes-offload.ts). Whenever the saved setting is on
 * and a run is live, recordOffloadMoves appends one
 * `phantom.nodes-offload-event.v1` row per moved job to
 * nodes-offload-events.jsonl under the Phantom home ($ASHLR_HOME when
 * absolute, else ~/.ashlr — ashlrHome()'s own resolution):
 *
 *   {schema, schemaVersion, at, job, lane, from, to, reasons, why}
 *
 *   - reasons is the host guard's hold verdict: 'load' (the launch
 *     guard is waiting, or the load ratio reads bad) and/or 'memory'
 *     (the engine-admission memory gate holds launches), recorded as
 *     the assessHostGuard HoldReason union.
 *   - to is the peer computer the job was chosen for; lane is the
 *     market lane that was shed.
 *
 * Until now the journal's only reader was readRecordedOffloads — the
 * writer's own job-id dedupe that keeps a second run from recording
 * the same choice twice. That is a write-side read, not a trend: a
 * host whose guard keeps holding launches while peers keep absorbing
 * the shed work never became work, even though each recorded move is
 * fleet capacity leaving this computer and a decision the fleet's own
 * machinery made.
 *
 * nodesOffloadBacklogItems carries the journal into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; rows are validated by their own fields —
 *    the event schema and version, a worktree-name-shaped job id, a
 *    parseable in-window timestamp, and a non-empty reasons array
 *    whose every element is a known HoldReason — and nothing is
 *    written and no network is touched.
 *  - Missing or unreadable evidence yields no items. An absent,
 *    non-file or unreadable journal reads as no evidence — unknown
 *    stays unknown, never a guessed tally — while a truncated tail
 *    still folds the retained rows with the prompts stating the
 *    counts as lower bounds.
 *  - Only moves are evidence. The journal records decisions, not
 *    stays: planOffload's stay reasons live only in the
 *    `phm nodes offload` report, so a quiet journal cannot be read
 *    as "the host was never busy" — it may equally mean the feature
 *    is off, no peer was ready, or nothing was queued. The fold
 *    claims only what the rows record.
 *  - Recurring means recorded, distinct and spanning days. A kind
 *    cell emits only at NODES_OFFLOAD_RECURRING distinct job ids
 *    inside the window AND NODES_OFFLOAD_MIN_DAYS separate UTC days,
 *    so one busy afternoon shedding a batch never queues a session —
 *    the same two-day bar the sibling sparse journals apply.
 *  - The hold kinds stay separate because they are different gates:
 *    'load' is the launch guard / load-ratio verdict, 'memory' is the
 *    engine-admission memory gate — a policy hold, distinct from the
 *    swapout-pressure samples memory-backlog folds — and 'load+memory'
 *    is a row whose guard reported both. A job recorded once still
 *    counts once: the writer dedupes by job id for the life of the
 *    journal, and the fold dedupes defensively the same way.
 *  - The evidence carries no repository dimension — it describes this
 *    install's host and fleet machinery. Items therefore emit only
 *    when the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. The item id hashes the cell identity (the
 *    hold kind — never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new; a quiet window stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, lane and node strings are scrubbed,
 *    flattened and capped, example job ids must match the job-id
 *    shape before they are quoted, and the brief carries the usual
 *    no-change escape.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; there are only three hold kinds, so the cap is headroom. */
export const NODES_OFFLOAD_MAX_ITEMS = 8;
const NODES_OFFLOAD_ITEM_HARD_MAX = 25;
/**
 * Distinct jobs one hold-kind cell needs inside the window before it
 * counts as recurring — the fleet's RECURRING_FAILURES convention the
 * sibling feeds apply to their own tallies.
 */
export const NODES_OFFLOAD_RECURRING = 3;
/**
 * Distinct UTC days those jobs must span: the journal only records
 * when a peer actually took a job, so a single saturated afternoon
 * can mint a batch in one tick — recurrence across days is the claim.
 */
export const NODES_OFFLOAD_MIN_DAYS = 2;
/**
 * Evidence window: the journal is sparse by construction — off by
 * default, one row per job ever, only while a peer has a free slot —
 * so a week of moves gives recurring patterns room without letting
 * stale evidence linger (the sibling feeds' 7-day convention).
 */
export const NODES_OFFLOAD_WINDOW_HOURS = 168;
/** Bounded tail for the offload journal; a row is ~300 bytes so this covers thousands of moves. */
const NODES_OFFLOAD_TAIL_BYTES = 512 * 1024;
/** Journal file name under the Phantom home, the writer's own constant value (nodes-offload.ts eventsPath). */
const OFFLOAD_JOURNAL_FILE = 'nodes-offload-events.jsonl';
/** The job-id shape the queue mints; anything else is a foreign or corrupt row. */
const OFFLOAD_JOB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Lane/node strings are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_LANE_CHARS = 60;
const MAX_NODE_CHARS = 80;
/** Distinct lane/node tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example job ids quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** The fleet's own repository label: offload evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/**
 * The writer's own event-schema constant (NODES_OFFLOAD_EVENT_SCHEMA in
 * src/core/fleet/nodes-offload.ts), inlined so this reader validates the
 * persisted contract without importing the fleet module — an import would
 * pull the nodes-doctor/nodes-plan/provider-binary cluster into the
 * Tier-1 authority import closure for a string literal.
 */
const OFFLOAD_EVENT_SCHEMA = 'phantom.nodes-offload-event.v1';
/** The writer's HoldReason union members; a row naming anything else is corrupt, not a new kind. */
const KNOWN_HOLD_REASONS: ReadonlySet<string> = new Set(['load', 'memory']);

export interface NodesOffloadItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: join(ashlrHome(), 'nodes-offload-events.jsonl'), the writer's own resolution). */
  eventsPath?: string;
  /** Evidence window in hours (default NODES_OFFLOAD_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default NODES_OFFLOAD_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * The hold signatures a validated row can carry: the sorted HoldReason
 * set joined with '+' — 'load', 'memory' or 'load+memory'. Separate
 * kinds because they are separate gates with separate fixes.
 */
export type OffloadHoldKind = 'load' | 'memory' | 'load+memory';

/** One validated offload event: the job that moved, its hold signature, where it went and when (epoch ms). */
export interface NodesOffloadAction {
  job: string;
  kind: OffloadHoldKind;
  /** Sanitized market lane the job was shed under, or 'unknown' when the row recorded none. */
  lane: string;
  /** Sanitized peer node name the job was chosen for, or 'unknown'. */
  to: string;
  atMs: number;
}

export interface NodesOffloadTally {
  /** Sanitized recorded text (a lane or node name). */
  text: string;
  count: number;
}

/** One hold-kind cell: distinct jobs shed under that signature plus the recorded detail the prompt quotes. */
export interface NodesOffloadCell {
  kind: OffloadHoldKind;
  /** Distinct job ids the journal recorded moving inside the window. */
  count: number;
  /** Distinct UTC days those jobs' events fall on. */
  days: number;
  /** Recorded market lanes, most frequent first (capped at MAX_PROMPT_TALLIES). */
  lanes: NodesOffloadTally[];
  /** Recorded destination nodes, most frequent first. */
  nodes: NodesOffloadTally[];
  /** Up to MAX_EXAMPLES job ids. */
  jobs: string[];
  /** ISO bounds of the cell's recorded moves; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the journal's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): NodesOffloadTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const inWindow = (atMs: number, cutoffMs: number, nowMs: number): boolean =>
  atMs >= cutoffMs && atMs <= nowMs;

/**
 * Pure: the emit-worthy rows of a nodes-offload-events.jsonl tail. Only
 * rows whose own fields validate count — the event schema and version,
 * a job-id-shaped job, an in-window timestamp that is not in the
 * future, and a non-empty reasons array whose every element is a known
 * HoldReason. Foreign schemas, corrupt reason lists, malformed JSON,
 * untimestamped and future-stamped rows are all skipped, never guessed.
 */
export function parseOffloadRows(text: string, cutoffMs: number, nowMs: number): NodesOffloadAction[] {
  const out: NodesOffloadAction[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (r['schema'] !== OFFLOAD_EVENT_SCHEMA || r['schemaVersion'] !== 1) continue;
    const job = r['job'];
    if (typeof job !== 'string' || !OFFLOAD_JOB_PATTERN.test(job)) continue;
    const reasons = r['reasons'];
    if (!Array.isArray(reasons) || reasons.length === 0) continue;
    const kindParts = new Set<string>();
    let corrupt = false;
    for (const reason of reasons) {
      if (typeof reason !== 'string' || !KNOWN_HOLD_REASONS.has(reason)) { corrupt = true; break; }
      kindParts.add(reason);
    }
    if (corrupt || kindParts.size === 0) continue;
    const kind = [...kindParts].sort().join('+') as OffloadHoldKind;
    const atMs = parseLedgerTs(r['at']);
    if (atMs === null || !inWindow(atMs, cutoffMs, nowMs)) continue;
    const lane = typeof r['lane'] === 'string' && r['lane'].trim() !== '' ? fieldText(r['lane'], MAX_LANE_CHARS) || 'unknown' : 'unknown';
    const to = typeof r['to'] === 'string' && r['to'].trim() !== '' ? fieldText(r['to'], MAX_NODE_CHARS) || 'unknown' : 'unknown';
    out.push({ job, kind, lane, to, atMs });
  }
  return out;
}

/**
 * Pure: fold validated offload events into per-kind cells. A job the
 * journal recorded twice still counts once — the writer dedupes by job
 * id for the life of the file and the fold keeps the first record, so
 * lane/node tallies and the day span describe distinct moved jobs, not
 * repeated rows.
 */
export function foldOffloadCells(
  actions: readonly NodesOffloadAction[],
  lowerBound = false,
): NodesOffloadCell[] {
  const cells = new Map<OffloadHoldKind, Map<string, { lane: string; to: string; atMs: number }>>();
  for (const action of actions) {
    let jobs = cells.get(action.kind);
    if (jobs === undefined) {
      jobs = new Map();
      cells.set(action.kind, jobs);
    }
    if (!jobs.has(action.job)) jobs.set(action.job, { lane: action.lane, to: action.to, atMs: action.atMs });
  }
  return [...cells.entries()]
    .map(([kind, jobs]) => {
      const lanes = new Map<string, number>();
      const nodes = new Map<string, number>();
      const days = new Set<string>();
      let firstMs: number | null = null;
      let lastMs: number | null = null;
      for (const rec of jobs.values()) {
        bump(lanes, rec.lane);
        bump(nodes, rec.to);
        days.add(new Date(rec.atMs).toISOString().slice(0, 10));
        firstMs = firstMs === null ? rec.atMs : Math.min(firstMs, rec.atMs);
        lastMs = lastMs === null ? rec.atMs : Math.max(lastMs, rec.atMs);
      }
      return {
        kind,
        count: jobs.size,
        days: days.size,
        lanes: tallyOf(lanes, MAX_PROMPT_TALLIES),
        nodes: tallyOf(nodes, MAX_PROMPT_TALLIES),
        jobs: [...jobs.keys()].slice(0, MAX_EXAMPLES),
        firstSeen: firstMs === null ? null : new Date(firstMs).toISOString(),
        lastSeen: lastMs === null ? null : new Date(lastMs).toISOString(),
        lowerBound,
      };
    })
    .sort((a, b) => b.count - a.count || b.days - a.days || a.kind.localeCompare(b.kind));
}

const NO_CHANGE = 'If the window has rolled forward, the moves were a one-off burst the fleet absorbed, the shed lanes and peer picks were the right ones and the moved jobs landed well, the feature is off or no peer was ready during the recorded span, or the cause is owner-only or pinned ops machinery (host hardware and capacity, credentials, billing, the Security-reviewed dispatchd/launcher/publish files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the write-only-journal gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is nodes-offload-events.jsonl under the Phantom home ($ASHLR_HOME when absolute, else ~/.ashlr — ashlrHome()\'s resolution, the same path eventsPath() in src/core/fleet/nodes-offload.ts writes). `phm nodes offload` appends one phantom.nodes-offload-event.v1 row per moved job only while the saved setting is on and the run is live — a dry run and an off setting record nothing, and readRecordedOffloads keeps each job to one row for the life of the journal, so the file is a sparse decision log, not a heartbeat. `phm nodes offload --dry-run` shows the current plan, `phm nodes offload on|off` flips the setting, and `phm nodes doctor` / `phm nodes --json` show the peer readiness and free slots the plan read. Until this feed the journal\'s only reader was that job-id dedupe inside the writer — a write-side read, never a trend.';

/** What this repository owns on the offload path, stated once for every kind. */
const OWNERSHIP = 'The whole decision path is this repository\'s own: assessHostGuard and planOffload in src/core/fleet/nodes-offload.ts turn the host guard — readHostLoad\'s load average (src/core/fleet/host-load.ts), parseAdmissionCtl\'s launch-guard file (src/core/fleet/load-owners.ts) and readEngineAdmission\'s memory gate (src/core/fleet/engine-admission-view.ts) — plus the peer view (nodes-view.ts, nodes-doctor.ts) into moves, and remoteLaneCap in src/core/fleet/unfed-market.ts maps market lanes to the caps a remote node needs; src/cli/nodes.ts wires the reads. What this repository does not own is the host\'s real capacity — its hardware and whatever else runs on it — or ops-pinned machinery (contrib/mac, Security-reviewed, re-pinned, never edited live).';

function tallyText(tallies: readonly NodesOffloadTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: NodesOffloadCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function boundText(cell: NodesOffloadCell): string {
  return cell.lowerBound ? ' The journal tail was truncated, so these counts are a lower bound.' : '';
}

function laneText(cell: NodesOffloadCell): string {
  return cell.lanes.length === 0 ? '' : ` Shed lanes: ${tallyText(cell.lanes)}.`;
}

function nodeText(cell: NodesOffloadCell): string {
  return cell.nodes.length === 0 ? '' : ` Destination computers: ${tallyText(cell.nodes)}.`;
}

function jobsText(cell: NodesOffloadCell): string {
  return cell.jobs.length === 0 ? '' : ` Example job ids: ${cell.jobs.join(', ')}.`;
}

const KIND_LEAD: Record<OffloadHoldKind, { title: string; held: string; gate: string }> = {
  load: {
    title: 'Offloaded jobs keep leaving this host on load holds',
    held: 'the launch guard was waiting or the load ratio read bad',
    gate: 'the load verdict — parseAdmissionCtl\'s launch-guard file and readHostLoad\'s load average against the cores',
  },
  memory: {
    title: 'Offloaded jobs keep leaving this host on memory-gate holds',
    held: 'the engine-admission memory gate held launches',
    gate: 'the memory verdict — readEngineAdmission\'s gated/allowed reading',
  },
  'load+memory': {
    title: 'Offloaded jobs keep leaving this host on load and memory holds',
    held: 'both the load verdict and the memory gate held launches',
    gate: 'both verdicts together — the launch guard or load ratio AND the engine-admission memory gate',
  },
};

function offloadPrompt(cell: NodesOffloadCell): string {
  const lead = KIND_LEAD[cell.kind];
  return [
    `Phantom's opt-in node offload keeps moving ready jobs off this computer — ${cell.count} distinct job(s) recorded moving to peer computers on ${cell.days} separate UTC day(s) inside the window, each time because ${lead.held}.`,
    '',
    `Every recorded move is a launch this host's guard held while a peer passed \`phm nodes doctor\` with a free slot for the lane.${laneText(cell)}${nodeText(cell)}${jobsText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `${OWNERSHIP} The recurring claim is ${lead.gate}: whether the guard's thresholds hold launches too eagerly (shed work that peers absorb at a cost), whether the shed lanes are the right ones to move — remoteLaneCap decides which market lanes a remote node can serve at all — and whether one peer is absorbing a disproportionate share. A host that is genuinely saturated is a capacity signal, not a bug; the fold cannot tell correct shedding from mis-tuned gates, so the session must weigh the recorded lanes and destinations against what the fleet's own admission and lane-cap rules intend.`,
    '',
    `Find whether the recurring holds are accurate (the host really is saturated and the moves landed well — then the work is capacity, not code) or whether the gate thresholds, the lane-to-cap mapping or the peer pick are shedding the wrong work. Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function nodesOffloadItem(cell: NodesOffloadCell, repo: string): CloudBacklogItem {
  const id = `fleet-nodes-offload-${createHash('sha256').update(`offload:${cell.kind}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: KIND_LEAD[cell.kind].title.slice(0, MAX_TITLE_CHARS),
    prompt: offloadPrompt(cell),
    area: 'nodes-offload',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the nodes-offload journal's recurring hold-kind
 * cells. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function nodesOffloadBacklogItems(opts: NodesOffloadItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const eventsPath = opts.eventsPath ?? join(ashlrHome(), OFFLOAD_JOURNAL_FILE);
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - (opts.windowHours ?? NODES_OFFLOAD_WINDOW_HOURS) * 3_600_000;
    const tail = await readLedgerTail(eventsPath, NODES_OFFLOAD_TAIL_BYTES);
    const actions = tail.state === 'read' ? parseOffloadRows(tail.text, cutoffMs, nowMs) : [];
    if (actions.length === 0) return [];
    const cells = foldOffloadCells(actions, tail.state === 'read' && tail.truncated === true)
      .filter((cell) => cell.count >= NODES_OFFLOAD_RECURRING && cell.days >= NODES_OFFLOAD_MIN_DAYS);
    const limit = Math.max(1, Math.min(opts.limit ?? NODES_OFFLOAD_MAX_ITEMS, NODES_OFFLOAD_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => nodesOffloadItem(cell, repo));
  } catch {
    return [];
  }
}
