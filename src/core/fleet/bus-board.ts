/**
 * bus-board.ts: the shared task board (docs/BUS-THREADS.md): durable local
 * threads and tasks whose claims are real fleet queue claims (SharedStore).
 *
 * Cooperative, private filesystem coordination only. Peer labels are routing
 * labels, not authenticated identities; task claims coordinate work but grant
 * no execution authority (merge, push or spend stay behind their own gates).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { ashlrHome } from '../cloud/store.js';
import { loadConfigReadOnlyStrict } from '../config.js';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubSecrets } from '../util/scrub.js';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { SharedStore, type QueueClaimRef } from './shared-store.js';
import {
  busBoardDeliveryText, busBoardHop, createBusBoardDelivery, presentBusBoardText,
  type BusBoardDelivery, type BusBoardHop,
} from './bus-delivery.js';
import { validateBusEnvelope } from './bus-envelope.js';
import { appendBusHop } from './bus-hoplog.js';
import { emit } from './event-bus.js';
import { clearBoardLease, upsertBoardLease } from '../agents/claim-store.js';

interface BoardThread { id: string; title: string; members: string[] }
interface BoardTask { id: string; threadId: string; itemId: string; title: string; claim?: QueueClaimRef }
interface BoardReceipt { deliveryId: string; recipient: string; receivedAt: string }
interface BoardState { schemaVersion: 1; threads: BoardThread[]; tasks: BoardTask[]; deliveries: BusBoardDelivery[]; receipts?: BoardReceipt[] }

/** Public task projection: the capability token and owner key never leave the store. */
export interface BusTaskView {
  id: string;
  threadId: string;
  itemId: string;
  content: { trust: 'untrusted'; text: string };
  owner: { peerId: string; epoch: number; leaseUntil: number } | null;
}

export interface BusThreadView {
  id: string;
  members: string[];
  content: { trust: 'untrusted'; text: string };
}

/**
 * Observed hold state of a board task's fleet item at digest read time.
 * 'open' means the queue shows no live claim — a claim attempt still passes
 * through `claimTask`'s own fences (worked cooldown, executing-phase
 * ambiguity). 'ambiguous' means an expired claim record the claim path
 * never auto-reclaims. 'unknown' means the queue could not be read.
 */
export type BusBoardTaskHold = 'open' | 'held' | 'ambiguous' | 'unknown';

/** One board task in a pending digest: routing metadata plus observed hold state. */
export interface BusBoardPendingTask {
  id: string;
  threadId: string;
  itemId: string;
  content: { trust: 'untrusted'; text: string };
  /** Board state still records a claim ref; it may be live, expired, or superseded. */
  claimed: boolean;
  hold: BusBoardTaskHold;
  /** Live queue holder when `hold` is 'held': peer label and lease expiry only, never capability material. */
  owner: { peerId: string; leaseUntil: number } | null;
}

/** A joined thread's pending rollup inside a digest. */
export interface BusBoardPendingThread extends BusThreadView {
  pendingDeliveries: number;
  tasks: Record<BusBoardTaskHold, number>;
}

/** Everything pending for one peer across every joined thread, in one read. */
export interface BusBoardPending {
  peer: string;
  /** 'unreadable' means the shared queue could not be inspected; every task `hold` is then 'unknown', never 'open'. */
  claims: 'readable' | 'unreadable';
  threads: BusBoardPendingThread[];
  deliveries: { matched: number; items: BusBoardDelivery[]; truncated: boolean };
  tasks: { matched: number; items: BusBoardPendingTask[]; truncated: boolean };
}

/**
 * The multi-peer pending digest: `pending`'s sections under the union of a
 * label set, for callers that hold several routing labels for one agent.
 * Unlike `pending`, item `content.text` is the stored untrusted text — a
 * delivery's canonical envelope JSON, a task's or thread's title — rather
 * than the re-wrapped display frame, so structured consumers can read the
 * body; the `trust:'untrusted'` marker and authority rules are unchanged.
 */
export interface BusBoardPendingPeers {
  /** Queried labels the board knows — each is a member of at least one thread, sorted. */
  peers: string[];
  /** 'unreadable' means the shared queue could not be inspected; every task `hold` is then 'unknown', never 'open'. */
  claims: 'readable' | 'unreadable';
  threads: BusBoardPendingThread[];
  deliveries: { matched: number; items: BusBoardDelivery[]; truncated: boolean };
  tasks: { matched: number; items: BusBoardPendingTask[]; truncated: boolean };
}

/** The stored-content digest `pending` and `pendingFor` share; `pending` re-wraps every `content.text` for display. */
interface BusBoardDigest {
  claims: 'readable' | 'unreadable';
  /** Every member label across the joined threads before any item filter — the board-membership fact `peers` reports inside the digest's thread scope, never narrowed by the `contains` text filter. */
  members: string[];
  threads: BusBoardPendingThread[];
  deliveries: { matched: number; items: BusBoardDelivery[]; truncated: boolean };
  tasks: { matched: number; items: BusBoardPendingTask[]; truncated: boolean };
}

/** Where the board state file and its fleet queue live for one fleet root. */
export type BusBoardStoragePaths =
  | { status: 'ok'; boardRoot: string; queueRoot: string }
  | { status: 'invalid' };

/**
 * The one board path derivation `phm bus board`, `agents bus work mine` and
 * `agents bus status` share: `<dirname(fleetRoot)>/bus` for state and
 * `<fleetRoot>/bus-queue` for the fleet queue — `<ashlrHome>/bus` and
 * `<ashlrHome>/fleet/bus-queue` on the default root — unless
 * `fleet.sharedQueue` runs in attested filesystem mode, where the configured
 * path is the queue and `<path>/bus` the board. A filesystem-mode config
 * without `trustedCoherentStorage: true` and an absolute path is 'invalid',
 * never guessed; callers report their own unavailable state.
 */
export function busBoardStoragePaths(fleetRoot: string, cfg: AshlrConfig): BusBoardStoragePaths {
  const shared = cfg.fleet?.sharedQueue;
  if (shared?.mode === 'filesystem') {
    if (shared.trustedCoherentStorage !== true || typeof shared.path !== 'string' || !isAbsolute(shared.path)) {
      return { status: 'invalid' };
    }
    return { status: 'ok', queueRoot: shared.path, boardRoot: join(shared.path, 'bus') };
  }
  return { status: 'ok', boardRoot: join(dirname(fleetRoot), 'bus'), queueRoot: join(fleetRoot, 'bus-queue') };
}

/** Stored board row counts from a lock-free state read. */
export interface BusBoardStateSummary {
  threads: number;
  tasks: number;
  deliveries: number;
  receipts: number;
  /** Deliveries no receipt row acknowledges — board mail still awaiting receipt. */
  pendingDeliveries: number;
}

export interface BusBoardOptions {
  root: string;
  fleet: SharedStore;
  cfg: AshlrConfig;
  /**
   * Optional peer allowlist. Undefined or null accepts every syntactically
   * valid cooperative label; an array admits only listed peer ids.
   */
  peers?: readonly { id: string }[] | null;
}

/**
 * Optional read slice for the thread delivery reads (`readThread`, `hops`):
 * `sinceMs`/`beforeMs` are the same `[since, before)` window on each
 * delivery's `createdAt` every bus read's `--since`/`--before` applies,
 * `contains` the same normalized `--contains` needle over the post text
 * `busBoardDeliveryText` extracts, and `from`/`excludeFrom` the same
 * `--from`/`--exclude-from` sender rule. Peer labels compare exactly: a label no board peer carries
 * simply matches nothing under `from` and excludes nothing under
 * `excludeFrom`.
 */
export interface BusBoardDeliveryFilter {
  sinceMs?: number;
  beforeMs?: number;
  contains?: string;
  from?: string;
  excludeFrom?: string;
}

/** Optional read slice for `receipts`: the same `[since, before)` window on each receipt's `receivedAt`. */
export interface BusBoardReceiptFilter {
  sinceMs?: number;
  beforeMs?: number;
}

/**
 * Optional sender slice for the pending digests: `from` keeps only
 * deliveries whose `sender` peer label the predicate accepts, `excludeFrom`
 * drops deliveries whose `sender` the predicate accepts for the excluded
 * ref — the same include-then-exclude order every bus `--from`/
 * `--exclude-from` read applies. The predicates are the caller-resolved
 * `agentRefAddressMatcher` rules (the board keeps no identity registry of
 * its own), so an unresolvable ref already degraded to exact-label
 * matching before it reaches here. Deliveries are the only pending rows
 * carrying a sender: tasks record no author, so they never match under
 * `from` and stay listed under `excludeFrom` — nothing proves a task came
 * from the excluded sender — and a thread rollup keeps only while a
 * surviving delivery or task remains.
 */
export interface BusBoardSenderFilter {
  from?: (sender: string) => boolean;
  excludeFrom?: (sender: string) => boolean;
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 10_000;
/** Item rows one pending digest section shows; `matched` keeps the true totals. */
const BUS_BOARD_PENDING_MAX = 50;
const WRITE_RESERVE_BYTES = 4_096;
const LOCK_WAIT_MS = 2_000;

const emptyState = (): BoardState => ({ schemaVersion: 1, threads: [], tasks: [], deliveries: [] });

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
function boardId(value: unknown): string {
  if (typeof value !== 'string' || ID_RE.exec(value)?.[0] !== value) throw new Error('Invalid bus identifier');
  return value;
}
function boardBody(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16_384) {
    throw new Error('Bus content must be 1..16384 bytes');
  }
  return value;
}

/**
 * The normalized `--contains` needle every board read shares — lowercase,
 * whitespace collapsed, trimmed — matched over scrubbed display text so a
 * secret-shaped value stays unfindable; a blank needle is the empty
 * substring and narrows nothing. Undefined means no filter was given.
 */
function boardContainsMatcher(contains: string | undefined): ((value: string) => boolean) | undefined {
  if (contains === undefined) return undefined;
  const needle = contains.toLowerCase().replace(/\s+/g, ' ').trim();
  return (value: string) => scrubSecrets(value).toLowerCase().replace(/\s+/g, ' ').includes(needle);
}

/**
 * The shared `[since, before)` recorded-time window on one stored ISO
 * timestamp — `sinceMs` inclusive, `beforeMs` exclusive, an unparseable
 * timestamp satisfying neither bound; the same rule `pendingDigest`
 * applies to delivery `createdAt` and `receipts` to `receivedAt`.
 */
function boardTimeWindowHit(at: string, sinceMs?: number, beforeMs?: number): boolean {
  if (sinceMs === undefined && beforeMs === undefined) return true;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) &&
    (sinceMs === undefined || parsed >= sinceMs) &&
    (beforeMs === undefined || parsed < beforeMs);
}

/**
 * The shared `--from`/`--exclude-from` sender rule on one stored peer
 * label: `from` keeps only deliveries the named peer sent, `excludeFrom`
 * drops them, and the two compose so a sender both included and excluded
 * matches nothing. Board peer labels are cooperative routing labels compared
 * exactly, never resolved through an identity registry; a well-formed
 * label no stored sender carries is simply an empty `from` match or an
 * `excludeFrom` that excludes nothing.
 */
function boardSenderHit(sender: string, from?: string, excludeFrom?: string): boolean {
  return (from === undefined || sender === from) &&
    (excludeFrom === undefined || sender !== excludeFrom);
}

/**
 * Peer identity is a routing label, never a fleet execution capability. With an
 * allowlist configured the label must appear; without one every well-formed
 * label is a cooperative peer on this private store.
 */
export function resolveBusBoardPeer(id: string, peers?: readonly { id: string }[] | null): { id: string; source: 'local' | 'registry' } {
  if (typeof id !== 'string' || ID_RE.exec(id)?.[0] !== id) throw new Error('Invalid bus peer identifier');
  if (peers === undefined || peers === null) return { id, source: 'local' };
  if (!peers.some((peer) => peer && typeof peer.id === 'string' && peer.id === id)) {
    throw new Error('Bus peer is absent from the peer registry');
  }
  return { id, source: 'registry' };
}

export class BusBoard {
  private readonly root: string;

  constructor(private readonly options: BusBoardOptions) {
    this.root = resolve(options.root);
  }

  private peer(value: string): string {
    return resolveBusBoardPeer(value, this.options.peers).id;
  }

  private enabled(): void {
    const foundry = this.options.cfg.foundry as Record<string, unknown> | undefined;
    if (foundry?.['eventBus'] === false) throw new Error('Fleet event bus is disabled');
  }

  private privatePath(path: string, kind: 'file' | 'directory'): void {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== (kind === 'file' ? 0o600 : 0o700)) ||
      !assurePrivateStoragePath(path, kind, 'inspect-existing', { anchorPath: this.root }).ok
    ) throw new Error('Bus storage must be private, owned, and not linked');
  }

  private read(): BoardState {
    const file = join(this.root, 'state.json');
    if (!existsSync(file)) return emptyState();
    this.privatePath(file, 'file');
    const stored = readStableRegularFile(file, { anchorPath: this.root, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
    if (!stored.ok) throw new Error('Bus storage is busy or unavailable');
    const state = JSON.parse(stored.text) as BoardState;
    if (
      state === null || typeof state !== 'object' || state.schemaVersion !== 1 ||
      !Array.isArray(state.threads) || !Array.isArray(state.tasks) || !Array.isArray(state.deliveries) ||
      [state.threads, state.tasks, state.deliveries].some((rows) => rows.length > MAX_RECORDS)
    ) throw new Error('Invalid bus state');
    // Validate before use: corrupt private state is never silently replaced by an empty board.
    const threads = new Map<string, BoardThread>();
    for (const thread of state.threads) {
      boardId(thread.id); boardBody(thread.title);
      if (
        threads.has(thread.id) || !Array.isArray(thread.members) || thread.members.length === 0 ||
        new Set(thread.members).size !== thread.members.length
      ) throw new Error('Invalid bus members');
      thread.members.forEach(boardId);
      threads.set(thread.id, thread);
    }
    const tasks = new Set<string>(), items = new Set<string>();
    for (const task of state.tasks) {
      boardId(task.id); boardId(task.threadId); boardBody(task.title); boardId(task.itemId);
      const thread = threads.get(task.threadId);
      if (!thread || tasks.has(task.id) || items.has(task.itemId)) throw new Error('Invalid bus task reference');
      tasks.add(task.id); items.add(task.itemId);
      if (task.claim !== undefined) {
        const claim = task.claim;
        if (
          !claim || claim.itemId !== task.itemId || !thread.members.includes(claim.machineId) ||
          claim.phase !== 'claimed' ||
          !Number.isSafeInteger(claim.epoch) || claim.epoch < 1 ||
          !Number.isSafeInteger(claim.leaseUntil) || claim.leaseUntil < 1 ||
          typeof claim.ownerKey !== 'string' || claim.ownerKey.length > 2_048 ||
          typeof claim.ownerToken !== 'string' || !/^[0-9a-f-]{36}$/.test(claim.ownerToken) ||
          typeof claim.queueId !== 'string' || !/^[0-9a-f-]{36}$/.test(claim.queueId)
        ) throw new Error('Invalid bus task claim');
      }
    }
    const envelopes = new Set<string>();
    for (const delivery of state.deliveries) {
      boardId(delivery.id); boardId(delivery.threadId); boardId(delivery.sender); boardId(delivery.recipient);
      const thread = threads.get(delivery.threadId);
      const wire = validateBusEnvelope({ ...delivery.message, body: null });
      if (
        !wire.ok || delivery.message.id !== delivery.id || delivery.message.from !== delivery.sender ||
        delivery.message.to !== delivery.recipient ||
        !thread || !thread.members.includes(delivery.sender) || !thread.members.includes(delivery.recipient) ||
        envelopes.has(delivery.id) || delivery.schemaVersion !== 1 ||
        delivery.content?.trust !== 'untrusted' || typeof delivery.content.text !== 'string' ||
        typeof delivery.createdAt !== 'string' || !Number.isFinite(Date.parse(delivery.createdAt)) ||
        new Date(delivery.createdAt).toISOString() !== delivery.createdAt
      ) throw new Error('Invalid bus delivery');
      envelopes.add(delivery.id);
    }
    if (state.receipts !== undefined) {
      if (!Array.isArray(state.receipts) || state.receipts.length > MAX_RECORDS) throw new Error('Invalid bus receipt');
      const acknowledged = new Set<string>();
      const deliveries = new Map(state.deliveries.map((row) => [row.id, row]));
      for (const receipt of state.receipts) {
        const delivery = deliveries.get(receipt?.deliveryId);
        if (!delivery || delivery.recipient !== receipt.recipient || acknowledged.has(receipt.deliveryId) ||
          typeof receipt.receivedAt !== 'string' || !Number.isFinite(Date.parse(receipt.receivedAt)) ||
          new Date(receipt.receivedAt).toISOString() !== receipt.receivedAt) throw new Error('Invalid bus receipt');
        acknowledged.add(receipt.deliveryId);
      }
    }
    return state;
  }

  private transaction<T>(write: boolean, fn: (state: BoardState) => T): T {
    this.enabled();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.privatePath(this.root, 'directory');
    const lock = acquireLocalStoreLock(join(this.root, 'state.lock'), LOCK_WAIT_MS, { anchorPath: this.root, exactPrivateStorage: true });
    if (!lock) throw new Error('Bus storage is busy or unavailable');
    try {
      const state = this.read();
      const result = fn(state);
      if (write) {
        const json = JSON.stringify(state);
        if (
          Buffer.byteLength(json) > MAX_BYTES ||
          [state.threads, state.tasks, state.deliveries, state.receipts ?? []].some((rows) => rows.length > MAX_RECORDS)
        ) throw new Error('Bus storage is full');
        const file = join(this.root, 'state.json');
        const pending = join(this.root, '.pending-state');
        // With the writer lock held, a leftover stage belongs to a vanished
        // writer; it is removed, never promoted.
        try {
          this.privatePath(pending, 'file');
          unlinkSync(pending);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (!ownsLocalStoreLock(lock)) throw new Error('Bus storage lock lost');
        writePrivateFileAtomically(pending, file, json, { anchorPath: this.root, label: 'Bus board' });
        fsyncDirectory(this.root);
      }
      return result;
    } finally {
      releaseLocalStoreLock(lock);
    }
  }

  private member(state: BoardState, threadId: string, actor: string): BoardThread {
    const thread = state.threads.find((t) => t.id === boardId(threadId));
    if (!thread || !thread.members.includes(actor)) throw new Error('Thread missing or peer has not joined');
    return thread;
  }

  private task(state: BoardState, taskId: string, actor: string): BoardTask {
    const task = state.tasks.find((t) => t.id === boardId(taskId));
    if (!task) throw new Error('Task not found');
    this.member(state, task.threadId, actor);
    return task;
  }

  private taskView(task: BoardTask): BusTaskView {
    const claim = task.claim && this.options.fleet.validateClaims([task.claim])[0];
    return {
      id: task.id, threadId: task.threadId, itemId: task.itemId,
      content: { trust: 'untrusted', text: presentBusBoardText(task.title) },
      owner: claim ? { peerId: claim.machineId, epoch: claim.epoch, leaseUntil: claim.leaseUntil } : null,
    };
  }

  private claimWriteCapacity(state: BoardState): void {
    // Reserve room for a new capability before mutating the separate fleet
    // queue. Disk errors still fail closed; an orphaned claimed lease expires.
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES - WRITE_RESERVE_BYTES) throw new Error('Bus storage is full');
  }

  createThread(actor: string, title: string): { id: string } {
    actor = this.peer(actor); boardBody(title);
    return this.transaction(true, (state) => {
      const thread = { id: randomUUID(), title, members: [actor] };
      state.threads.push(thread);
      return { id: thread.id };
    });
  }

  joinThread(actor: string, threadId: string): { id: string; members: string[] } {
    actor = this.peer(actor);
    return this.transaction(true, (state) => {
      const thread = state.threads.find((t) => t.id === boardId(threadId));
      if (!thread) throw new Error('Thread not found');
      if (!thread.members.includes(actor)) thread.members.push(actor);
      return { id: thread.id, members: [...thread.members] };
    });
  }

  /**
   * The threads `actor` joined. `contains`, when given, is the normalized
   * `--contains` needle `board pending` applies — a thread stays only when
   * its stored title carries it under the same scrubbed display-text rule;
   * threads record no timestamp, so no time bound applies here.
   */
  listThreads(actor: string, contains?: string): BusThreadView[] {
    actor = this.peer(actor);
    const textHit = boardContainsMatcher(contains);
    return this.transaction(false, (state) => state.threads
      .filter((thread) => thread.members.includes(actor) &&
        (textHit === undefined || textHit(thread.title)))
      .map((thread) => ({
        id: thread.id, members: [...thread.members],
        content: { trust: 'untrusted', text: presentBusBoardText(thread.title) },
      })));
  }

  async post(actor: string, threadId: string, text: string): Promise<{ delivered: number; envelopeIds: string[]; unlogged: number }> {
    actor = this.peer(actor); boardBody(text);
    const deliveries = this.transaction(true, (state) => {
      const thread = this.member(state, threadId, actor);
      // Snapshot membership once; later joins do not receive historical posts.
      const messages = thread.members.map((recipient) => {
        this.peer(recipient);
        return createBusBoardDelivery(thread.id, actor, recipient, text);
      });
      state.deliveries.push(...messages);
      return messages;
    });
    // The durable board is authoritative; lifecycle observers are best effort.
    let unlogged = 0;
    for (const delivery of deliveries) {
      const elapsed = Date.now() - Date.parse(delivery.createdAt);
      const ttl = delivery.message.ttl - Math.ceil(elapsed);
      // Observers receive only a remaining lifetime; a slow earlier observer
      // never resets a later one's budget.
      if (elapsed >= 0 && ttl > 0) {
        const frozen = Object.freeze({
          ...delivery,
          message: Object.freeze({ ...delivery.message, ttl }),
          content: Object.freeze({ ...delivery.content }),
        });
        await emit('bus:delivery', { delivery: frozen }, this.options.cfg);
      }
      if (!appendBusHop(delivery.message, join(this.root, 'hops.jsonl'))) unlogged++;
    }
    return { delivered: deliveries.length, envelopeIds: deliveries.map((d) => d.id), unlogged };
  }

  /**
   * The thread's stored deliveries addressed to `actor`; `pendingOnly`
   * narrows to rows no receipt acknowledges. `filter` takes the same
   * optional filters — `sinceMs`/`beforeMs` keep only
   * deliveries whose `createdAt` falls inside the `[since, before)` window,
   * `contains` keeps only posts whose `busBoardDeliveryText` carries the
   * normalized needle, and `from`/`excludeFrom` keep or drop deliveries by
   * the stored `sender` peer label — so a thread read narrows exactly the
   * way the digest does. `content.text` still returns the re-wrapped
   * untrusted display frame; filtering never acknowledges anything.
   */
  readThread(actor: string, threadId: string, pendingOnly = false, filter?: BusBoardDeliveryFilter): BusBoardDelivery[] {
    actor = this.peer(actor);
    const textHit = boardContainsMatcher(filter?.contains);
    return this.transaction(false, (state) => {
      this.member(state, threadId, actor);
      const acknowledged = new Set((state.receipts ?? []).map((receipt) => receipt.deliveryId));
      return state.deliveries
        .filter((delivery) => delivery.threadId === threadId && delivery.recipient === actor &&
          (!pendingOnly || !acknowledged.has(delivery.id)) &&
          boardTimeWindowHit(delivery.createdAt, filter?.sinceMs, filter?.beforeMs) &&
          boardSenderHit(delivery.sender, filter?.from, filter?.excludeFrom) &&
          (textHit === undefined || textHit(busBoardDeliveryText(delivery))))
        .map((delivery) => ({
          ...delivery,
          content: { trust: 'untrusted' as const, text: presentBusBoardText(delivery.content.text) },
        }));
    });
  }

  /** Record explicit receipt; reading a thread alone never acknowledges it. */
  acknowledge(actor: string, threadId: string, deliveryId: string): BoardReceipt {
    actor = this.peer(actor); boardId(deliveryId);
    return this.transaction(true, (state) => {
      this.member(state, threadId, actor);
      const delivery = state.deliveries.find((row) => row.id === deliveryId && row.threadId === threadId && row.recipient === actor);
      if (!delivery) throw new Error('Bus delivery not found');
      const receipts = state.receipts ??= [];
      const existing = receipts.find((row) => row.deliveryId === deliveryId);
      if (existing) return { ...existing };
      const receipt = { deliveryId, recipient: actor, receivedAt: new Date().toISOString() };
      receipts.push(receipt);
      return { ...receipt };
    });
  }

  /**
   * Only the sender sees receipt metadata for its own deliveries.
   * `filter.sinceMs`/`beforeMs` keep only receipts whose `receivedAt` falls
   * inside the same `[since, before)` window every bus read applies.
   */
  receipts(actor: string, threadId: string, filter?: BusBoardReceiptFilter): BoardReceipt[] {
    actor = this.peer(actor);
    return this.transaction(false, (state) => {
      this.member(state, threadId, actor);
      const sent = new Set(state.deliveries.filter((row) => row.threadId === threadId && row.sender === actor).map((row) => row.id));
      return (state.receipts ?? [])
        .filter((row) => sent.has(row.deliveryId) &&
          boardTimeWindowHit(row.receivedAt, filter?.sinceMs, filter?.beforeMs))
        .map((row) => ({ ...row }));
    });
  }

  /** The metadata-only hop projection of `readThread` under the same optional filters. */
  hops(actor: string, threadId: string, filter?: BusBoardDeliveryFilter): BusBoardHop[] {
    return this.readThread(actor, threadId, false, filter).map(busBoardHop);
  }

  /**
   * One locked board snapshot plus one queue read: every unacknowledged
   * delivery addressed to `actor` and every task on a joined thread, each
   * task annotated with the fleet queue's observed hold state. `open` means
   * the queue shows no live claim — a claim attempt still passes through
   * `claimTask`'s own fences. Deliveries and tasks cap their item lists;
   * `matched` keeps the true totals. Reading never acknowledges anything.
   * `jobId`, `contains`, `sinceMs` and `beforeMs` are the same optional
   * filters `pendingFor`/`pendingAll` take, applied by the shared
   * `pendingDigest` under identical rules, so `phm bus board pending`
   * narrows exactly the way `work mine`'s board section and
   * `fleet_bus_board` do; `now` is the epoch-ms instant task holds
   * evaluate against (default `Date.now()`).
   */
  pending(actor: string, now = Date.now(), jobId?: string, contains?: string, sinceMs?: number, beforeMs?: number): BusBoardPending {
    actor = this.peer(actor);
    return this.transaction(false, (state) => ({
      peer: actor,
      ...this.presentDigest(this.pendingDigest(state, new Set([actor]), now, jobId, contains, sinceMs, beforeMs)),
    }));
  }

  /**
   * The multi-peer form of `pending`: the same locked snapshot and queue
   * read covering every label in `peers` at once — a joined thread counts
   * once even when several labels are members, and each delivery still
   * lists under its single recipient. A label that is not a well-formed
   * board peer, or is absent from a configured allowlist, simply matches
   * nothing. `peers` reports the queried labels the board actually knows —
   * each appears as a member of at least one thread — so a caller can tell
   * "nothing pending" from "not a board peer". Item `content.text` stays
   * the stored untrusted text (a delivery's canonical envelope JSON, a
   * task's or thread's title) rather than `pending`'s re-wrapped display
   * frame, so structured consumers can read the body; every outbound read
   * still marks it `trust:'untrusted'` and it grants no authority.
   * `jobId`, when given, scopes the digest to the board work one fleet job
   * coordinates: a thread stays in scope only when it carries a task whose
   * `itemId` equals the job id — the fleet item and bus job share the id
   * namespace, so the task's `itemId` is the job citation — and that
   * thread's deliveries and rollup ride along because the thread is the
   * job's board coordination surface. Deliveries and thread rows carry no
   * per-item job field of their own, so thread membership is the finest
   * structured citation the board records; `matched`/`truncated` count the
   * filtered sets, never the unfiltered totals. `contains`, when given, is
   * the normalized `--contains` needle every bus read shares (lowercase,
   * whitespace collapsed, trimmed — re-normalized here so a raw value is
   * safe): deliveries keep only posts whose `busBoardDeliveryText` — the
   * same post text the pending views render — carries it, tasks and thread
   * rollups keep only titles that carry it or that still hold a matching
   * delivery or task, and `matched`/`truncated` count the filtered sets.
   * Matching runs over scrubbed display text, never the stored envelope
   * JSON or peer labels, so a secret-shaped value stays unfindable.
   * `sinceMs`, when given, is the epoch-ms cutoff every bus read's
   * `--since` shares: deliveries keep only posts whose `createdAt` reaches
   * it, and tasks — which the board records without any timestamp — never
   * match, the same "unknown stays out" rule the unified inbox applies; a
   * thread rollup then lists only while it still holds a surviving
   * delivery, since the rollup itself keeps no time of its own.
   * `beforeMs`, when given, is the exclusive upper bound every bus read's
   * `--before` shares on the same `createdAt` field: deliveries keep only
   * posts recorded strictly before it, composing with `sinceMs` into one
   * `[since, before)` window where a delivery stamped exactly at the upper
   * bound never matches; tasks stay unmatchable under any time bound and
   * thread rollups keep the same surviving-delivery rule.
   */
  pendingFor(peers: readonly string[], now?: number, jobId?: string, contains?: string, sinceMs?: number, beforeMs?: number,
    sender?: BusBoardSenderFilter): BusBoardPendingPeers {
    const labels = new Set<string>();
    for (const peer of peers) {
      try { labels.add(this.peer(peer)); } catch { /* not a board peer label; it can match nothing */ }
    }
    return this.transaction(false, (state) => {
      const digest = this.pendingDigest(state, labels, now ?? Date.now(), jobId, contains, sinceMs, beforeMs, sender);
      const known = new Set(digest.members);
      return {
        peers: [...labels].filter((label) => known.has(label)).sort(),
        claims: digest.claims,
        threads: digest.threads,
        deliveries: digest.deliveries,
        tasks: digest.tasks,
      };
    });
  }

  /**
   * The fleet-wide form of `pendingFor`: the same locked snapshot and queue
   * read with every thread member as the label set, so every unacknowledged
   * delivery (a delivery's recipient is always a joined member) and every
   * task on every thread lists — the pending board `phm comms inbox`
   * projects and `fleet_bus_board` serves, where `pendingFor` still
   * requires knowing peer labels ahead of time and `pending` only one.
   * `jobId`, `contains`, `sinceMs` and `beforeMs` are the same optional
   * filters `pendingFor` takes, applied by the shared `pendingDigest`
   * under identical rules: `jobId` narrows the digest to threads carrying
   * a task whose `itemId` cites it — and `peers` then reports only that
   * job's thread members — `contains` the normalized `--contains` needle
   * over the same scrubbed display text, `sinceMs` the epoch-ms cutoff
   * deliveries must reach while tasks never match, and `beforeMs` the
   * exclusive upper bound on the same `createdAt` field composing with
   * `sinceMs` into one `[since, before)` window. `peers` reports every
   * member label the board knows under the applied scope, sorted. Item
   * `content.text` stays the stored untrusted text, exactly like
   * `pendingFor`; reading never acknowledges anything and grants no
   * authority.
   */
  pendingAll(now?: number, jobId?: string, contains?: string, sinceMs?: number, beforeMs?: number,
    sender?: BusBoardSenderFilter): BusBoardPendingPeers {
    return this.transaction(false, (state) => {
      const labels = new Set(state.threads.flatMap((thread) => thread.members));
      const digest = this.pendingDigest(state, labels, now ?? Date.now(), jobId, contains, sinceMs, beforeMs, sender);
      return {
        peers: digest.members,
        claims: digest.claims,
        threads: digest.threads,
        deliveries: digest.deliveries,
        tasks: digest.tasks,
      };
    });
  }

  /**
   * The shared snapshot math behind `pending`/`pendingFor`/`pendingAll`: `labels` is the
   * peer set a thread joins or a delivery addresses. Task `hold` reads the
   * one queue claim index; an unreadable queue leaves every hold `unknown`.
   * `jobId` narrows the digest to threads carrying a task for that fleet
   * item: deliveries on those threads and the threads' own rollups list
   * under the job filter, while tasks list only when their `itemId` cites
   * the job — the per-item citation — so a job-scoped read never mixes in
   * a sibling item's tasks. `contains` narrows each pending collection by
   * its displayed text — a delivery's post body, a task's or thread's
   * title — scrubbed and normalized like every other bus read's
   * `--contains`; thread rollups keep a thread whose title matches or
   * that still holds a matching delivery or task, and the per-thread
   * pending counts then measure the matching items only. `sinceMs` is the
   * epoch-ms `--since` cutoff: deliveries keep only posts whose `createdAt`
   * reaches it and tasks never match — the board records no task
   * timestamp, so under a time filter the task list is provably empty
   * rather than padded with undated rows; a thread rollup keeps only while
   * a surviving delivery remains, the rollup itself carrying no time.
   * `beforeMs` is the exclusive `--before` upper bound on the same
   * `createdAt` field: a delivery matches only when its parsed time is
   * strictly below the cutoff, so `sinceMs`/`beforeMs` read one
   * `[since, before)` window — the lower bound stays inclusive, the upper
   * exclusive, and an unparseable `createdAt` never satisfies either bound.
   * Tasks stay unmatchable under either bound and the thread rollup rule is
   * unchanged.
   */
  private pendingDigest(state: BoardState, labels: ReadonlySet<string>, now: number,
    jobId?: string, contains?: string, sinceMs?: number, beforeMs?: number,
    sender?: BusBoardSenderFilter): BusBoardDigest {
    const index = this.options.fleet.readClaimIndex();
    const acknowledged = new Set((state.receipts ?? []).map((receipt) => receipt.deliveryId));
    const jobThreads = jobId === undefined ? undefined : new Set(
      state.tasks.filter(task => task.itemId === jobId).map(task => task.threadId));
    const joined = state.threads.filter((thread) =>
      thread.members.some((member) => labels.has(member)) &&
      (jobThreads === undefined || jobThreads.has(thread.id)));
    const joinedIds = new Set(joined.map((thread) => thread.id));

    // The shared helpers carry the one --contains/--since/--before rule
    // every board read applies: scrubbed normalized display text for the
    // needle, the [since, before) window on createdAt for the bounds. The
    // sender slice applies only to deliveries — the one pending row
    // carrying a `sender` label: `from` keeps posts the predicate accepts,
    // `excludeFrom` drops posts the predicate accepts for the excluded
    // ref. Tasks record no author, so under `from` they never match —
    // unknown stays out — while under `excludeFrom` they stay listed:
    // nothing proves a task came from the excluded sender.
    const textHit = boardContainsMatcher(contains) ?? (() => true);
    const senderHit = (value: string): boolean =>
      (sender?.from === undefined || sender.from(value)) &&
      (sender?.excludeFrom === undefined || !sender.excludeFrom(value));

    const deliveries = state.deliveries.filter((delivery) =>
      labels.has(delivery.recipient) && joinedIds.has(delivery.threadId) &&
      !acknowledged.has(delivery.id) &&
      textHit(busBoardDeliveryText(delivery)) &&
      boardTimeWindowHit(delivery.createdAt, sinceMs, beforeMs) &&
      senderHit(delivery.sender));

    const tasks = state.tasks.filter((task) => sinceMs === undefined && beforeMs === undefined &&
      sender?.from === undefined && joinedIds.has(task.threadId) &&
      (jobId === undefined || task.itemId === jobId) && textHit(task.title)).map((task): BusBoardPendingTask => {
      const entry = index.claims[task.itemId];
      let hold: BusBoardTaskHold = 'unknown';
      let owner: BusBoardPendingTask['owner'] = null;
      if (index.readable) {
        if (!entry) hold = 'open';
        else if (entry.leaseUntil > now) {
          hold = 'held';
          owner = { peerId: entry.machineId, leaseUntil: entry.leaseUntil };
        } else hold = entry.phase === 'claimed' ? 'open' : 'ambiguous';
      }
      return {
        id: task.id, threadId: task.threadId, itemId: task.itemId,
        content: { trust: 'untrusted', text: task.title },
        claimed: task.claim !== undefined, hold, owner,
      };
    });

    const deliveryCounts = new Map<string, number>();
    for (const delivery of deliveries) {
      deliveryCounts.set(delivery.threadId, (deliveryCounts.get(delivery.threadId) ?? 0) + 1);
    }
    const holdCounts = new Map<string, Record<BusBoardTaskHold, number>>();
    for (const task of tasks) {
      const counts = holdCounts.get(task.threadId) ?? { open: 0, held: 0, ambiguous: 0, unknown: 0 };
      counts[task.hold]++;
      holdCounts.set(task.threadId, counts);
    }
    const threads: BusBoardPendingThread[] = joined
      .filter((thread) => sinceMs !== undefined || beforeMs !== undefined || sender !== undefined
        ? deliveryCounts.has(thread.id) || holdCounts.has(thread.id)
        : textHit(thread.title) || deliveryCounts.has(thread.id) || holdCounts.has(thread.id))
      .map((thread) => ({
        id: thread.id, members: [...thread.members],
        content: { trust: 'untrusted' as const, text: thread.title },
        pendingDeliveries: deliveryCounts.get(thread.id) ?? 0,
        tasks: holdCounts.get(thread.id) ?? { open: 0, held: 0, ambiguous: 0, unknown: 0 },
      }));

    return {
      claims: index.readable ? 'readable' : 'unreadable',
      members: [...new Set(joined.flatMap((thread) => thread.members))].sort(),
      threads,
      deliveries: {
        matched: deliveries.length,
        items: deliveries.slice(0, BUS_BOARD_PENDING_MAX).map((delivery) => ({
          ...delivery,
          content: { trust: 'untrusted' as const, text: delivery.content.text },
        })),
        truncated: deliveries.length > BUS_BOARD_PENDING_MAX,
      },
      tasks: {
        matched: tasks.length,
        items: tasks.slice(0, BUS_BOARD_PENDING_MAX),
        truncated: tasks.length > BUS_BOARD_PENDING_MAX,
      },
    };
  }

  /** Re-wrap every stored `content.text` in the untrusted display frame `pending` has always returned. */
  private presentDigest(digest: BusBoardDigest): Omit<BusBoardPending, 'peer'> {
    return {
      claims: digest.claims,
      threads: digest.threads.map((thread) => ({
        ...thread, content: { trust: 'untrusted' as const, text: presentBusBoardText(thread.content.text) },
      })),
      deliveries: {
        ...digest.deliveries,
        items: digest.deliveries.items.map((delivery) => ({
          ...delivery, content: { trust: 'untrusted' as const, text: presentBusBoardText(delivery.content.text) },
        })),
      },
      tasks: {
        ...digest.tasks,
        items: digest.tasks.items.map((task) => ({
          ...task, content: { trust: 'untrusted' as const, text: presentBusBoardText(task.content.text) },
        })),
      },
    };
  }

  /**
   * Lock-free, non-creating probe of the stored board for `agents bus
   * status`: the same event-bus gate and strict state validation every read
   * applies, without the writer lock, directory creation or claim-index join
   * `transaction` performs. Returns the stored row counts — deliveries split
   * into total and still-unacknowledged — or null when no state.json exists
   * (a verified-empty board). Throws on an unsafe, unreadable or invalid
   * store; the caller reports unavailable, never an empty count.
   */
  inspect(): BusBoardStateSummary | null {
    this.enabled();
    const file = join(this.root, 'state.json');
    if (!existsSync(file)) return null;
    const state = this.read();
    const acknowledged = new Set((state.receipts ?? []).map((receipt) => receipt.deliveryId));
    return {
      threads: state.threads.length,
      tasks: state.tasks.length,
      deliveries: state.deliveries.length,
      receipts: state.receipts?.length ?? 0,
      pendingDeliveries: state.deliveries.filter((delivery) => !acknowledged.has(delivery.id)).length,
    };
  }

  createTask(actor: string, threadId: string, itemId: string, title: string): BusTaskView {
    actor = this.peer(actor); boardId(itemId); boardBody(title);
    return this.transaction(true, (state) => {
      this.member(state, threadId, actor);
      if (state.tasks.some((task) => task.itemId === itemId)) throw new Error('Fleet item already has a board task');
      const task = { id: randomUUID(), threadId, itemId, title };
      state.tasks.push(task);
      return this.taskView(task);
    });
  }

  /**
   * The thread's tasks. `contains`, when given, is the normalized
   * `--contains` needle `board pending` applies — a task stays only when
   * its stored title carries it under the same scrubbed display-text rule;
   * tasks record no timestamp, so no time bound applies here.
   */
  listTasks(actor: string, threadId: string, contains?: string): BusTaskView[] {
    actor = this.peer(actor);
    const textHit = boardContainsMatcher(contains);
    return this.transaction(false, (state) => {
      this.member(state, threadId, actor);
      return state.tasks
        .filter((task) => task.threadId === threadId &&
          (textHit === undefined || textHit(task.title)))
        .map((task) => this.taskView(task));
    });
  }

  claimTask(actor: string, taskId: string): BusTaskView {
    actor = this.peer(actor);
    return this.transaction(true, (state) => {
      const task = this.task(state, taskId, actor);
      this.claimWriteCapacity(state);
      const existing = task.claim && this.options.fleet.validateClaims([task.claim])[0];
      if (existing) throw new Error('Task claim conflict');
      const claim = this.options.fleet.claimLeases([task.itemId], 1, actor)[0];
      if (!claim) throw new Error('Fleet claim conflict or queue unavailable');
      // If the board write fails, the queue lease still fences every contender
      // and expires normally. Never fabricate success or release another
      // generation.
      const recorded = upsertBoardLease({ sourceId: task.itemId, owner: actor, leaseUntil: claim.leaseUntil });
      if (recorded.status === 'conflict') throw new Error('Task claim conflict');
      if (recorded.status !== 'acquired') throw new Error('Claim store unavailable.');
      task.claim = claim;
      return this.taskView(task);
    });
  }

  handoffTask(actor: string, taskId: string, recipient: string): BusTaskView {
    actor = this.peer(actor); recipient = this.peer(recipient);
    return this.transaction(true, (state) => {
      const task = this.task(state, taskId, actor);
      this.member(state, task.threadId, recipient);
      if (!task.claim || task.claim.machineId !== actor) throw new Error('Only the current owner can hand off');
      this.claimWriteCapacity(state);
      const current = this.options.fleet.validateClaims([task.claim])[0];
      const claim = current && this.options.fleet.handoffClaim(current, recipient);
      if (!claim) throw new Error('Fleet handoff conflict or lease unavailable');
      const recorded = upsertBoardLease({ sourceId: task.itemId, owner: recipient, leaseUntil: claim.leaseUntil });
      if (recorded.status === 'conflict') throw new Error('Task claim conflict');
      if (recorded.status !== 'acquired') throw new Error('Claim store unavailable.');
      task.claim = claim;
      return this.taskView(task);
    });
  }

  renewTask(actor: string, taskId: string): BusTaskView {
    actor = this.peer(actor);
    return this.transaction(true, (state) => {
      const task = this.task(state, taskId, actor);
      if (!task.claim || task.claim.machineId !== actor) throw new Error('Only the current owner can renew');
      this.claimWriteCapacity(state);
      const current = this.options.fleet.validateClaims([task.claim])[0];
      const claim = current && this.options.fleet.renewClaims([current])[0];
      if (!claim) throw new Error('Fleet lease unavailable');
      const recorded = upsertBoardLease({ sourceId: task.itemId, owner: actor, leaseUntil: claim.leaseUntil });
      if (recorded.status !== 'acquired') throw new Error('Fleet lease unavailable');
      task.claim = claim;
      return this.taskView(task);
    });
  }

  releaseTask(actor: string, taskId: string): BusTaskView {
    actor = this.peer(actor);
    return this.transaction(true, (state) => {
      const task = this.task(state, taskId, actor);
      const current = task.claim && this.options.fleet.validateClaims([task.claim])[0];
      if (
        !current || current.machineId !== actor ||
        !this.options.fleet.releaseClaims([current]).includes(task.itemId)
      ) throw new Error('Fleet release refused');
      if (clearBoardLease(task.itemId, actor).status === 'unavailable') throw new Error('Claim store unavailable.');
      delete task.claim;
      return this.taskView(task);
    });
  }
}

/** The resolved fleet-wide board read `readBusBoardPending` returns. */
export type BusBoardPendingRead =
  | { source: 'available'; pending: BusBoardPendingPeers }
  | { source: 'missing' }
  | { source: 'unavailable' };

/**
 * Options for `readBusBoardPending`: `busRoot` overrides the fleet root the
 * board paths derive from — the same seam `phm comms inbox`'s board source
 * and tests use, unset resolving `<ashlrHome>/fleet` — `now` the epoch-ms
 * thunk the digest evaluates holds against, and
 * `jobId`/`contains`/`sinceMs`/`beforeMs` the same optional filters
 * `BusBoard.pendingAll` takes.
 */
export interface BusBoardPendingReadOptions {
  busRoot?: string;
  now?: () => number;
  jobId?: string;
  contains?: string;
  sinceMs?: number;
  beforeMs?: number;
}

/**
 * The one fleet-wide pending-board read every surface shares —
 * `BusBoard.pendingAll` under the same `busBoardStoragePaths` derivation
 * `phm bus board`, `agents bus work mine`'s board section,
 * `agents bus status` and `phm comms inbox`'s board source apply:
 * `<dirname(fleetRoot)>/bus` for state and `<fleetRoot>/bus-queue` for the
 * fleet queue — `<ashlrHome>/bus` and `<ashlrHome>/fleet/bus-queue` on the
 * default root — unless `fleet.sharedQueue` runs in attested filesystem
 * mode. A board that was never used — no `state.json` — is 'missing'
 * (verified empty) and the read returns before `BusBoard`'s transaction
 * can create the directory or lock file a write would leave; an
 * unreadable board, a malformed config, a relative path override or a
 * disabled event bus reports 'unavailable', never an empty digest passed
 * off as fact. Read-only: the digest takes the board's local read lock and
 * writes nothing — it never acknowledges a delivery or claims a task.
 */
export function readBusBoardPending(options: BusBoardPendingReadOptions = {}): BusBoardPendingRead {
  let cfg: AshlrConfig;
  try { cfg = loadConfigReadOnlyStrict(); } catch { return { source: 'unavailable' }; }
  const paths = busBoardStoragePaths(options.busRoot ?? join(ashlrHome(), 'fleet'), cfg);
  if (paths.status !== 'ok') return { source: 'unavailable' };
  if (!existsSync(join(paths.boardRoot, 'state.json'))) return { source: 'missing' };
  try {
    const shared = cfg.fleet?.sharedQueue;
    const fleet = new SharedStore(paths.queueRoot, shared?.leaseMs);
    return {
      source: 'available',
      pending: new BusBoard({ root: paths.boardRoot, fleet, cfg })
        .pendingAll(options.now?.(), options.jobId, options.contains, options.sinceMs, options.beforeMs),
    };
  } catch {
    return { source: 'unavailable' };
  }
}
