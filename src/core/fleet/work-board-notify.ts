/** Board → source-thread notifier for Mason/Dot's Nov12 22:29 + 22:30 ET
 * orders: only meaningful work-state changes go back to the thread the
 * request came from — ASSIGNED (named owner + durable claim receipt),
 * BLOCKED (named dependency) and VERIFIED (every supplied PR, head,
 * tests or artifact field).
 * RUNNING and RECEIVED stay silent; conversational acknowledgments are
 * never posted.
 *
 * The module is transport-free: `sendNotifications` replies through
 * channel senders the caller injects, so the daemon, the CLI or a test can
 * wire the real bus/Slack paths without this file knowing a credential.
 * Once-only is durable, not incidental: a JSONL ledger under
 * `~/.ashlr-runs/work-board-notify/` dedupes across passes, and a row is
 * appended only after a send returns a durable receipt. A failed send
 * writes nothing and retries on the next pass. Delta-backed rows dedupe
 * exact normalized evidence and thread bindings, including on reentry.
 * Legacy state-only rows conservatively fence state entries because their
 * delivered evidence is unknown; same-state changes remain eligible. The
 * state key stays exposed for Set-based callers. Labels and claim
 * owners are untrusted data and grant no authority. */
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { WorkBoardResult } from '../comms/work-board.js';
import type { WorkItemEvidence, WorkItemState } from '../comms/work-item-state.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';

/** The only to-states that ever post; RUNNING and RECEIVED stay silent. */
export const BOARD_NOTIFY_STATES = ['ASSIGNED', 'BLOCKED', 'VERIFIED'] as const;
export type BoardNotifyState = typeof BOARD_NOTIFY_STATES[number];

/** One board item as the notifier needs it: the shared `listWorkBoard`
 * row plus the blocker/verification evidence the listing drops. */
export interface BoardSnapshotItem {
  id: string;
  state: WorkItemState;
  asOf: string;
  source: string;
  owner: string | null;
  claimReceipt: string | null;
  channel: string;
  channelRef: string | null;
  blocker: WorkItemEvidence['blocker'] | null;
  verified: WorkItemEvidence['verified'] | null;
}

/** Enrich a work-board listing with the blocker/verified evidence each
 * item's own classification already used. `readEvidence` is the only I/O
 * seam; items in other states need none and stay unenriched. */
export function snapshotBoard(
  board: WorkBoardResult,
  readEvidence?: (itemId: string) => WorkItemEvidence | undefined,
): BoardSnapshotItem[] {
  return board.items.map(item => {
    let blocker: BoardSnapshotItem['blocker'] = null;
    let verified: BoardSnapshotItem['verified'] = null;
    if ((item.state === 'BLOCKED' || item.state === 'VERIFIED') && readEvidence) {
      try {
        const evidence = readEvidence(item.id);
        blocker = evidence?.blocker ?? null;
        verified = evidence?.verified ?? null;
      } catch { /* A failed evidence read leaves nulls: the planner drops it loud. */ }
    }
    return { ...item, blocker, verified };
  });
}

export interface BoardTransitionEvidence {
  asOf: string;
  source: string;
  owner?: string;
  claimReceipt?: string;
  dependency?: string;
  pr?: number;
  head?: string;
  tests?: string;
  artifact?: string;
}

export interface BoardTransition {
  itemId: string;
  /** Previous state; null when the item first appears on the board. */
  from: WorkItemState | null;
  to: WorkItemState;
  evidence: BoardTransitionEvidence;
  /** Envelope channel label ('bus' for legacy envelopes carrying none). */
  sourceChannel: string;
  /** Exact channel_ref the request came in on, or null. */
  sourceThread: string | null;
}

function transitionEvidence(item: BoardSnapshotItem): BoardTransitionEvidence {
  const evidence: BoardTransitionEvidence = { asOf: item.asOf, source: item.source };
  if (item.owner !== null) evidence.owner = item.owner;
  if (item.claimReceipt !== null) evidence.claimReceipt = item.claimReceipt;
  if (item.blocker) evidence.dependency = item.blocker.dependency;
  if (item.verified) {
    const { pr, head, tests, artifact } = item.verified;
    if (pr !== undefined) evidence.pr = pr;
    if (head !== undefined) evidence.head = head;
    if (tests !== undefined) evidence.tests = tests;
    if (artifact !== undefined) evidence.artifact = artifact;
  }
  return evidence;
}

/** Diff two board snapshots into per-item transitions. Items that
 * vanished produce nothing. A state change always transitions; a
 * same-state item transitions only when its meaningful delta — the
 * normalized evidence plus channel/thread binding — actually moved, so
 * asOf-only or irrelevant-field churn stays silent. */
export function diffBoard(
  prev: readonly BoardSnapshotItem[],
  next: readonly BoardSnapshotItem[],
): BoardTransition[] {
  const before = new Map(prev.map(item => [item.id, item]));
  const transitions: BoardTransition[] = [];
  for (const item of next) {
    const prior = before.get(item.id);
    if (prior && prior.state === item.state) {
      if (!(BOARD_NOTIFY_STATES as readonly string[]).includes(item.state)) continue;
      if (snapshotDeltaMaterial(prior) === snapshotDeltaMaterial(item)) continue;
    }
    transitions.push({
      itemId: item.id,
      from: prior?.state ?? null,
      to: item.state,
      evidence: transitionEvidence(item),
      sourceChannel: item.channel,
      sourceThread: item.channelRef,
    });
  }
  return transitions;
}

export interface BoardNotice {
  itemId: string;
  state: BoardNotifyState;
  asOf: string;
  /** sha256 prefix of the meaningful-delta material; the durable dedupe
   * identity and the sender idempotency input. */
  delta: string;
  /** The bounded evidence line the thread needs: owner + claim receipt,
   * the dependency, or the labeled verification fields. */
  detail: string;
  /** Evidence source label, e.g. `claim:<receipt>` or `bus-reply:<id>`. */
  source: string;
  /** `<STATE> <itemId> as of <ISO> — <detail> (source: <source>)`. */
  text: string;
  sourceChannel: string;
  sourceThread: string | null;
}

export interface BoardPlanDrop {
  itemId: string;
  state: WorkItemState;
  reason: string;
}

export interface BoardNotifyPlan {
  notices: BoardNotice[];
  dropped: BoardPlanDrop[];
}

/** One printable line; ids, owners and dependency text are untrusted. */
const field = (value: string, max: number): string =>
  value.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').slice(0, max).trim();

export function boardNotifyLedgerKey(itemId: string, state: string, delta?: string): string {
  return delta === undefined ? `${itemId} ${state}` : `${itemId} ${state} ${delta}`;
}

// Internal provenance keys preserve the public state key without conflating
// legacy state-only proof with modern delta-backed receipts.
const provenanceKey = (itemId: string, state: string, kind: 'legacy' | 'modern'): string =>
  JSON.stringify(['board-notify-provenance', itemId, state, kind]);

const normDeltaField = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim();

/** The evidence fields a meaningful delta is computed from. */
export interface BoardNotifyDeltaFields {
  state: WorkItemState;
  channel: string;
  thread: string | null;
  owner?: string | null;
  claimReceipt?: string | null;
  dependency?: string | null;
  pr?: number;
  head?: string | null;
  tests?: string | null;
  artifact?: string | null;
}

/** Canonical meaningful-delta material for a postable state: the
 * normalized evidence the thread needs (ASSIGNED owner+claim, BLOCKED
 * dependency, VERIFIED pr/head/tests/artifact) bound to the channel and
 * thread it routes to, so a reroute is a new identity. `asOf` and the
 * source label are excluded — they move every pass and would defeat
 * dedupe. Returns null for silent states or missing evidence; the
 * planner drops those loud before keying. */
export function boardNotifyDeltaMaterial(f: BoardNotifyDeltaFields): string | null {
  let core: Record<string, string | number | null>;
  if (f.state === 'ASSIGNED') {
    const owner = normDeltaField(f.owner), claim = normDeltaField(f.claimReceipt);
    if (owner === '' || claim === '') return null;
    core = { owner, claim };
  } else if (f.state === 'BLOCKED') {
    const dependency = normDeltaField(f.dependency);
    if (dependency === '') return null;
    core = { dependency };
  } else if (f.state === 'VERIFIED') {
    const head = normDeltaField(f.head), tests = normDeltaField(f.tests), artifact = normDeltaField(f.artifact);
    if (f.pr === undefined && head === '' && tests === '' && artifact === '') return null;
    core = { pr: f.pr ?? null, head: head === '' ? null : head, tests: tests === '' ? null : tests, artifact: artifact === '' ? null : artifact };
  } else return null;
  return JSON.stringify({ channel: f.channel, thread: f.thread, ...core });
}

/** Fixed-width digest of the delta material; carried on notices, ledger
 * rows and sender idempotency ids. */
export function boardNotifyDeltaDigest(material: string): string {
  return createHash('sha256').update(material).digest('hex').slice(0, 24);
}

function snapshotDeltaMaterial(item: BoardSnapshotItem): string | null {
  return boardNotifyDeltaMaterial({
    state: item.state, channel: item.channel, thread: item.channelRef,
    owner: item.owner, claimReceipt: item.claimReceipt,
    dependency: item.blocker?.dependency ?? null,
    pr: item.verified?.pr,
    head: item.verified?.head ?? null, tests: item.verified?.tests ?? null, artifact: item.verified?.artifact ?? null,
  });
}

function transitionDeltaMaterial(t: BoardTransition): string | null {
  return boardNotifyDeltaMaterial({
    state: t.to, channel: t.sourceChannel, thread: t.sourceThread,
    owner: t.evidence.owner ?? null, claimReceipt: t.evidence.claimReceipt ?? null,
    dependency: t.evidence.dependency ?? null, pr: t.evidence.pr,
    head: t.evidence.head ?? null, tests: t.evidence.tests ?? null, artifact: t.evidence.artifact ?? null,
  });
}

/** Compose the single-line thread message; the whole line is scrubbed so
 * a secret-looking substring in untrusted evidence can never ride out. */
export function boardNoticeText(state: BoardNotifyState, itemId: string, asOf: string, detail: string, source: string): string {
  return scrubSecrets(`${state} ${field(itemId, 80)} as of ${field(asOf, 40)} — ${detail} (source: ${field(source, 120)})`);
}

/** The bounded evidence a postable state cites: ASSIGNED names the owner
 * with its durable claim receipt labeled alongside, BLOCKED names the
 * dependency, and VERIFIED joins every supplied field with its label so
 * combined evidence stays parseable. A lone artifact already cites
 * itself, so it keeps the unlabeled single-field form. Every untrusted
 * value goes through `field`, keeping the line single and bounded. */
function detail(t: BoardTransition, state: BoardNotifyState): string | null {
  const e = t.evidence;
  if (state === 'ASSIGNED') {
    if (!e.owner || !e.claimReceipt) return null;
    return `${field(e.owner, 120)} (claim ${field(e.claimReceipt, 160)})`;
  }
  if (state === 'BLOCKED') return e.dependency ? field(e.dependency, 160) : null;
  const parts: string[] = [];
  if (e.pr !== undefined) parts.push(`PR #${e.pr}`);
  if (e.head) parts.push(`head ${field(e.head, 40)}`);
  if (e.tests) parts.push(`tests ${field(e.tests, 120)}`);
  if (e.artifact) parts.push(parts.length === 0 ? field(e.artifact, 160) : `artifact ${field(e.artifact, 160)}`);
  return parts.length === 0 ? null : parts.join(' ');
}

/** The evidence each postable state must cite; null means it may post. */
export function missingNoticeEvidence(t: BoardTransition, state: BoardNotifyState): string | null {
  const e = t.evidence;
  if (state === 'ASSIGNED') {
    if (!e.owner) return 'ASSIGNED dropped: no named owner';
    if (!e.claimReceipt) return 'ASSIGNED dropped: no durable claim receipt';
    return null;
  }
  if (state === 'BLOCKED') {
    return e.dependency ? null : 'BLOCKED dropped: no dependency named';
  }
  if (e.pr !== undefined || e.head || e.tests || e.artifact) return null;
  return 'VERIFIED dropped: no PR, head or test artifact';
}

/** Keep only the transitions worth posting: a postable to-state with its
 * required evidence that the sent ledger has not already recorded.
 * Every drop is logged with its reason; nothing is invented to fill one. */
export function planNotifications(
  transitions: readonly BoardTransition[],
  sentLedger: ReadonlySet<string>,
  log?: (line: string) => void,
): BoardNotifyPlan {
  const notices: BoardNotice[] = [];
  const dropped: BoardPlanDrop[] = [];
  const planned = new Set<string>();
  for (const t of transitions) {
    if (!(BOARD_NOTIFY_STATES as readonly string[]).includes(t.to)) continue;
    const state = t.to as BoardNotifyState;
    const missing = missingNoticeEvidence(t, state);
    if (missing !== null) {
      dropped.push({ itemId: t.itemId, state, reason: missing });
      try { log?.(`board-notify ${t.itemId}: ${missing}`); } catch { /* logging never breaks the plan */ }
      continue;
    }
    const material = transitionDeltaMaterial(t);
    if (material === null) continue; // unreachable: missingNoticeEvidence already proved the fields
    const delta = boardNotifyDeltaDigest(material);
    const deltaKey = boardNotifyLedgerKey(t.itemId, state, delta);
    const entryKey = boardNotifyLedgerKey(t.itemId, state);
    // A bare state key supplied by an older Set caller is legacy proof.
    // Mixed ledgers retain the legacy fence even after modern deliveries.
    const legacy = sentLedger.has(provenanceKey(t.itemId, state, 'legacy'))
      || (sentLedger.has(entryKey) && !sentLedger.has(provenanceKey(t.itemId, state, 'modern')));
    const entered = t.from !== t.to;
    if (sentLedger.has(deltaKey) || planned.has(deltaKey) || (entered && legacy)) {
      dropped.push({ itemId: t.itemId, state, reason: `${state} dropped: already notified` });
      continue;
    }
    planned.add(deltaKey);
    const text = detail(t, state);
    if (text === null) continue; // unreachable: missingNoticeEvidence already proved a detail
    notices.push({
      itemId: t.itemId, state, asOf: t.evidence.asOf, delta, detail: text,
      source: t.evidence.source,
      text: boardNoticeText(state, t.itemId, t.evidence.asOf, text, t.evidence.source),
      sourceChannel: t.sourceChannel, sourceThread: t.sourceThread,
    });
  }
  return { notices, dropped };
}

export interface BoardSendReceipt {
  /** 'sent' and 'duplicate' are durable receipts; anything else is not ledgered. */
  status: 'sent' | 'duplicate' | 'refused' | 'unavailable';
  reason?: string;
  /** Sender-side receipt label (e.g. `bus-reply:<id>`); never a secret. */
  receipt?: string;
}

export type BoardNotifySender = (notice: BoardNotice) => Promise<BoardSendReceipt> | BoardSendReceipt;
export type BoardNotifySenders = Readonly<Partial<Record<string, BoardNotifySender>>>;

export interface BoardSendResult {
  notice: BoardNotice;
  /** 'no-sender' when no sender is injected for the source channel. */
  status: 'sent' | 'duplicate' | 'refused' | 'unavailable' | 'no-sender';
  reason?: string;
}

export interface BoardNotifyLedgerRow {
  v: 1;
  at: string;
  itemId: string;
  state: BoardNotifyState;
  channel: string;
  thread: string | null;
  receipt: string | null;
  /** Delta digest of the delivered meaningful change; absent on rows
   * written before delta dedupe existed (legacy rows). */
  delta?: string;
}

const LEDGER_FILE = 'sent.jsonl';
const SNAPSHOT_FILE = 'snapshot.json';
const LEDGER_MAX_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const SNAPSHOT_MAX_ITEMS = 200;
const boundedString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** `~/.ashlr-runs/work-board-notify` — alongside the other durable fleet state. */
export function boardNotifyDir(runsDir?: string): string {
  const base = runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  return join(base, 'work-board-notify');
}

export function boardNotifyLedgerPath(stateDir: string): string {
  return join(stateDir, LEDGER_FILE);
}

export function boardNotifySnapshotPath(stateDir: string): string {
  return join(stateDir, SNAPSHOT_FILE);
}

/** Public state keys and exact delta keys, plus internal provenance markers.
 * State-only legacy rows fence reentry; modern rows fence only their exact
 * delta. Mixed history retains the legacy fence. Same-state changes can
 * still send because the snapshot proves a change since the last pass.
 * Unreadable or truncated ledgers fail closed; a missing ledger is empty. */
export function readBoardNotifySent(ledgerPath: string): Set<string> | null {
  const read = readPrivateFileCapped(ledgerPath, LEDGER_MAX_BYTES);
  if (read === null) return new Set();
  if (read.truncated) return null;
  const sent = new Set<string>();
  for (const line of read.text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { v?: unknown; itemId?: unknown; state?: unknown; delta?: unknown };
      if (row.v === 1 && boundedString(row.itemId, 128)
        && (BOARD_NOTIFY_STATES as readonly string[]).includes(String(row.state))) {
        const itemId = row.itemId, state = String(row.state);
        sent.add(boardNotifyLedgerKey(itemId, state));
        if (boundedString(row.delta, 64) && row.delta.length > 0) {
          sent.add(boardNotifyLedgerKey(itemId, state, row.delta));
          sent.add(provenanceKey(itemId, state, 'modern'));
        } else {
          sent.add(provenanceKey(itemId, state, 'legacy'));
        }
      }
    } catch { /* skip a torn line */ }
  }
  return sent;
}

/** Append one sent row; creates the private state dir on first use. */
export function appendBoardNotifyLedger(ledgerPath: string, row: BoardNotifyLedgerRow): void {
  ensurePrivateDirectory(dirname(ledgerPath));
  appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(ledgerPath, 0o600);
}

function validSnapshotItem(v: unknown): v is BoardSnapshotItem {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const item = v as Record<string, unknown>;
  const states: readonly string[] = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'];
  const nullableString = (x: unknown, max: number) => x === null || boundedString(x, max);
  const optString = (x: unknown, max: number) => x === undefined || boundedString(x, max);
  const record = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object' && !Array.isArray(x);
  const blockerField = item.blocker, verifiedField = item.verified;
  const blocker = blockerField === null || (record(blockerField)
    && optString(blockerField.dependency, 256) && optString(blockerField.source, 512) && optString(blockerField.at, 64));
  const verified = verifiedField === null || (record(verifiedField)
    && (verifiedField.pr === undefined || (typeof verifiedField.pr === 'number' && Number.isSafeInteger(verifiedField.pr)))
    && ['head', 'tests', 'artifact', 'source', 'at'].every(key => optString(verifiedField[key], 512)));
  return boundedString(item.id, 128) && states.includes(String(item.state))
    && boundedString(item.asOf, 64) && boundedString(item.source, 512)
    && nullableString(item.owner, 256) && nullableString(item.claimReceipt, 512)
    && boundedString(item.channel, 64) && nullableString(item.channelRef, 1024)
    && blocker && verified;
}

/** The previous pass's board; null when absent or unreadable — the caller
 * baselines instead of replaying a corrupt past. */
export function readBoardNotifySnapshot(stateDir: string): BoardSnapshotItem[] | null {
  if (!isAbsolute(stateDir)) return null;
  const read = readPrivateFileCapped(boardNotifySnapshotPath(stateDir), SNAPSHOT_MAX_BYTES);
  if (read === null || read.truncated) return null;
  try {
    const parsed = JSON.parse(read.text) as { v?: unknown; items?: unknown };
    if (parsed.v !== 1 || !Array.isArray(parsed.items) || parsed.items.length > SNAPSHOT_MAX_ITEMS
      || !parsed.items.every(validSnapshotItem)) return null;
    return parsed.items;
  } catch { return null; }
}

/** Persist this pass's board for the next diff; never throws. */
export function writeBoardNotifySnapshot(stateDir: string, items: readonly BoardSnapshotItem[]): void {
  try {
    ensurePrivateDirectory(stateDir);
    writePrivateFileAtomic(boardNotifySnapshotPath(stateDir),
      JSON.stringify({ v: 1, at: new Date().toISOString(), items }));
  } catch { /* a lost snapshot only replays; the ledger still fences sends */ }
}

/** What the next pass diffs against: delivered items advance; items whose
 * planned notice could not be sent keep their previous row (or stay
 * absent when new), so the transition re-fires and the send retries.
 * `preserveUnseen` marks `next` as a bounded projection of the board
 * (listWorkBoard `truncated`): absence from the page is not proof an
 * item vanished, so prior rows for unseen ids are carried forward
 * unchanged — pending baselines survive bounded reads and a later full
 * page still diffs against the real prior state. Carried rows are kept
 * within SNAPSHOT_MAX_ITEMS so the file stays readable; overflow drops
 * the tail, degrading only those items to first-appearance diffs. */
export function snapshotAfterSend(
  prev: readonly BoardSnapshotItem[],
  next: readonly BoardSnapshotItem[],
  pendingItemIds: ReadonlySet<string>,
  opts?: { preserveUnseen?: boolean },
): BoardSnapshotItem[] {
  const before = new Map(prev.map(item => [item.id, item]));
  const seen = new Set(next.map(item => item.id));
  const kept: BoardSnapshotItem[] = [];
  for (const item of next) {
    if (!pendingItemIds.has(item.id)) { kept.push(item); continue; }
    const prior = before.get(item.id);
    if (prior) kept.push(prior);
  }
  if (opts?.preserveUnseen === true) {
    for (const item of prev) {
      if (kept.length >= SNAPSHOT_MAX_ITEMS) break;
      if (!seen.has(item.id)) kept.push(item);
    }
  }
  return kept;
}

/** Send each planned notice in the thread it came from: the sender is
 * chosen by the item's source channel, never another channel. A row is
 * appended to the ledger only after a 'sent' or 'duplicate' receipt, so
 * a failed send retries next pass and a delivered one never repeats.
 * 'sent'/'duplicate' is returned to the caller only when the sender
 * supplied a nonblank receipt AND the durable ledger append succeeded:
 * with no ledger sink, a blank receipt or a throwing append the result
 * is 'unavailable' with a bounded reason, so the caller keeps the item
 * pending and the deterministic sender id makes the retry once-only. */
export async function sendNotifications(
  notices: readonly BoardNotice[],
  opts: {
    senders: BoardNotifySenders;
    ledgerPath?: string;
    appendLedger?: (row: BoardNotifyLedgerRow) => void;
    now?: () => number;
    log?: (line: string) => void;
  },
): Promise<BoardSendResult[]> {
  const results: BoardSendResult[] = [];
  const append = opts.appendLedger
    ?? (opts.ledgerPath ? (row: BoardNotifyLedgerRow) => appendBoardNotifyLedger(opts.ledgerPath!, row) : undefined);
  for (const notice of notices) {
    const sender = opts.senders[notice.sourceChannel];
    if (!sender) {
      results.push({ notice, status: 'no-sender', reason: `no sender for channel ${notice.sourceChannel}` });
      continue;
    }
    if (!append) {
      results.push({ notice, status: 'unavailable', reason: 'no-ledger-sink' });
      continue;
    }
    let receipt: BoardSendReceipt;
    try { receipt = await sender(notice); }
    catch { receipt = { status: 'unavailable', reason: 'sender threw' }; }
    if (receipt.status !== 'sent' && receipt.status !== 'duplicate') {
      results.push({ notice, status: receipt.status, ...(receipt.reason ? { reason: receipt.reason } : {}) });
      continue;
    }
    const senderReceipt = typeof receipt.receipt === 'string' ? receipt.receipt.trim().slice(0, 512) : '';
    if (senderReceipt === '') {
      results.push({ notice, status: 'unavailable', reason: 'missing-sender-receipt' });
      continue;
    }
    try {
      append({
        v: 1, at: new Date((opts.now ?? Date.now)()).toISOString(),
        itemId: notice.itemId, state: notice.state,
        channel: notice.sourceChannel, thread: notice.sourceThread,
        receipt: senderReceipt, delta: notice.delta,
      });
    } catch {
      try { opts.log?.(`board-notify ${notice.itemId}: ledger append failed`); } catch { /* keep going */ }
      results.push({ notice, status: 'unavailable', reason: 'ledger-append-failed' });
      continue;
    }
    results.push({ notice, status: receipt.status });
  }
  return results;
}
