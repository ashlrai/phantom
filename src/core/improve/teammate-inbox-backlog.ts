/**
 * iMessage teammate inbox → self-improvement backlog items.
 *
 * Every allowlisted non-Mason iMessage sender (teammates like Dot /
 * "Ashlr.") that is not a fleet task peer is appended to
 * <runs>/imessage/teammates.jsonl by recordTeammateText in
 * src/core/comms/imessage-teammate-inbox.ts — the intake bridges
 * (imessage-inbox-bridge.ts, imessage-findings-bridge.ts) call it for
 * verified handles the Mason receipt path does not take. The same file
 * carries the answer markers markTeammateTextsAnswered appends
 * ({answered:<rowid>, at}) — written by the teammate responder worker
 * (runTeammateResponder in imessage-teammate-worker.ts, scheduled
 * through tickLeaderNetwork and the desktop sidecar's
 * scheduleTeammateMessages) when a reply is sent or a text is
 * suppressed, and by the task ledger (imessage-teammate-tasks.ts).
 *
 * Until now the inbox's only readers were point-in-time surfaces —
 * readTeammateTexts behind `phm fleet teammate-texts`, the unified
 * comms inbox's unanswered projection, the reply-latency report and
 * the teammate-overdue owner notice — current queue state, never a
 * trend. A text row with no answered marker is the responder's own
 * recorded verdict that the text was never closed, and one that stays
 * unmarked past the staleness bar is present-tense evidence the answer
 * path is not keeping up:
 *
 *  - 'reply' texts: conversation requests and questions the worker
 *    claims, drafts and sends a reply for, then marks answered (sent
 *    or suppressed alike). A stale unmarked row means passes are not
 *    reaching it — the worker lock, the 256-reply store bound, the
 *    scan ceiling, the local model endpoint or the send transport.
 *  - 'actionable' texts: direct work requests the worker queues as
 *    RQ-DOT jobs and answers "Queued as …" — the marker lands when
 *    that reply sends, so an unmarked row means the queue-and-reply
 *    pass never reached it.
 *  - 'acknowledge' texts: substantive handoffs, receipts, blockers and
 *    coordination notes owed one short confirmation; over the hourly
 *    cap they wait but are never suppressed, so a stale unmarked row
 *    means passes are not reaching them either.
 *
 * Designed non-answers never emit, matching the worker's own buckets:
 * 'ignore' texts (protocol frames, bare acknowledgements, thin status
 * lines) are suppressed and marked by design; 'leader' texts escalate
 * to Mason's queue and are never auto-answered (counted only as
 * context); task-peer sender ids (PEERS in
 * imessage-teammate-tasks.ts — dot and instinct) use the fleet
 * envelope protocol and are excluded outright. A send-policy
 * unapproved sender, comms disabled/paused, a kill switch or a
 * non-darwin host also leaves texts unmarked by design — the fold
 * cannot see those gates, so the prompts name them and the investigating
 * session verifies before treating the cell as starvation. A teammate
 * text Mason answered directly from his own device leaves no marker
 * either; that blind spot is named in every prompt.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no lock, process
 *    or network is touched. A missing or unreadable file yields no
 *    items — unknown stays unknown, never a guessed tally — and a
 *    truncated tail folds the retained rows with the prompts stating
 *    the counts as lower bounds.
 *  - Rows count only under the writer's contract: a text row carries
 *    a positive safe-integer rowid, a parseable at, a string
 *    senderId and a string text; a marker row carries a positive
 *    safe-integer answered and a parseable at. Malformed lines and
 *    off-contract rows are counted, never guessed. Duplicate rowids
 *    fold once (first wins), and a marker only answers a text when
 *    its stamp is not before the text's — the same pairing
 *    teammate-reply-latency.ts applies.
 *  - Recurring means recorded across days, and stale means present
 *    tense. A cell emits only after TEAMMATE_INBOX_MIN_ROWS stale
 *    unmarked auto-answer texts inside the retained 7-day window span
 *    TEAMMATE_INBOX_MIN_DAYS distinct UTC days, each text older than
 *    TEAMMATE_INBOX_STALE_MS at the fold's clock — one unanswered
 *    text is an incident or queue latency, not a pattern. Answered
 *    texts count as per-intent delivered context; fresh unmarked
 *    texts are transient queue state and never count either way.
 *  - The journal is this install's comms traffic and carries no
 *    repository dimension, and the responder is this repository's
 *    machinery, so items emit only when the backlog target's
 *    repository name is 'phantom' — the same last-segment rule the
 *    sibling fleet-evidence sources apply.
 *  - Dedup is downstream. The item id embeds a stable hash of the
 *    cell's intent (never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new; shifted tallies do not spawn twin items.
 *  - No journal text is ever emitted: sender ids are hashed protocol
 *    identities counted never quoted, message text is classified into
 *    the worker's closed intent vocabulary and dropped, and every
 *    prompt string is a fixed literal.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { classifyTeammateIntent } from '../comms/imessage-teammate-inbox.js';
import { isTeammateTaskPeer } from '../comms/imessage-teammate-tasks.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; intent cells are bounded by the worker's closed vocabulary. */
export const TEAMMATE_INBOX_BACKLOG_MAX_ITEMS = 8;
const TEAMMATE_INBOX_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const TEAMMATE_INBOX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the sibling folds tolerate. */
const TEAMMATE_INBOX_FUTURE_SKEW_MS = 60_000;
/** Adverse texts a cell needs before its recurrence counts. */
export const TEAMMATE_INBOX_MIN_ROWS = 3;
/** Distinct UTC days those texts must span — recurring means recorded across days. */
export const TEAMMATE_INBOX_MIN_DAYS = 2;
/**
 * Unmarked age bar: a text younger than this is queue latency (claims,
 * the hourly acknowledge cap, scan rounds), never evidence. A day is
 * far past every responder bound — claim 2 min, question fallback
 * 15 min, stale send 30 min, daily receipt retention.
 */
export const TEAMMATE_INBOX_STALE_MS = 24 * 60 * 60 * 1000;
/**
 * Bounded tail for the journal; the inbox's own reader retains the
 * same 8 MiB (STORE_READ_BYTES in imessage-teammate-inbox.ts), so the
 * fold sees exactly the population the responder and the inbox see.
 */
const TEAMMATE_INBOX_TAIL_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: inbox evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/**
 * The worker's auto-answer intents (classifyTeammateIntent with
 * dispatchWork, the responder's own call). 'ignore' texts are
 * suppressed-and-marked noise and 'leader' texts are Mason's designed
 * escalation queue — neither is responder starvation.
 */
const AUTO_ANSWER_INTENTS = new Set(['reply', 'actionable', 'acknowledge']);

export interface TeammateInboxItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: <runsDir>/imessage/teammates.jsonl). */
  teammatesPath?: string;
  /** Runs dir override (default: $ASHLR_RUNS_DIR, else <homeDir>/.ashlr-runs — the writer's own resolution). */
  runsDir?: string;
  /** Home for the default runs dir — the writer resolves homedir()/.ashlr-runs, ignoring ASHLR_HOME (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default TEAMMATE_INBOX_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window and the staleness bar (default: now). */
  now?: Date;
  /** Window in ms (default TEAMMATE_INBOX_WINDOW_MS). */
  windowMs?: number;
}

/** One validated text row. `text` stays in memory for classification only — it is never emitted. */
export interface TeammateInboxTextRow {
  /** The chat.db ROWID the intake recorded — the text's stable identity. */
  rowid: number;
  atMs: number;
  /** Hashed sender identity (imessage:<sha256-16>); counted, never emitted. */
  senderId: string;
  text: string;
}

/** One validated answer marker row. */
export interface TeammateInboxMarkerRow {
  /** The text rowid this marker closes. */
  answeredRowid: number;
  atMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const validRowid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

const parseIso = (value: unknown): number =>
  typeof value === 'string' ? Date.parse(value) : NaN;

/**
 * Pure: classify one parsed journal line against the writer's record
 * contract. A line is either a text row ({v?, at, rowid, senderId,
 * text} — the shape isTextRow in imessage-teammate-inbox.ts requires)
 * or an answer marker ({v?, answered, at} — the shape
 * markTeammateTextsAnswered appends). Anything else is off-contract.
 * Unknown extra fields are tolerated so a writer that adds metadata
 * later does not invalidate its own history.
 */
export function parseTeammateInboxEntry(
  value: unknown,
): { kind: 'text'; row: TeammateInboxTextRow } | { kind: 'marker'; marker: TeammateInboxMarkerRow } | null {
  if (!isRecord(value)) return null;
  const atMs = parseIso(value['at']);
  if (!Number.isFinite(atMs)) return null;
  if (validRowid(value['answered'])) {
    return { kind: 'marker', marker: { answeredRowid: value['answered'], atMs } };
  }
  const rowid = value['rowid'];
  const senderId = value['senderId'];
  const text = value['text'];
  if (!validRowid(rowid)) return null;
  if (typeof senderId !== 'string' || senderId === '') return null;
  if (typeof text !== 'string') return null;
  return { kind: 'text', row: { rowid, atMs, senderId, text } };
}

/**
 * Pure: parse the journal's text into validated rows plus the count of
 * lines that were not on-contract entries — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseTeammateInboxText(text: string): {
  texts: TeammateInboxTextRow[];
  markers: TeammateInboxMarkerRow[];
  invalidRows: number;
} {
  const texts: TeammateInboxTextRow[] = [];
  const markers: TeammateInboxMarkerRow[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const entry = parseTeammateInboxEntry(value);
    if (entry === null) { invalidRows += 1; continue; }
    if (entry.kind === 'text') texts.push(entry.row);
    else markers.push(entry.marker);
  }
  return { texts, markers, invalidRows };
}

/** One evidence cell's tally: every stale unmarked auto-answer text on one worker intent. */
export interface TeammateInboxCell {
  /** The worker's auto-answer intent ('reply' | 'actionable' | 'acknowledge'). */
  intent: string;
  /** Stable cell identity for item ids and dedupe. */
  key: string;
  /** Stale unmarked texts inside the retained window. */
  rows: number;
  /** Distinct UTC days (of text arrival) those texts fall on. */
  days: Set<string>;
  firstAtMs: number;
  lastAtMs: number;
  /** Distinct hashed sender identities seen (counted, never emitted). */
  senders: Set<string>;
  /** Same-intent texts in the window that do carry an answered marker — delivered context. */
  answered: number;
}

/** Present-tense designed-hold counts, reported as context and never as cells. */
export interface TeammateInboxContext {
  /** 'leader'-intent texts unmarked past the staleness bar — Mason's designed escalation queue. */
  leaderPending: number;
  /** In-window texts from task-peer senders — envelope protocol, answered through the task ledger. */
  taskPeerTexts: number;
}

/**
 * Pure: fold validated rows into per-intent adverse cells plus the
 * designed-hold context counts. Only auto-answer-intent texts from
 * non-task-peer senders can form cells; windowing is on the text's
 * arrival stamp, answered-ness pairs markers at or after it, and the
 * recurring bars plus the staleness bar are applied here.
 */
export function foldTeammateInboxCells(
  texts: readonly TeammateInboxTextRow[],
  markers: readonly TeammateInboxMarkerRow[],
  nowMs: number,
  windowMs: number = TEAMMATE_INBOX_WINDOW_MS,
  staleMs: number = TEAMMATE_INBOX_STALE_MS,
): { cells: TeammateInboxCell[]; context: TeammateInboxContext } {
  const windowStart = nowMs - windowMs;
  const futureCeil = nowMs + TEAMMATE_INBOX_FUTURE_SKEW_MS;
  const answeredAt = new Map<number, number[]>();
  for (const marker of markers) {
    answeredAt.set(marker.answeredRowid, [...(answeredAt.get(marker.answeredRowid) ?? []), marker.atMs]);
  }
  const cells = new Map<string, TeammateInboxCell>();
  const context: TeammateInboxContext = { leaderPending: 0, taskPeerTexts: 0 };
  const seen = new Set<number>();
  for (const row of texts) {
    if (seen.has(row.rowid)) continue;
    seen.add(row.rowid);
    if (row.atMs < windowStart || row.atMs > futureCeil) continue;
    if (isTeammateTaskPeer(row.senderId)) { context.taskPeerTexts += 1; continue; }
    const answered = (answeredAt.get(row.rowid) ?? []).some((at) => at >= row.atMs);
    const intent = classifyTeammateIntent(row.text, true);
    if (intent === 'leader') {
      if (!answered && nowMs - row.atMs >= staleMs) context.leaderPending += 1;
      continue;
    }
    if (!AUTO_ANSWER_INTENTS.has(intent)) continue;
    let cell = cells.get(intent);
    if (cell === undefined) {
      cell = {
        intent, key: intent, rows: 0, days: new Set(),
        firstAtMs: Infinity, lastAtMs: -Infinity,
        senders: new Set(), answered: 0,
      };
      cells.set(intent, cell);
    }
    if (answered) { cell.answered += 1; continue; }
    if (nowMs - row.atMs < staleMs) continue;
    cell.rows += 1;
    cell.days.add(utcDayOf(row.atMs));
    cell.firstAtMs = Math.min(cell.firstAtMs, row.atMs);
    cell.lastAtMs = Math.max(cell.lastAtMs, row.atMs);
    cell.senders.add(row.senderId);
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.rows >= TEAMMATE_INBOX_MIN_ROWS && cell.days.size >= TEAMMATE_INBOX_MIN_DAYS)
    .sort((a, b) => b.rows - a.rows || b.lastAtMs - a.lastAtMs || a.key.localeCompare(b.key));
  return { cells: recurring, context };
}

/** The evidence pointers every prompt shares; the writer, its store contract and its consumers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is teammates.jsonl under <runs>/imessage — the writer\'s own layout (imessageStateDir in src/core/integrations/imessage.ts resolves $ASHLR_RUNS_DIR or ~/.ashlr-runs, ignoring ASHLR_HOME). recordTeammateText in src/core/comms/imessage-teammate-inbox.ts appends one {v, at, rowid, senderId, text} row per allowlisted non-Mason iMessage text — senderId is a one-way hash, text is scrubbed and capped — and markTeammateTextsAnswered appends {v, answered, at} markers from the responder worker (runTeammateResponder in src/core/comms/imessage-teammate-worker.ts, scheduled through tickLeaderNetwork and the desktop sidecar\'s scheduleTeammateMessages) and the task ledger (src/core/comms/imessage-teammate-tasks.ts). Until this feed the inbox\'s only readers were point-in-time surfaces — readTeammateTexts behind `phm fleet teammate-texts`, the unified comms inbox, the reply-latency report and the teammate-overdue owner notice — current queue state, never a trend.';

const NO_CHANGE = 'If comms is disabled, paused or kill-switched, the host is not darwin, every counted sender fails the send-policy approval gate (approvedTeammateHandle in src/core/comms/imessage-teammate-transport.ts), the texts were answered directly on the device (no marker is written for a manual reply), or the recorded window no longer reproduces on the default branch — report no-change and name the evidence.';

function coverageNote(truncated: boolean, invalidRows: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded tail dropped older rows, so every count is a lower bound');
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function spanText(cell: TeammateInboxCell): string {
  if (!Number.isFinite(cell.firstAtMs) || !Number.isFinite(cell.lastAtMs)) return '';
  const first = new Date(cell.firstAtMs).toISOString();
  const last = new Date(cell.lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

const INTENT_LABEL: Record<string, string> = {
  reply: 'reply',
  actionable: 'actionable',
  acknowledge: 'acknowledge',
};

function intentNote(cell: TeammateInboxCell): string {
  switch (cell.intent) {
    case 'reply':
      return 'each is a conversation request or question the responder claims, drafts and sends a reply for, then marks answered (sent or suppressed alike) — an unmarked row past the bar means responder passes are not reaching it';
    case 'actionable':
      return 'each is a direct work request the responder queues as an RQ-DOT job and answers "Queued as …" — the marker lands when that reply sends, so an unmarked row means the queue-and-reply pass never reached it';
    case 'acknowledge':
      return 'each is a substantive handoff, receipt, blocker or coordination note owed one short confirmation — over the hourly cap it waits but is never suppressed, so a stale unmarked row means passes are not reaching it';
    default:
      return 'each is an auto-answer-intent text the responder never closed';
  }
}

function contextText(context: TeammateInboxContext): string {
  const parts: string[] = [];
  if (context.leaderPending > 0) {
    parts.push(`${context.leaderPending} 'leader'-intent text(s) also sit unmarked past the bar — the designed escalation to Mason, not responder starvation`);
  }
  if (context.taskPeerTexts > 0) {
    parts.push(`${context.taskPeerTexts} task-peer text(s) were excluded — dot and instinct answer through the fleet envelope ledger, never inbox markers`);
  }
  return parts.length === 0 ? '' : ` ${parts.join('; ')}.`;
}

function cellTitle(cell: TeammateInboxCell): string {
  const intent = INTENT_LABEL[cell.intent] ?? cell.intent;
  return `Allowlisted teammate '${intent}' texts keep sitting unanswered — ${cell.rows} text(s) across ${cell.days.size} day(s)`.slice(0, MAX_TITLE_CHARS);
}

function cellPrompt(cell: TeammateInboxCell, context: TeammateInboxContext, truncated: boolean, invalidRows: number): string {
  const intent = INTENT_LABEL[cell.intent] ?? cell.intent;
  const answeredText = cell.answered > 0
    ? ` ${cell.answered} '${intent}' text(s) in the window do carry answered markers — the responder has delivered for this intent before.`
    : '';
  return [
    `Phantom's iMessage teammate inbox shows allowlisted non-Mason '${intent}' texts staying unanswered — the self-improvement work this backlog exists for.`,
    '',
    `Inside the 7-day window the inbox recorded ${cell.rows} '${intent}' text(s) still carrying no answered marker and older than 24h across ${cell.days.size} distinct UTC day(s), from ${cell.senders.size} distinct sender(s).${spanText(cell)}${answeredText}${contextText(context)}${coverageNote(truncated, invalidRows)}`,
    '',
    `${intentNote(cell)}.`,
    '',
    EVIDENCE,
    '',
    `Find why these texts keep going unmarked: read <runs>/imessage/teammate-status.json (the responder's latest {state, examined, sent, suppressed, pending, leader} report) and teammate-replies.json (per-row claimed/drafted/sending/sent/suppressed states and sendAttempts), then check the responder's schedule (tickLeaderNetwork in src/core/agents/leader-network-runtime.ts and scheduleTeammateMessages in the worker), the local model endpoint it drafts through, the send-policy approval per counted sender, the 256-reply store bound and reclaimSettled, and the scanAfter/scanCeiling fairness rounds. Verify each counted sender is actually approved before treating the cell as starvation, and check whether Mason answered any of them directly on the device — a manual reply writes no marker. Fix the cause in this repository rather than suppressing the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

function teammateInboxCellItem(cell: TeammateInboxCell, context: TeammateInboxContext, repo: string, truncated: boolean, invalidRows: number): CloudBacklogItem {
  return {
    id: `teaminbox-${sha(`teaminbox:${cell.key}`)}`,
    title: cellTitle(cell),
    prompt: cellPrompt(cell, context, truncated, invalidRows),
    area: 'teammate-inbox',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the teammate inbox's recurring stale-unanswered
 * auto-answer cells. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function teammateInboxBacklogItems(opts: TeammateInboxItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(opts.homeDir ?? homedir(), '.ashlr-runs');
    const path = opts.teammatesPath ?? join(runsDir, 'imessage', 'teammates.jsonl');
    if (typeof path !== 'string' || path === '') return [];
    const read = await readLedgerTail(path, TEAMMATE_INBOX_TAIL_BYTES);
    if (read.state !== 'read') return [];
    const parsed = parseTeammateInboxText(read.text);
    const nowMs = (opts.now ?? new Date()).getTime();
    const folded = foldTeammateInboxCells(parsed.texts, parsed.markers, nowMs, opts.windowMs ?? TEAMMATE_INBOX_WINDOW_MS);
    const limit = Math.max(1, Math.min(opts.limit ?? TEAMMATE_INBOX_BACKLOG_MAX_ITEMS, TEAMMATE_INBOX_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      if (items.length >= limit) break;
      items.push(teammateInboxCellItem(cell, folded.context, repo, read.truncated, parsed.invalidRows));
    }
    return items;
  } catch {
    return [];
  }
}
