/**
 * Comms-agent run journal → self-improvement backlog items.
 *
 * `phm comms-agent run` is the Comms role's pass: it triages the local
 * inbox, archives bulk and bot mail, and puts every drafted reply
 * through the send policy (runCommsAgent in
 * src/core/comms-agent/run.ts). Every completed pass appends one
 * `comms-agent.run.v1` record to runs.jsonl under the comms-agent
 * directory of the runs root ($ASHLR_RUNS_DIR when set, else
 * ~/.ashlr-runs — commsRunsRoot()'s own resolution in
 * src/core/comms-agent/store.ts):
 *
 *   {at, schema, lane, laneReason,
 *    triage: {kept, archived, drafted, deleted},
 *    sends: [{transport, recipient, status, reason}], summaries?}
 *
 *   - status is 'sent' | 'drafted' | 'refused'. 'sent' is the only
 *     delivery; 'drafted' parks the reply for owner approval or
 *     records an outcome the pass could not confirm; 'refused' is the
 *     policy, trust or channel layer declining the send.
 *   - reason is a producer string — decideSend's policy vocabulary
 *     (src/core/comms-agent/policy.ts), run.ts's own gate and delivery
 *     strings, or whatever a ChannelAdapter returned. Reasons are
 *     free text at the adapter boundary, so this fold never quotes
 *     them: it classifies each into a closed reason class and counts
 *     outcomes by (transport, status, class) only.
 *
 * Until now the journal's only reader was readRunJournal →
 * commsStatus's last-pass display: a point-in-time "when did the role
 * last complete a pass" answer, never a trend. A transport whose
 * sends kept being refused for the same machinery reason — no
 * registered adapter, an untrusted approvals file, a bus store that
 * never accepts — or whose approved replies kept drafting because no
 * delivery path exists looked identical to a healthy quiet week.
 * commsRunBacklogItems carries the journal into discoverBacklog so
 * `phm improve discover` and the scheduler's autoDiscover queue the
 * recurring failures like the sibling fleet-evidence sources.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. runs.jsonl is read once through readLedgerTail's
 *    bounded no-follow tail; records are validated by their own
 *    fields — the run schema, a parseable in-window completion
 *    timestamp, and sends whose transport sits inside the producer's
 *    closed transport vocabulary with a known status — and nothing is
 *    written and no network is touched. A missing, unreadable or
 *    non-file journal yields no items; a truncated tail still folds
 *    the retained records with the prompts stating the counts as
 *    lower bounds.
 *  - Only non-deliveries are evidence. 'sent' rows never count, and
 *    the designed states are excluded by exact producer string: the
 *    KILL/pause refusals and the owner standing-approval draft are
 *    the send policy working as intended, not failures.
 *  - Recurring means recorded across passes and days: a cell emits
 *    only at COMMS_RUN_MIN_PASSES distinct completed passes across
 *    COMMS_RUN_MIN_DAYS distinct UTC days inside the window, so one
 *    pass's burst of failed sends and one bad day never queue a
 *    session.
 *  - The evidence carries no repository dimension — it describes this
 *    install's comms machinery. Items therefore emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Recipients are handles and reasons can carry adapter free text:
 *    neither is ever quoted into an id, title or prompt. The item id
 *    hashes the cell identity (transport, status, reason class —
 *    never counts, timestamps or free text), so a refresh re-derives
 *    the same id and a recovered cell simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; cells are bounded by transport x status x class diversity. */
export const COMMS_RUN_MAX_ITEMS = 10;
const COMMS_RUN_ITEM_HARD_MAX = 25;
/** A cell emits only at this many distinct completed passes inside the window... */
export const COMMS_RUN_MIN_PASSES = 3;
/** ...across at least this many distinct UTC days. */
export const COMMS_RUN_MIN_DAYS = 2;
/** Evidence window: the sibling fleet-evidence convention. */
export const COMMS_RUN_WINDOW_HOURS = 168;
/** Newest-bytes bound on the run journal; a record is ~1-4 KB so this covers hundreds of passes. */
const COMMS_RUN_TAIL_BYTES = 1024 * 1024;
/** Journal path under the runs root: commsDir(runsDir)/runs.jsonl in the producer's own layout. */
const COMMS_RUN_JOURNAL_RELATIVE = join('comms-agent', 'runs.jsonl');
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: comms-run evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Reason strings are producer text; anything past this bound is foreign and classifies as 'other'. */
const MAX_REASON_CHARS = 1024;

/**
 * The producer's transport vocabulary, mirrored from COMMS_TRANSPORTS in
 * src/core/comms-agent/policy.ts and inlined so this reader validates the
 * persisted contract without importing the policy module — an import would
 * pull the comms pause state and sandbox kill-switch readers into the
 * improve bundle for seven string literals.
 */
const COMMS_TRANSPORTS: ReadonlySet<string> = new Set([
  'email', 'imessage', 'linkedin', 'bus', 'slack', 'telegram', 'handoff',
]);
/** The producer's record schema literal (CommsRunRecord.schema in store.ts), inlined for the same reason. */
const COMMS_RUN_SCHEMA = 'comms-agent.run.v1';

/**
 * The closed reason classes this fold reports. 'other' is honest, not a
 * gap: adapter and connector reasons are free text at the producer
 * boundary, so an unrecognized string still counts as a non-delivery —
 * it just cannot be named beyond 'other'.
 */
export type CommsReasonClass =
  | 'no-adapter'
  | 'no-connector'
  | 'delivery-unknown'
  | 'approvals-file'
  | 'send-policy'
  | 'channel'
  | 'other';

/**
 * Producer reason strings that are designed states, never evidence:
 * the KILL and pause refusals (operator holds) and the owner
 * standing-approval draft (the policy's normal first-contact path —
 * every novel recipient drafts by design). Exact matches only; the
 * strings are the producers' own literals.
 */
const DESIGNED_REASONS: ReadonlySet<string> = new Set([
  'KILL halts all sends.',
  'Communications are paused.',
  'No owner standing approval for this recipient. Novel recipients need the owner.',
]);

/**
 * Recognized adverse reason strings, mirrored from the producers:
 * run.ts's gate and delivery strings, decideSend's policy refusals in
 * policy.ts, channel-policy.ts's envelope gate, and the built-in bus
 * adapter's DeliverResult vocabulary (adapters/bus.ts — the handoff
 * adapter delegates to the same deliverLocalEnvelope). Anything not
 * listed — including adapter- or connector-supplied free text — is
 * 'other'.
 */
const REASON_CLASS: ReadonlyMap<string, CommsReasonClass> = new Map([
  ['No channel adapter is available.', 'no-adapter'],
  ['No sanctioned LinkedIn connector is registered.', 'no-connector'],
  ['Delivery outcome unknown; reconcile before retry.', 'delivery-unknown'],
  ['Standing approvals file is not a private owner file.', 'approvals-file'],
  ['Approval overrides are refused.', 'approvals-file'],
  ['Unknown transport.', 'send-policy'],
  ['Credentials must be Phantom Secrets handles.', 'send-policy'],
  ['Recipient is missing.', 'send-policy'],
  ['Message text is not sendable.', 'send-policy'],
  ['LinkedIn sends only through an official API or a sanctioned connector.', 'send-policy'],
  ['Recipient is not an explicitly allowlisted team identity.', 'channel'],
  ['Communication approval is not confirmed.', 'channel'],
  ['Envelope is not a valid bus message.', 'channel'],
  ['Envelope is for a different channel.', 'channel'],
  ['Bus store is busy.', 'channel'],
  ['Bus store refused the envelope.', 'channel'],
]);
/** decideSend's templated LinkedIn refusal (`LinkedIn mode ${mode} is not sendable.`). */
const LINKEDIN_MODE_REFUSAL = /^LinkedIn mode .{1,64} is not sendable\.$/;

export interface CommsRunItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding comms-agent/runs.jsonl; $ASHLR_RUNS_DIR wins when set, else <home>/.ashlr-runs. */
  runsDir?: string;
  /** Journal override (default: join(runsDir, 'comms-agent', 'runs.jsonl'), the producer's own layout). */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default COMMS_RUN_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default COMMS_RUN_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One adverse send outcome inside a completed pass: closed-vocabulary fields only. */
export interface CommsRunSendOutcome {
  transport: string;
  status: 'refused' | 'drafted';
  reasonClass: CommsReasonClass;
}

/** One validated run record: a completed pass and its adverse send outcomes. */
export interface CommsRunPass {
  atMs: number;
  sends: CommsRunSendOutcome[];
}

/** One (transport, status, reasonClass) cell: the recurring non-delivery identity. */
export interface CommsRunCell {
  transport: string;
  status: 'refused' | 'drafted';
  reasonClass: CommsReasonClass;
  /** Distinct completed passes that recorded at least one send in this cell. */
  passes: number;
  /** Total adverse send rows folded into the cell (>= passes when a pass repeats the outcome). */
  sends: number;
  /** Distinct UTC days the cell's passes fall on. */
  days: number;
  /** ISO bounds of the cell's recorded passes; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the journal's bounded tail cut older records: counts are a lower bound. */
  lowerBound: boolean;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Classify one recorded send reason. Designed states return null —
 * they are the policy working, never evidence. Recognized adverse
 * strings map to their class; the templated LinkedIn-mode refusal is
 * 'send-policy' and every unrecognized string is 'other'.
 */
export function classifyCommsReason(reason: string): CommsReasonClass | null {
  if (DESIGNED_REASONS.has(reason)) return null;
  if (reason.length > MAX_REASON_CHARS) return 'other';
  const mapped = REASON_CLASS.get(reason);
  if (mapped !== undefined) return mapped;
  if (LINKEDIN_MODE_REFUSAL.test(reason)) return 'send-policy';
  return 'other';
}

/**
 * Pure: validate one run-journal tail into completed passes carrying
 * only their adverse send outcomes. A record counts only under the
 * producer's contract — schema 'comms-agent.run.v1', an in-window
 * non-future completion timestamp, and sends whose transport is in
 * the closed vocabulary, whose status is known, and whose reason is
 * a bounded string. 'sent' outcomes and designed reasons never reach
 * a pass. Foreign schemas, malformed JSON, untimestamped and
 * future-stamped records and shapeless sends are all skipped, never
 * guessed.
 */
export function parseCommsRunPasses(text: string, cutoffMs: number, nowMs: number): CommsRunPass[] {
  const passes: CommsRunPass[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Cheap prefilter: every valid record names the run schema.
    if (!line.includes(COMMS_RUN_SCHEMA)) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (r['schema'] !== COMMS_RUN_SCHEMA) continue;
    const atMs = parseLedgerTs(r['at']);
    if (atMs === null || atMs > nowMs || atMs < cutoffMs) continue;
    const sends = r['sends'];
    if (!Array.isArray(sends)) continue;
    const outcomes: CommsRunSendOutcome[] = [];
    for (const entry of sends) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const send = entry as Record<string, unknown>;
      const transport = send['transport'];
      const status = send['status'];
      const reason = send['reason'];
      if (typeof transport !== 'string' || !COMMS_TRANSPORTS.has(transport)) continue;
      if (status !== 'refused' && status !== 'drafted') continue;
      if (typeof reason !== 'string') continue;
      const reasonClass = classifyCommsReason(reason);
      if (reasonClass === null) continue;
      outcomes.push({ transport, status, reasonClass });
    }
    if (outcomes.length === 0) continue;
    passes.push({ atMs, sends: outcomes });
  }
  return passes;
}

/**
 * Pure: fold validated passes into per-(transport, status,
 * reasonClass) cells. A pass that recorded several sends into the
 * same cell still counts once — `passes` is the recurrence measure,
 * `sends` keeps the raw outcome count for the prompt.
 */
export function foldCommsRunCells(passes: readonly CommsRunPass[], lowerBound = false): CommsRunCell[] {
  const cells = new Map<string, {
    transport: string;
    status: 'refused' | 'drafted';
    reasonClass: CommsReasonClass;
    passes: number;
    sends: number;
    days: Set<string>;
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const pass of passes) {
    const touched = new Map<string, { send: CommsRunSendOutcome; count: number }>();
    for (const send of pass.sends) {
      const key = `${send.transport} ${send.status} ${send.reasonClass}`;
      const hit = touched.get(key);
      if (hit === undefined) touched.set(key, { send, count: 1 });
      else hit.count += 1;
    }
    for (const [key, hit] of touched) {
      let cell = cells.get(key);
      if (cell === undefined) {
        cell = {
          transport: hit.send.transport,
          status: hit.send.status,
          reasonClass: hit.send.reasonClass,
          passes: 0,
          sends: 0,
          days: new Set(),
          firstMs: null,
          lastMs: null,
        };
        cells.set(key, cell);
      }
      cell.passes += 1;
      cell.sends += hit.count;
      cell.days.add(new Date(pass.atMs).toISOString().slice(0, 10));
      cell.firstMs = cell.firstMs === null ? pass.atMs : Math.min(cell.firstMs, pass.atMs);
      cell.lastMs = cell.lastMs === null ? pass.atMs : Math.max(cell.lastMs, pass.atMs);
    }
  }
  return [...cells.values()]
    .map((cell) => ({
      transport: cell.transport,
      status: cell.status,
      reasonClass: cell.reasonClass,
      passes: cell.passes,
      sends: cell.sends,
      days: cell.days.size,
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.passes - a.passes || b.sends - a.sends
      || a.transport.localeCompare(b.transport) || a.status.localeCompare(b.status) || a.reasonClass.localeCompare(b.reasonClass));
}

const NO_CHANGE = 'If the window has rolled forward, the failures were a transient adapter, store or connector outage that has since recovered, the refusals are the send policy correctly rejecting malformed attempts (then the recurring cause lives upstream in whatever mints them — name it), the drafts are the designed owner-approval flow for recipients the owner has not approved, or the cause is owner-only — the standing-approvals file\'s mode or ownership, credentials, or a connector only the owner can sanction — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal's writer and its only prior reader are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is runs.jsonl under the comms-agent directory of the runs root (<runsDir>/comms-agent/runs.jsonl — $ASHLR_RUNS_DIR when set, else ~/.ashlr-runs; commsRunsRoot() in src/core/comms-agent/store.ts resolves it, and this fold treats an empty ASHLR_RUNS_DIR as unset rather than reading a cwd-relative path the way the producer\'s ?? fallback technically would). Every completed `phm comms-agent run` pass appends one comms-agent.run.v1 record — {at, lane, laneReason, triage, sends:[{transport, recipient, status, reason}], summaries?} — through appendRunRecord at the end of runCommsAgent in src/core/comms-agent/run.ts; a pass that fails mid-flight appends nothing, so the journal holds completed passes only. Send status is sent | drafted | refused and reason is a producer string. Until this feed the journal\'s only reader was readRunJournal → commsStatus\'s last-pass display — a point-in-time answer, never a trend. Recipient values are handles and adapter reasons are free text: this fold counts outcomes by transport, status and reason class only and never quotes either.';

/** What this repository owns on the comms path, stated once for every cell. */
const OWNERSHIP = 'The whole path is this repository\'s own: runCommsAgent, executeSend and defaultDeliver in src/core/comms-agent/run.ts drive each pass, decideSend in src/core/comms-agent/policy.ts is the send gate, the ChannelAdapter registry and the built-in bus/handoff adapters live under src/core/agents/, triageInbox shapes what becomes a draft, and appendRunRecord/readRunJournal in src/core/comms-agent/store.ts own the journal format. What this repository does not own is the owner-side standing-approvals file (~/.ashlr/comms-agent/standing-approvals.json — its trust verdicts are evidence; its contents, mode and ownership are owner state a session reports, never edits), real transport credentials (Phantom Secrets handles), or any external service an adapter reaches.';

const CLASS_TEXT: Record<CommsReasonClass, { meaning: string; hunt: string }> = {
  'no-adapter': {
    meaning: 'an approved reply kept drafting because the transport has no registered ChannelAdapter — the pass found no delivery path at all, so the send can never complete on that transport',
    hunt: 'whether a ChannelAdapter for this transport should exist (the built-ins register in src/core/agents/channel-registry.ts; adapters live under src/core/agents/adapters/), whether the transport belongs in the producer\'s COMMS_TRANSPORTS vocabulary at all, or whether triage/route should stop drafting replies for a transport that cannot deliver',
  },
  'no-connector': {
    meaning: 'LinkedIn replies keep drafting because no sanctioned connector is registered — policy.ts permits LinkedIn sends only through an official API or a sanctioned connector and refuses scrape/unspecified modes',
    hunt: 'whether a sanctioned LinkedIn connector should be registered for the lane, whether attempts carry the right linkedinMode (official-api vs sanctioned-connector vs the refused scrape/unspecified), or whether LinkedIn replies should stop being attempted until a connector exists',
  },
  'delivery-unknown': {
    meaning: 'the deliver call threw or returned an outcome the pass could not confirm, so the reply drafted for reconciliation — delivery state is genuinely unknown and is never retried blind',
    hunt: 'which adapter or connector keeps producing the unknown outcome (the reason is recorded verbatim in the journal but never quoted into prompts because adapter reasons are free text), whether the same transport keeps flapping, and whether reconciliation evidence exists so a later pass resolves the draft instead of resending',
  },
  'approvals-file': {
    meaning: 'the standing-approvals owner file failed its trust checks — or an approval override was attempted — so sends refused until the file verifies; this is owner-side file state surfaced as evidence, never something a session edits',
    hunt: 'whether ~/.ashlr/comms-agent/standing-approvals.json drifted out of its private owner-file contract (mode 0600, owner uid, no symlink, single link) — readOwnerApprovals in store.ts applies privateOwnerFile — or whether callers keep passing approval overrides the owner-file path refuses; if the file verifies clean now the cell was transient',
  },
  'send-policy': {
    meaning: 'decideSend refused the attempt itself — an unknown transport, a credential that is not a Phantom Secrets handle, an unusable recipient, unsendable (secret-shaped or oversized) text, or a LinkedIn mode the policy forbids',
    hunt: 'which upstream step keeps minting attempts the policy must refuse — triage drafting secret-shaped or oversized bodies, routeCommsLane picking outside the transport vocabulary, credential handles that are not phm_ handles, or LinkedIn attempts without a sanctioned mode — and whether each refusal is correct policy doing its job (then no-change) or a producer bug',
  },
  'channel': {
    meaning: 'the channel layer refused or drafted the envelope — a recipient that is not an allowlisted team identity, channel approval the layer cannot confirm, a malformed bus envelope, or a bus store that stayed busy or refused',
    hunt: 'whether comms envelopes keep missing the channel policy (recipients that are not registered team identities, approval state the channel layer cannot confirm) or the local bus store keeps refusing or busying — a store that stays unavailable is a bus-health signal worth naming',
  },
  'other': {
    meaning: 'the recorded reason is outside the recognized producer vocabulary — an adapter- or connector-supplied string this fold does not classify; the journal row is still a recorded non-delivery and counts as evidence',
    hunt: 'read the journal rows directly — the reason text is never quoted into prompts because adapter reasons are free text — identify which producer emitted them, and if a new adapter reason vocabulary is recurring, fold it into this classifier',
  },
};

const CLASS_TITLE: Record<CommsReasonClass, string> = {
  'no-adapter': 'no channel adapter',
  'no-connector': 'no sanctioned connector',
  'delivery-unknown': 'delivery outcome unknown',
  'approvals-file': 'approvals file untrusted',
  'send-policy': 'send-policy refusal',
  'channel': 'channel-level refusal',
  'other': 'unrecognized reason',
};

const STATUS_VERB: Record<CommsRunCell['status'], string> = {
  refused: 'keep being refused',
  drafted: 'keep stalling as drafts',
};

function seenText(cell: CommsRunCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function boundText(cell: CommsRunCell): string {
  return cell.lowerBound ? ' The journal tail was truncated, so these counts are a lower bound.' : '';
}

function commsRunPrompt(cell: CommsRunCell): string {
  const cls = CLASS_TEXT[cell.reasonClass];
  return [
    `Phantom's Comms agent keeps recording non-delivering sends on the '${cell.transport}' transport — ${cell.passes} distinct completed pass(es) across ${cell.days} separate UTC day(s) inside the window, ${cell.sends} recorded send outcome(s) in all, each ending '${cell.status}' with reason class '${cell.reasonClass}'.`,
    '',
    `Every recorded outcome is a reply the pass could not deliver: ${cls.meaning}.${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    OWNERSHIP,
    '',
    `Find whether the recurring outcome is a machinery gap this repository can close — ${cls.hunt}. Fix what lives here; if the cause is the designed owner-approval flow, correct policy doing its job, owner-side file or credential state, or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function commsRunItem(cell: CommsRunCell, repo: string): CloudBacklogItem {
  const id = `fleet-comms-run-${createHash('sha256').update(`comms-run:${cell.transport}:${cell.status}:${cell.reasonClass}`).digest('hex').slice(0, 16)}`;
  const title = `Comms '${cell.transport}' sends ${STATUS_VERB[cell.status]} (${CLASS_TITLE[cell.reasonClass]})`.slice(0, MAX_TITLE_CHARS);
  return {
    id,
    title,
    prompt: commsRunPrompt(cell),
    area: 'comms-runs',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the comms-agent run journal's recurring
 * non-delivery cells. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function commsRunBacklogItems(opts: CommsRunItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling fleet-evidence feeds apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const journalPath = opts.journalPath ?? join(runsDir, COMMS_RUN_JOURNAL_RELATIVE);
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - (opts.windowHours ?? COMMS_RUN_WINDOW_HOURS) * 3_600_000;
    const tail = await readLedgerTail(journalPath, COMMS_RUN_TAIL_BYTES);
    const passes = tail.state === 'read' ? parseCommsRunPasses(tail.text, cutoffMs, nowMs) : [];
    if (passes.length === 0) return [];
    const cells = foldCommsRunCells(passes, tail.state === 'read' && tail.truncated === true)
      .filter((cell) => cell.passes >= COMMS_RUN_MIN_PASSES && cell.days >= COMMS_RUN_MIN_DAYS);
    const limit = Math.max(1, Math.min(opts.limit ?? COMMS_RUN_MAX_ITEMS, COMMS_RUN_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => commsRunItem(cell, repo));
  } catch {
    return [];
  }
}
