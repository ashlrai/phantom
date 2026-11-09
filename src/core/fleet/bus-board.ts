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
import { join, resolve } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { SharedStore, type QueueClaimRef } from './shared-store.js';
import {
  busBoardHop, createBusBoardDelivery, presentBusBoardText,
  type BusBoardDelivery, type BusBoardHop,
} from './bus-delivery.js';
import { validateBusEnvelope } from './bus-envelope.js';
import { appendBusHop } from './bus-hoplog.js';
import { emit } from './event-bus.js';

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

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 10_000;
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

  listThreads(actor: string): BusThreadView[] {
    actor = this.peer(actor);
    return this.transaction(false, (state) => state.threads
      .filter((thread) => thread.members.includes(actor))
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

  readThread(actor: string, threadId: string, pendingOnly = false): BusBoardDelivery[] {
    actor = this.peer(actor);
    return this.transaction(false, (state) => {
      this.member(state, threadId, actor);
      const acknowledged = new Set((state.receipts ?? []).map((receipt) => receipt.deliveryId));
      return state.deliveries
        .filter((delivery) => delivery.threadId === threadId && delivery.recipient === actor &&
          (!pendingOnly || !acknowledged.has(delivery.id)))
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

  /** Only the sender sees receipt metadata for its own deliveries. */
  receipts(actor: string, threadId: string): BoardReceipt[] {
    actor = this.peer(actor);
    return this.transaction(false, (state) => {
      this.member(state, threadId, actor);
      const sent = new Set(state.deliveries.filter((row) => row.threadId === threadId && row.sender === actor).map((row) => row.id));
      return (state.receipts ?? []).filter((row) => sent.has(row.deliveryId)).map((row) => ({ ...row }));
    });
  }

  hops(actor: string, threadId: string): BusBoardHop[] {
    return this.readThread(actor, threadId).map(busBoardHop);
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

  listTasks(actor: string, threadId: string): BusTaskView[] {
    actor = this.peer(actor);
    return this.transaction(false, (state) => {
      this.member(state, threadId, actor);
      return state.tasks.filter((task) => task.threadId === threadId).map((task) => this.taskView(task));
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
      delete task.claim;
      return this.taskView(task);
    });
  }
}
