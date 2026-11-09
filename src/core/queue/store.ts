import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { planReplay, type ReplayOptions } from './replay.js';
import { exportMarkdown } from './markdown.js';
import { exportStacksyncCompletion } from './stacksync.js';
import { parseSpawn, planSpawn, SPAWN_LIMITS, type SpawnResult } from './decompose.js';
import { mergedJobsFromJsonl, readSource } from '../fleet/runs-parked-queue.js';
import { validateQueue, type QueueDocument, type QueueJob } from './schema.js';

/** One bounded spawn proposal; metadata only — never scope, acceptance or dep text. */
interface SpawnJournalEntry {
  v: 1;
  at: string;
  parent: string;
  owner: string;
  proposed: number;
  applied: number;
  duplicates: number;
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSpawnJournalEntry(value: unknown): value is SpawnJournalEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row['v'] === 1 && typeof row['at'] === 'string' && Number.isFinite(Date.parse(row['at'])) &&
    typeof row['parent'] === 'string' && JOB_ID.test(row['parent']) &&
    typeof row['owner'] === 'string' && row['owner'].length <= 128 &&
    ['proposed', 'applied', 'duplicates'].every(key =>
      Number.isSafeInteger(row[key]) && (row[key] as number) >= 0 && (row[key] as number) <= 100_000);
}

/**
 * MERGED-outcome ids from the runs ledger, for spawn dedup against landed
 * work. Best-effort: a missing or degraded ledger yields an empty set; the
 * queue document itself is always consulted.
 */
export async function loadMergedJobIds(runsDir: string): Promise<Set<string>> {
  const source = await readSource(join(runsDir, 'metrics', 'jobs.jsonl'), 2 * 1024 * 1024, true);
  return mergedJobsFromJsonl(source.text);
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** Atomic replacement: readers see a complete old or new snapshot, never a partial write. */
async function atomicWrite(path: string, text: string, mode = 0o600): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', mode);
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
    await file.close();
    await rename(temp, path);
  } finally {
    await file.close();
    await unlink(temp).catch(error => { if (!missing(error)) throw error; });
  }
}

/** Independent of dispatchd. No dispatch, authentication, inference or push side effects. */
export class QueueStore {
  constructor(readonly directory = join(homedir(), '.ashlr-runs', 'queue'), readonly lockTimeoutMs = 5_000) {}
  get path(): string { return join(this.directory, 'queue.v1.json'); }
  async read(): Promise<QueueDocument> {
    let text: string;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Queue snapshot must be a regular file');
      text = await readFile(this.path, 'utf8');
    }
    catch (error) { if (missing(error)) return { schema: 'queue.v1', jobs: [] }; throw error; }
    const doc: unknown = JSON.parse(text);
    validateQueue(doc);
    return doc;
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('Queue directory cannot be a symlink');
    const lockPath = join(this.directory, 'queue.v1.lock');
    const deadline = Date.now() + this.lockTimeoutMs;
    let lock;
    for (;;) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('Queue lock busy; never automatically steal a lock');
        await delay(10);
      }
    }
    const token = randomUUID();
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token }));
      return await operation();
    } finally {
      // A failed close must not leave a stale lock behind, and release must never delete a lock
      // another process acquired after an operator cleared ours.
      await lock.close().catch(() => undefined);
      const held = await readFile(lockPath, 'utf8').catch(() => undefined);
      if (held?.includes(token)) await unlink(lockPath).catch(error => { if (!missing(error)) throw error; });
    }
  }
  private async mutate<T>(change: (doc: QueueDocument) => T): Promise<T> {
    return this.locked(async () => {
      const doc = await this.read();
      const result = change(doc);
      validateQueue(doc);
      await atomicWrite(this.path, JSON.stringify(doc, null, 2) + '\n');
      return result;
    });
  }
  async add(job: QueueJob): Promise<QueueJob> {
    return this.mutate(doc => { doc.jobs.push(structuredClone(job)); return job; });
  }
  /** Bootstrap only. Reimporting must never erase a concurrent claim or completed work. */
  async import(doc: QueueDocument): Promise<QueueDocument> {
    validateQueue(doc);
    return this.mutate(current => {
      if (current.jobs.length) throw new Error('Import requires an empty queue; existing jobs are never replaced');
      Object.assign(current, structuredClone(doc));
      return current;
    });
  }
  async claim(id: string, owner: string): Promise<QueueJob> {
    return this.mutate(doc => {
      const job = this.find(doc, id);
      if (job.status !== 'READY') throw new Error(`Job is not READY: ${id}`);
      const pending = job.deps.filter(dep => doc.jobs.find(j => j.id === dep)?.status !== 'DONE');
      if (pending.length) throw new Error(`Dependencies not DONE: ${pending.join(', ')}`);
      job.status = 'CLAIMED';
      job.claims.push({ owner, claimedAt: new Date().toISOString() });
      return job;
    });
  }
  /** Operator promotion of a proposed job (spawn.v1 children land PROPOSED). */
  async promote(id: string): Promise<QueueJob> {
    return this.mutate(doc => {
      const job = this.find(doc, id);
      if (job.status !== 'PROPOSED') throw new Error(`Job is not PROPOSED: ${id}`);
      job.status = 'READY';
      return job;
    });
  }
  async finish(id: string, owner: string, options: { prUrl?: string; reason?: string } = {}): Promise<QueueJob> {
    const result = await this.mutate(doc => {
      const job = this.find(doc, id);
      const claim = job.claims.at(-1);
      if (!['CLAIMED', 'PR-OPEN'].includes(job.status) || !claim || claim.owner !== owner || claim.finishedAt) throw new Error('An active claim owned by --owner is required');
      job.status = options.reason ? 'BLOCKED' : options.prUrl ? 'PR-OPEN' : 'DONE';
      if (options.reason) job.blockedReason = options.reason;
      if (options.prUrl) job.prUrl = options.prUrl;
      if (job.status !== 'PR-OPEN') claim.finishedAt = new Date().toISOString();
      return job;
    });
    await exportStacksyncCompletion(result);
    return result;
  }
  async replay(options: ReplayOptions): Promise<QueueJob[]> {
    if (options.dryRun) return planReplay(await this.read(), options);
    return this.mutate(doc => {
      const jobs = planReplay(doc, options);
      doc.jobs.push(...jobs);
      return jobs;
    });
  }
  /**
   * RQ-SWE5-AGENT-SWARM: apply a spawn.v1 self-decomposition proposal under
   * the queue lock. Children land as PROPOSED — never dispatch authority.
   * The per-parent rate limit rides a bounded journal of proposal metadata;
   * a corrupt journal fails closed rather than silently unlocking the cap.
   */
  async propose(proposal: unknown, options: { now?: number; mergedIds?: ReadonlySet<string> } = {}): Promise<SpawnResult> {
    const parsed = parseSpawn(proposal);
    const now = options.now ?? Date.now();
    return this.locked(async () => {
      const doc = await this.read();
      const fresh = (await this.readSpawnJournal()).filter(e => Date.parse(e.at) > now - SPAWN_LIMITS.windowMs);
      const plan = planSpawn(doc, parsed, {
        proposalsInWindow: fresh.filter(e => e.parent === parsed.parent).length,
        mergedIds: options.mergedIds,
      });
      const entry: SpawnJournalEntry = { v: 1, at: new Date(now).toISOString(), parent: plan.parent,
        owner: parsed.owner, proposed: parsed.jobs.length, applied: plan.jobs.length, duplicates: plan.duplicates.length };
      const kept = [...fresh, entry].slice(-SPAWN_LIMITS.journalEntries);
      // Journal before the snapshot: a crash must over-count the rate cap, not under-count it.
      await atomicWrite(this.spawnJournalPath, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
      doc.jobs.push(...plan.jobs.map(job => structuredClone(job)));
      validateQueue(doc);
      await atomicWrite(this.path, JSON.stringify(doc, null, 2) + '\n');
      return { schema: 'spawn-result.v1', parent: plan.parent, applied: plan.jobs.map(job => job.id), duplicates: plan.duplicates };
    });
  }
  get spawnJournalPath(): string { return join(this.directory, 'spawn-proposals.jsonl'); }
  private async readSpawnJournal(): Promise<SpawnJournalEntry[]> {
    let text: string;
    try {
      const info = await lstat(this.spawnJournalPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Spawn journal must be a regular file');
      text = await readFile(this.spawnJournalPath, 'utf8');
    } catch (error) { if (missing(error)) return []; throw error; }
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Spawn journal is too large');
    return text.split('\n').filter(line => line.trim()).map((line, index) => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new Error(`Invalid spawn journal line ${index + 1}`); }
      if (!isSpawnJournalEntry(value)) throw new Error(`Invalid spawn journal line ${index + 1}`);
      return value;
    });
  }
  async mirror(): Promise<string> {
    return this.locked(async () => {
      const path = join(this.directory, 'queue.mirror.md');
      await atomicWrite(path, '<!-- Read-only queue.v1 mirror. Edit through phm queue. -->\n' + exportMarkdown(await this.read()), 0o444);
      return path;
    });
  }
  private find(doc: QueueDocument, id: string): QueueJob {
    const job = doc.jobs.find(j => j.id === id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }
}
