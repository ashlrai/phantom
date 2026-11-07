/** One fixed, effectful metadata publisher. Fresh custody runs off the HTTP thread;
 * only the bounded private-file commit runs on the collector's owning thread. */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readResourceJson } from './pool-runtime.js';
import type { ResourceQuotaRefreshLease, ResourceQuotaRefreshOwner } from './quota-refresh-lease.js';
import { captureQuotaEvidenceRejectPins } from './quota-evidence-pins.js';
import { createEngineeringWorkerRpcHost } from './engineering-worker-rpc.js';
import { sharedQuotaEvidenceAtTime, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME, RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS,
  type SharedQuotaEvidence, type SharedQuotaScope } from './quota-shared-evidence.js';

const MAX_BYTES = 128 * 1024;
const unavailable = () => new Error('Shared resource quota evidence publication unavailable');
export interface QuotaEvidenceSnapshot { evidence: SharedQuotaEvidence; state: 'running' | 'closed' }
export interface QuotaEvidencePublisher {
  /** False means this waiting snapshot was superseded, never published. */
  publish(snapshot: QuotaEvidenceSnapshot): Promise<boolean>;
  close(): Promise<void>;
}
function copy<T>(value: T): T {
  const text = canonicalEvidencePackJsonV3(value);
  if (text === null || Buffer.byteLength(text) > MAX_BYTES) throw unavailable();
  return JSON.parse(text) as T;
}
function entrypoint(): URL {
  if (import.meta.url.endsWith('/quota-evidence-background.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./quota-evidence-worker.ts', import.meta.url).href;
    return new URL(`data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`)}`);
  }
  return new URL('./quota-evidence-worker.js', import.meta.url);
}
/** No selectable worker, witness, commit callback or provider transport. */
export function createQuotaEvidencePublisher(input: {
  scope: SharedQuotaScope; lease: ResourceQuotaRefreshLease; isCurrent(): boolean; onFault(): void;
}): QuotaEvidencePublisher {
  const scope = copy(input.scope);
  sharedQuotaEvidenceAtTime({ ...scope, evidence: { observations: [], unavailableWorkerIds: [] }, now: Date.now() });
  const lease = input.lease;
  const isCurrent = input.isCurrent.bind(input), onFault = input.onFault.bind(input);
  let closing = false, faulted = false, ready = false, sequence = 0;
  const closeFlag = new Int32Array(new SharedArrayBuffer(4));
  type Job = { id: number; snapshot: QuotaEvidenceSnapshot; resolve(value: boolean): void; reject(error: Error): void;
    owner?: ResourceQuotaRefreshOwner; startedAt?: number; deadline?: number; timer?: ReturnType<typeof setTimeout>; committed?: boolean };
  let active: Job | null = null, latest: Job | null = null, closePromise: Promise<void> | undefined;
  function current(): void { if (closing || faulted || !isCurrent()) throw unavailable(); }
  function finish(job: Job, error?: Error): void { clearTimeout(job.timer); if (error) job.reject(error); else job.resolve(job.committed === true); }
  function fault(): void {
    if (faulted || closing) return;
    faulted = true; Atomics.store(closeFlag, 0, 1); rpc.close(); clearTimeout(startup);
    if (active) { finish(active, unavailable()); active = null; }
    if (latest) { finish(latest, unavailable()); latest = null; }
    try { onFault(); } catch { /* Notification cannot revive publication. */ }
    // This worker starts no provider. Termination must settle before lease release.
    void stopWorker();
  }
  function validTime(job: Job): void {
    if (job.startedAt === undefined || job.deadline === undefined || Date.now() < job.startedAt ||
      Date.now() >= job.startedAt + RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS || performance.now() >= job.deadline) throw unavailable();
    for (const row of job.snapshot.evidence.observations) if (Date.parse(row.expiresAt) > job.startedAt && Date.parse(row.expiresAt) <= Date.now()) throw unavailable();
  }
  const rpc = createEngineeringWorkerRpcHost({ closeFlag, maxBytes: 2 * MAX_BYTES, handlers: {
    'quota.commit': value => {
      current();
      if (!active || !value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'evidence,id,pins' || (value as { id?: unknown }).id !== active.id || active.committed) throw unavailable();
      const job = active;
      if (canonical((value as { pins?: unknown }).pins) !== canonical(captureQuotaEvidenceRejectPins(scope))) throw unavailable();
      validTime(job);
      if (canonical(lease.identity()) !== canonical(job.owner)) throw unavailable();
      const evidence = sharedQuotaEvidenceAtTime({ ...scope, evidence: (value as { evidence: SharedQuotaEvidence }).evidence, now: Date.now() });
      if (canonical(evidence.observations) !== canonical(job.snapshot.evidence.observations)) throw unavailable();
      const baseline = sharedQuotaEvidenceAtTime({ ...scope, evidence: job.snapshot.evidence, now: Date.now() });
      if (baseline.unavailableWorkerIds.some(id => !evidence.unavailableWorkerIds.includes(id)) ||
        baseline.quotaUnavailableWorkerIds?.some(id => !evidence.quotaUnavailableWorkerIds?.includes(id))) throw unavailable();
      const record = { schemaVersion: 1, scope: 'codex-native-metadata', poolDigest: scope.config.poolDigest,
        configDigest: digestConfig(), owner: job.owner, state: job.snapshot.state,
        publishedAt: new Date(job.startedAt!).toISOString(),
        expiresAt: new Date(job.startedAt! + RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS).toISOString(), ...evidence };
      const bytes = canonical(record) + '\n';
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw unavailable();
      const file = join(scope.root, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME);
      inspectPrivateDirectory(scope.root);
      try { lstatSync(file); readResourceJson(file, MAX_BYTES); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // No JS yield from the final lifecycle/owner/time check through atomic commit.
      current(); validTime(job);
      if (canonical(lease.identity()) !== canonical(job.owner)) throw unavailable();
      current(); validTime(job);
      writePrivateFileAtomically(`${file}.${randomUUID()}.tmp`, file, bytes, { anchorPath: scope.root, label: 'Shared quota evidence' });
      job.committed = true;
      if (canonical(lease.identity()) !== canonical(job.owner)) throw unavailable();
      current(); validTime(job);
      return true;
    },
  } });
  const worker = new Worker(entrypoint(), { workerData: { schemaVersion: 1, scope, closeBuffer: closeFlag.buffer }, execArgv: [],
    // Node enforces these heap limits. Bun ignores resourceLimits: payload/queue
    // bounds below are real, but this option is not a Bun RSS cap.
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 } });
  const startup = setTimeout(fault, RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS);
  startup.unref?.();
  function pump(): void {
    if (!ready || closing || faulted || active || !latest) return;
    active = latest; latest = null;
    try {
      current(); active.owner = lease.identity(); active.startedAt = Date.now();
      active.deadline = performance.now() + RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS;
      active.timer = setTimeout(fault, RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS); active.timer.unref?.();
      worker.postMessage({ type: 'publish', id: active.id, owner: active.owner, snapshot: active.snapshot, startedAt: active.startedAt });
    } catch { fault(); }
  }
  worker.on('message', (value: unknown) => {
    if (rpc.handle(value)) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { fault(); return; }
    const row = value as Record<string, unknown>;
    if (row.type === 'ready' && Object.keys(row).length === 1 && !ready && !closing && !faulted) { ready = true; clearTimeout(startup); pump(); return; }
    if (row.type !== 'result' || Object.keys(row).sort().join(',') !== 'id,ok,type' || row.id !== active?.id || typeof row.ok !== 'boolean') { fault(); return; }
    if (!row.ok || !active?.committed) { fault(); return; }
    const done = active; active = null; finish(done); pump();
  });
  worker.on('error', fault);
  worker.on('exit', () => { if (!closing) fault(); });
  function stopWorker(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true; clearTimeout(startup); Atomics.store(closeFlag, 0, 1); rpc.close();
    if (latest) { finish(latest); latest = null; }
    closePromise = Promise.resolve().then(() => worker.terminate()).then(() => {
      if (active) { finish(active); active = null; }
      if (faulted) throw unavailable();
    });
    // A failure remains observable to close(); it is never an unhandled task.
    void closePromise.catch(() => {});
    return closePromise;
  }
  return Object.freeze({
    publish(snapshot: QuotaEvidenceSnapshot): Promise<boolean> {
      try { current(); if (!['running', 'closed'].includes(snapshot.state)) throw unavailable();
        const captured = copy(snapshot);
        if (sequence >= Number.MAX_SAFE_INTEGER) throw unavailable();
        return new Promise<boolean>((resolve, reject) => {
          if (latest) finish(latest);
          latest = { id: ++sequence, snapshot: captured, resolve, reject }; pump();
        });
      } catch { return Promise.reject(unavailable()); }
    }, close: stopWorker,
  });
  function digestConfig(): string { return digest(canonical(scope.config)); }
}
