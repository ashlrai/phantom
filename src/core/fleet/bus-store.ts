import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { SharedStore, type QueueClaimRef } from './shared-store.js';
import { createBusThreadDelivery, busHop, untrustedBusText, type BusThreadDelivery, type BusHop } from './bus-delivery.js';
import { validateBusEnvelope } from './bus-envelope.js';
import { appendBusHop } from './bus-hoplog.js';
import { resolveBusPeer } from './bus-identity.js';
import { emit } from './event-bus.js';

interface Thread { id: string; title: string; members: string[] }
interface Task { id: string; threadId: string; itemId: string; title: string; claim?: QueueClaimRef }
interface State { schemaVersion: 1; threads: Thread[]; tasks: Task[]; deliveries: BusThreadDelivery[] }
export interface BusTaskView {
  id: string; threadId: string; itemId: string;
  content: { trust: 'untrusted'; text: string };
  owner: { peerId: string; epoch: number; leaseUntil: number } | null;
}
export interface BusStoreOptions {
  root: string;
  fleet: SharedStore;
  cfg: AshlrConfig;
  /** null means Locus peers are unavailable; an empty directory denies all identities. */
  peers?: readonly { id: string }[] | null;
}
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const emptyState = (): State => ({ schemaVersion: 1, threads: [], tasks: [], deliveries: [] });
function id(value: string): string {
  if (typeof value !== 'string' || /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.exec(value)?.[0] !== value) throw new Error('Invalid bus identifier');
  return value;
}
function body(value: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16_384) throw new Error('Bus content must be 1..16384 bytes');
  return value;
}

/** Cooperative, private filesystem coordination. Claims remain fenced by SharedStore. */
export class BusStore {
  private readonly root: string;
  constructor(private readonly options: BusStoreOptions) { this.root = resolve(options.root); }

  private peer(value: string): string { return resolveBusPeer(value, this.options.peers).id; }
  private enabled(): void {
    const foundry = this.options.cfg.foundry as Record<string, unknown> | undefined;
    if (foundry?.['eventBus'] === false) throw new Error('Fleet event bus is disabled');
  }
  private privatePath(path: string, directory: boolean): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      !assurePrivateStoragePath(path, directory ? 'directory' : 'file', 'inspect-existing', { anchorPath: this.root }).ok) {
      throw new Error('Bus storage must be private, owned, and not linked');
    }
  }
  private read(): State {
    const path = join(this.root, 'state.json');
    if (!existsSync(path)) return emptyState();
    this.privatePath(path, false);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES || stat.nlink !== 1 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) throw new Error('Invalid private bus state');
      const state = JSON.parse(readFileSync(fd, 'utf8')) as State;
      if (state.schemaVersion !== 1 || !Array.isArray(state.threads) || !Array.isArray(state.tasks) || !Array.isArray(state.deliveries) ||
        [state.threads, state.tasks, state.deliveries].some((rows) => rows.length > MAX_RECORDS)) throw new Error('Invalid bus state');
      // Validate before use: corrupt private state is never silently replaced by an empty board.
      const threads = new Map<string, Thread>();
      for (const t of state.threads) {
        id(t.id); body(t.title);
        if (threads.has(t.id) || !Array.isArray(t.members) || !t.members.length ||
          new Set(t.members).size !== t.members.length) throw new Error('Invalid bus members');
        t.members.forEach(id); threads.set(t.id, t);
      }
      const tasks = new Set<string>(), items = new Set<string>();
      for (const t of state.tasks) {
        id(t.id); id(t.threadId); body(t.title); id(t.itemId);
        const thread = threads.get(t.threadId);
        if (!thread || tasks.has(t.id) || items.has(t.itemId)) throw new Error('Invalid bus task reference');
        tasks.add(t.id); items.add(t.itemId);
        if (t.claim !== undefined) {
          const c = t.claim;
          if (!c || c.itemId !== t.itemId || !thread.members.includes(c.machineId) || c.phase !== 'claimed' ||
            !Number.isSafeInteger(c.epoch) || c.epoch < 1 || !Number.isSafeInteger(c.leaseUntil) || c.leaseUntil < 1 ||
            typeof c.ownerKey !== 'string' || c.ownerKey.length > 2048 || typeof c.ownerToken !== 'string' ||
            !/^[0-9a-f-]{36}$/.test(c.ownerToken) || typeof c.queueId !== 'string' || !/^[0-9a-f-]{36}$/.test(c.queueId)) {
            throw new Error('Invalid bus task claim');
          }
        }
      }
      const envelopes = new Set<string>();
      for (const e of state.deliveries) {
        id(e.id); id(e.threadId); id(e.sender); id(e.recipient);
        const thread = threads.get(e.threadId);
        const wire = validateBusEnvelope({ ...e.message, body: null });
        if (!wire.ok || e.message.id !== e.id || e.message.from !== e.sender || e.message.to !== e.recipient) throw new Error('Invalid bus envelope');
        if (!thread || !thread.members.includes(e.sender) || !thread.members.includes(e.recipient) || envelopes.has(e.id) ||
          e.schemaVersion !== 1 || e.content?.trust !== 'untrusted' || typeof e.content.text !== 'string' ||
          typeof e.createdAt !== 'string' || !Number.isFinite(Date.parse(e.createdAt)) ||
          new Date(e.createdAt).toISOString() !== e.createdAt) throw new Error('Invalid bus delivery');
        envelopes.add(e.id);
      }
      return state;
    } finally { closeSync(fd); }
  }
  private transaction<T>(write: boolean, fn: (state: State) => T): T {
    this.enabled();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.privatePath(this.root, true);
    const lock = acquireLocalStoreLock(join(this.root, 'state.lock'), 2_000, { anchorPath: this.root, exactPrivateStorage: true });
    if (!lock) throw new Error('Bus storage is busy or unavailable');
    let temp: string | undefined;
    try {
      const state = this.read();
      const result = fn(state);
      if (write) {
        const data = JSON.stringify(state);
        if (Buffer.byteLength(data) > MAX_BYTES || [state.threads, state.tasks, state.deliveries].some((rows) => rows.length > MAX_RECORDS)) throw new Error('Bus storage is full');
        temp = join(this.root, `state-${randomUUID()}.tmp`);
        const fd = openSync(temp, 'wx', 0o600);
        try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
        this.privatePath(temp, false);
        if (!ownsLocalStoreLock(lock)) throw new Error('Bus storage lock lost');
        renameSync(temp, join(this.root, 'state.json'));
        temp = undefined;
        fsyncDirectory(this.root);
      }
      return result;
    } finally {
      if (temp) { try { unlinkSync(temp); } catch { /* Preserve the original failure. */ } }
      releaseLocalStoreLock(lock);
    }
  }
  private member(state: State, threadId: string, actor: string): Thread {
    const thread = state.threads.find((t) => t.id === id(threadId));
    if (!thread || !thread.members.includes(actor)) throw new Error('Thread missing or peer has not joined');
    return thread;
  }
  private task(state: State, taskId: string, actor: string): Task {
    const task = state.tasks.find((t) => t.id === id(taskId));
    if (!task) throw new Error('Task not found');
    this.member(state, task.threadId, actor);
    return task;
  }
  private taskView(task: Task): BusTaskView {
    const claim = task.claim && this.options.fleet.validateClaims([task.claim])[0];
    return { id: task.id, threadId: task.threadId, itemId: task.itemId,
      content: { trust: 'untrusted', text: untrustedBusText(task.title) },
      owner: claim ? { peerId: claim.machineId, epoch: claim.epoch, leaseUntil: claim.leaseUntil } : null };
  }
  private claimWriteCapacity(state: State): void {
    // Reserve enough room for a new capability before mutating the separate fleet
    // queue. Disk errors still fail closed; an orphaned claimed lease expires.
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES - 4096) throw new Error('Bus storage is full');
  }
  createThread(actor: string, title: string): { id: string } {
    actor = this.peer(actor); body(title);
    return this.transaction(true, (state) => {
      const thread = { id: randomUUID(), title, members: [actor] };
      state.threads.push(thread);
      return { id: thread.id };
    });
  }
  joinThread(actor: string, threadId: string): { id: string; members: string[] } {
    actor = this.peer(actor);
    return this.transaction(true, (state) => {
      const thread = state.threads.find((t) => t.id === id(threadId));
      if (!thread) throw new Error('Thread not found');
      if (!thread.members.includes(actor)) thread.members.push(actor);
      return { id: thread.id, members: [...thread.members] };
    });
  }
  listThreads(actor: string): Array<{ id: string; members: string[]; content: { trust: 'untrusted'; text: string } }> {
    actor = this.peer(actor);
    return this.transaction(false, (state) => state.threads.filter((t) => t.members.includes(actor)).map((t) => ({
      id: t.id, members: [...t.members], content: { trust: 'untrusted', text: untrustedBusText(t.title) },
    })));
  }
  async post(actor: string, threadId: string, text: string): Promise<{ delivered: number; envelopeIds: string[]; unlogged: number }> {
    actor = this.peer(actor); body(text);
    const deliveries = this.transaction(true, (state) => {
      const thread = this.member(state, threadId, actor);
      // Snapshot membership once; later joins do not receive historical posts.
      const messages = thread.members.map((recipient) => {
        this.peer(recipient);
        return createBusThreadDelivery(thread.id, actor, recipient, text);
      });
      state.deliveries.push(...messages);
      return messages;
    });
    // Durable inboxes are authoritative; lifecycle observers are best effort.
    let unlogged = 0;
    for (const delivery of deliveries) {
      const elapsed = Date.now() - Date.parse(delivery.createdAt);
      const ttl = delivery.message.ttl - Math.ceil(elapsed);
      // Inbox reads are historical inspection. Live observers receive only a
      // remaining lifetime, never a reset TTL after a slow earlier observer.
      if (elapsed >= 0 && ttl > 0) {
        const frozen = Object.freeze({ ...delivery, message: Object.freeze({ ...delivery.message, ttl }), content: Object.freeze({ ...delivery.content }) });
        await emit('bus:delivery', frozen, this.options.cfg);
      }
      if (!appendBusHop(delivery.message, join(this.root, 'hops.jsonl'))) unlogged++;
    }
    return { delivered: deliveries.length, envelopeIds: deliveries.map((e) => e.id), unlogged };
  }
  readThread(actor: string, threadId: string): BusThreadDelivery[] {
    actor = this.peer(actor);
    return this.transaction(false, (state) => {
      this.member(state, threadId, actor);
      return state.deliveries.filter((e) => e.threadId === threadId && e.recipient === actor).map((e) => ({
        schemaVersion: 1, id: e.id, threadId: e.threadId, sender: e.sender,
        recipient: e.recipient, createdAt: e.createdAt,
        message: { id: e.id, from: e.sender, to: e.recipient, priority: e.message.priority, ttl: e.message.ttl },
        content: { trust: 'untrusted', text: untrustedBusText(e.content.text) },
      }));
    });
  }
  hops(actor: string, threadId: string): BusHop[] { return this.readThread(actor, threadId).map(busHop); }
  createTask(actor: string, threadId: string, itemId: string, title: string): BusTaskView {
    actor = this.peer(actor); id(itemId); body(title);
    return this.transaction(true, (state) => {
      this.member(state, threadId, actor);
      if (state.tasks.some((t) => t.itemId === itemId)) throw new Error('Fleet item already has a board task');
      const task = { id: randomUUID(), threadId, itemId, title };
      state.tasks.push(task);
      return this.taskView(task);
    });
  }
  listTasks(actor: string, threadId: string): BusTaskView[] {
    actor = this.peer(actor);
    return this.transaction(false, (state) => {
      this.member(state, threadId, actor);
      return state.tasks.filter((t) => t.threadId === threadId).map((t) => this.taskView(t));
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
      // If the board write fails, the queue lease still fences every contender and
      // expires normally. Never fabricate success or release another generation.
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
      if (!current || current.machineId !== actor || !this.options.fleet.releaseClaims([current]).includes(task.itemId)) throw new Error('Fleet release refused');
      delete task.claim;
      return this.taskView(task);
    });
  }
}
