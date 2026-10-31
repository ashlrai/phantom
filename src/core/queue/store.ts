import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exportMarkdown } from './markdown.js';
import { validateQueue, type QueueDocument, type QueueJob } from './schema.js';

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
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      return await operation();
    } finally { await lock.close(); await unlink(lockPath); }
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
  async finish(id: string, owner: string, options: { prUrl?: string; reason?: string } = {}): Promise<QueueJob> {
    return this.mutate(doc => {
      const job = this.find(doc, id);
      const claim = job.claims.at(-1);
      if (!['CLAIMED', 'PR-OPEN'].includes(job.status) || !claim || claim.owner !== owner || claim.finishedAt) throw new Error('An active claim owned by --owner is required');
      job.status = options.reason ? 'BLOCKED' : options.prUrl ? 'PR-OPEN' : 'DONE';
      if (options.reason) job.blockedReason = options.reason;
      if (options.prUrl) job.prUrl = options.prUrl;
      if (job.status !== 'PR-OPEN') claim.finishedAt = new Date().toISOString();
      return job;
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
