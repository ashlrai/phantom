/** Finite, explicitly approved resident queue. The engineering owner alone executes effects. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { readResourceJson } from './pool-runtime.js';
import type { ResourceConsoleEngineeringOwner } from './console-engineering.js';
import type { ResourceConsoleEngineeringSupervisionConfig, ResourceConsoleEngineeringSupervisionSnapshot, ResourceConsoleEngineeringSupervisionAdmission } from './console-engineering-supervisor-types.js';
import { validateResourceConsoleEngineeringSupervisionConfig, validateResourceConsoleEngineeringSupervisionState,
  ENGINEERING_SUPERVISION_STATE_MAX_BYTES, type ResourceConsoleEngineeringSupervisionState as DurableState } from './console-engineering-supervision-state.js';
import { bindOwnDataMethod, captureStrictOwnDataOptions, cloneCanonicalEngineeringData,
  failResourceSupervisor as fail, hasExactEngineeringOwnKeys as exact, isCanonicalEngineeringCharPath,
  isEngineeringHash, isEngineeringId, isEngineeringInteger as integer, pathExistsStrict as present } from './engineering-shared.js';
export { validateResourceConsoleEngineeringSupervisionConfig } from './console-engineering-supervision-state.js';
export type { ResourceConsoleEngineeringSupervisionConfig, ResourceConsoleEngineeringSupervisionSnapshot } from './console-engineering-supervisor-types.js';

const MAX_STATE_BYTES = ENGINEERING_SUPERVISION_STATE_MAX_BYTES;
const data = <T>(value: unknown): T =>
  cloneCanonicalEngineeringData<T>(value, MAX_STATE_BYTES, () => fail('INVALID_INPUT', 'Invalid engineering supervision data'));
export interface ResourceConsoleEngineeringSupervisor {
  snapshot(): ResourceConsoleEngineeringSupervisionSnapshot;
  /** Host-only final dispatch veto; no campaign, graph or pool reads. */
  isExecutionStopped(): boolean;
  setPaused(paused: boolean, expectedRevision: number): ResourceConsoleEngineeringSupervisionSnapshot;
  admit(input: unknown): ResourceConsoleEngineeringSupervisionSnapshot;
  start(): void;
  close(): Promise<void>;
}
export interface ResourceConsoleEngineeringSupervisorOptions {
  owner: ResourceConsoleEngineeringOwner;
  root: string;
  config: ResourceConsoleEngineeringSupervisionConfig;
  signal?: AbortSignal;
}

/** Construction enrolls private metadata/ownership only; start() is the explicit execution boundary. */
export function createResourceConsoleEngineeringSupervisor(options: ResourceConsoleEngineeringSupervisorOptions): ResourceConsoleEngineeringSupervisor {
  const captured = captureStrictOwnDataOptions(options, [], ['owner', 'root', 'config', 'signal'],
    () => fail('INVALID_INPUT', 'Invalid engineering supervision options'));
  const config = validateResourceConsoleEngineeringSupervisionConfig(captured.config);
  const configDigest = digest(canonical(config)); const root = captured.root; const signal = captured.signal;
  if (!isCanonicalEngineeringCharPath(root) || signal !== undefined && !(signal instanceof AbortSignal)) {
    fail('INVALID_INPUT', 'Invalid engineering supervision scope');
  }
  if (signal?.aborted) fail('UNAVAILABLE', 'Engineering supervision startup cancelled');
  const owner = captured.owner;
  const method = <K extends keyof ResourceConsoleEngineeringOwner>(key: K) =>
    bindOwnDataMethod(owner, key, () => fail('INVALID_INPUT', 'Invalid engineering supervision owner'));
  // Capture host methods before any asynchronous invocation or durable enrollment.
  const host = { catalog: method('catalog'), snapshot: method('snapshot'), readiness: method('readiness'),
    evidenceFingerprint: method('evidenceFingerprint'), launch: method('launch'), awaitSettlement: method('awaitSettlement') };
  const catalog = host.catalog();
  if (config.enrollments.some(row => !catalog.some(value => value.id === row.enrollmentId && value.enrollmentDigest === row.expectedEnrollmentDigest))) {
    fail('CONFLICT', 'Engineering supervision enrollment changed');
  }
  inspectPrivateDirectory(root);
  const parent = join(root, 'engineering-supervision'); const directory = join(parent, config.id);
  for (const path of [parent, directory]) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    inspectPrivateDirectory(path);
  }
  const acquired = acquireLocalStoreLockWithOutcome(join(directory, '.execution.lock'), 0, { anchorPath: directory, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') fail('CONFLICT', 'Engineering supervision is already owned or unavailable');
  const statePath = join(directory, 'state.json');
  let state!: DurableState;
  let persistedDigest: string | null = null;
  let started = false, closing = false, faulted = false;
  let closePromise: Promise<void> | undefined;
  let loop: Promise<void> | undefined;
  let deadlineMonotonic = Infinity;
  const active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  let wake: (() => void) | undefined;
  const fault = () => { faulted = true; for (const value of active.values()) value.abort.abort(); wake?.(); };
  const own = () => { if (!ownsLocalStoreLock(acquired.lock)) { fault(); fail('UNAVAILABLE', 'Engineering supervision ownership lost'); } };
  const expired = () => Date.now() >= Date.parse(state.deadlineAt) || performance.now() >= deadlineMonotonic;
  const stopped = () => {
    if (closing || signal?.aborted || faulted || expired()) return true;
    try { own(); if (Date.now() < Date.parse(state.writtenAt)) { fault(); return true; } } catch { return true; }
    return false;
  };
  function verifyPersistedState(): void {
    own();
    try {
      if (!present(statePath) || digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) !== persistedDigest) throw new Error();
    } catch { fault(); fail('UNAVAILABLE', 'Engineering supervision state unavailable'); }
  }
  function persist(next: DurableState): void {
    own(); const temporary = join(directory, `.state-${randomUUID()}.tmp`); let fd: number | undefined;
    try {
      const before = present(statePath) ? digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) : null;
      if (before !== persistedDigest) throw new Error();
      const bytes = Buffer.from(canonical(next) + '\n');
      if (bytes.length > MAX_STATE_BYTES) fail('CAPACITY', 'Engineering supervision state capacity reached');
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      for (let offset = 0; offset < bytes.length;) { const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written < 1) throw new Error(); offset += written; }
      fsyncSync(fd); closeSync(fd); fd = undefined; own();
      const current = present(statePath) ? digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) : null;
      if (current !== persistedDigest) throw new Error();
      renameSync(temporary, statePath); fsyncDirectory(directory); own(); state = next; persistedDigest = digest(canonical(next));
    } catch { fault(); fail('UNAVAILABLE', 'Engineering supervision state unavailable'); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* This invocation's exact temporary path only. */ } }
  }
  try {
    if (present(statePath)) {
      const source = validateResourceConsoleEngineeringSupervisionState(readResourceJson(statePath, MAX_STATE_BYTES), {
        config, catalog: catalog.map(({ id, enrollmentDigest }) => ({ id, enrollmentDigest })),
      });
      state = source; persistedDigest = digest(canonical(source));
    } else {
      const now = new Date().toISOString();
      persist({ schemaVersion: 1, configDigest, createdAt: now, writtenAt: now,
        deadlineAt: new Date(Date.parse(now) + config.maxDurationMs).toISOString(), paused: false, revision: 0,
        entries: config.enrollments.map(row => ({ enrollmentId: row.enrollmentId, enrollmentDigest: row.expectedEnrollmentDigest,
          attempts: 0, lastEvidenceDigest: null, lastOutcome: null })) });
    }
    deadlineMonotonic = performance.now() + Math.max(0, Date.parse(state.deadlineAt) - Date.now());
    if (Date.now() < Date.parse(state.writtenAt)) fail('UNAVAILABLE', 'Engineering supervision clock moved backwards');
  } catch (error) { releaseLocalStoreLock(acquired.lock); throw error; }

  function project(row: DurableState['entries'][number]): ResourceConsoleEngineeringSupervisionSnapshot['entries'][number] {
    const base = { enrollmentId: row.enrollmentId, enrollmentDigest: row.enrollmentDigest, attempts: row.attempts };
    if (faulted) return { ...base, state: 'unavailable', reasons: ['evidence-unavailable'] };
    try {
      const job = host.snapshot(row.enrollmentId);
      if (job.enrollmentId !== row.enrollmentId || job.enrollmentDigest !== row.enrollmentDigest ||
          !['healthy', 'missing'].includes(job.sourceState) || !['ready', 'running', 'completed', 'incomplete', 'stopped'].includes(job.state)) throw new Error();
      if (job.state === 'completed') return { ...base, state: 'completed', reasons: ['completed'] };
      if (active.has(row.enrollmentId) || job.state === 'running') return { ...base, state: 'running', reasons: ['running'] };
      if (job.cancelled || job.state === 'stopped') return { ...base, state: 'stopped', reasons: ['cancelled'] };
      if (expired() || job.deadlineAt !== null && Date.now() >= Date.parse(job.deadlineAt)) return { ...base, state: 'stopped', reasons: ['deadline-exhausted'] };
      if (closing) return { ...base, state: 'held', reasons: ['supervisor-closed'] };
      if (state.paused) return { ...base, state: 'held', reasons: ['supervisor-paused'] };
      if (!started) return { ...base, state: 'waiting', reasons: ['not-started'] };
      if (row.attempts >= config.maxAttemptsPerEnrollment) return { ...base, state: 'held', reasons: ['attempt-limit'] };
      const ready = host.readiness(row.enrollmentId);
      if (ready.enrollmentId !== row.enrollmentId || ready.enrollmentDigest !== row.enrollmentDigest) throw new Error();
      if (ready.status !== 'ready' || !['launch', 'reconcile', 'continue'].includes(ready.action)) return { ...base, state: 'waiting', reasons: ['waiting-for-readiness'] };
      const fingerprint = host.evidenceFingerprint(row.enrollmentId);
      if (fingerprint === null || !isEngineeringHash(fingerprint)) return { ...base, state: 'unavailable', reasons: ['evidence-unavailable'] };
      if (fingerprint === row.lastEvidenceDigest) return { ...base, state: 'held', reasons: ['unchanged-evidence'] };
      return { ...base, state: 'waiting', reasons: ['waiting-for-readiness'] };
    } catch { return { ...base, state: 'unavailable', reasons: ['evidence-unavailable'] }; }
  }
  function checkpoint(id: string, fingerprint: string | null, outcome: 'attempting' | 'settled' | 'unavailable'): void {
    persist({ ...state, writtenAt: new Date().toISOString(), entries: state.entries.map(row => row.enrollmentId === id ? {
      ...row, attempts: row.attempts + (outcome === 'attempting' ? 1 : 0), lastEvidenceDigest: fingerprint ?? row.lastEvidenceDigest, lastOutcome: outcome,
    } : row) });
  }
  function launch(id: string, fingerprint: string): void {
    checkpoint(id, fingerprint, 'attempting');
    if (stopped()) return;
    const abort = new AbortController();
    const pending = Promise.resolve().then(async () => {
      let outcome: 'settled' | 'unavailable' = 'settled';
      let invoked = false;
      try {
        if (stopped()) return;
        const row = state.entries.find(value => value.enrollmentId === id)!;
        invoked = true;
        host.launch({ enrollmentId: id, expectedEnrollmentDigest: row.enrollmentDigest }, {
          signal: abort.signal, isExecutionStopped: stopped,
        });
      } catch { outcome = 'unavailable'; }
      finally {
        // A throwing launch is not proof that it admitted nothing. Always drain
        // the owner's exact invocation before publishing a checkpoint or closing.
        try { if (invoked) await host.awaitSettlement(id); } catch { outcome = 'unavailable'; fault(); }
        // Publication after the call records its resulting evidence, so its own
        // newly written intent is not mistaken for a later recovery opportunity.
        if (!faulted) {
          try { checkpoint(id, host.evidenceFingerprint(id), outcome); } catch { fault(); }
        }
      }
    }).finally(() => { active.delete(id); wake?.(); });
    active.set(id, { abort, promise: pending });
  }
  async function run(): Promise<void> {
    try {
      while (!stopped()) {
        if (!state.paused) for (const row of state.entries) {
          if (stopped() || state.paused || active.size >= config.maxConcurrent) break;
          if (active.has(row.enrollmentId)) continue;
          const status = project(row);
          if (status.state !== 'waiting' || status.reasons[0] !== 'waiting-for-readiness') continue;
          const ready = host.readiness(row.enrollmentId);
          if (ready.enrollmentId !== row.enrollmentId || ready.enrollmentDigest !== row.enrollmentDigest ||
              ready.status !== 'ready' || !['launch', 'reconcile', 'continue'].includes(ready.action)) continue;
          const fingerprint = host.evidenceFingerprint(row.enrollmentId);
          if (!fingerprint || !isEngineeringHash(fingerprint) || fingerprint === row.lastEvidenceDigest || stopped()) continue;
          launch(row.enrollmentId, fingerprint);
        }
        const completed = state.entries.every(row => project(row).state === 'completed');
        if (completed && config.maxEnrollments === undefined) break;
        if (stopped()) break;
        await new Promise<void>(resolveWake => {
          // Empty/completed opt-in queues sleep until admission/control/close or
          // their original deadline. They do not repeatedly poll terminal work.
          const delay = completed ? deadlineMonotonic - performance.now() : Math.min(config.pollIntervalMs, deadlineMonotonic - performance.now());
          const timer = setTimeout(() => { wake = undefined; resolveWake(); }, Math.max(1, delay));
          wake = () => { clearTimeout(timer); wake = undefined; resolveWake(); };
        });
      }
    } catch { fault(); }
    finally {
      if (stopped()) for (const value of active.values()) value.abort.abort();
      await Promise.allSettled([...active.values()].map(value => value.promise));
    }
  }
  const supervisor: ResourceConsoleEngineeringSupervisor = {
    isExecutionStopped() {
      if (!started || state.paused || stopped()) return true;
      try { verifyPersistedState(); return false; } catch { return true; }
    },
    snapshot() {
      // Observing ownership must not abort calls, schedule work, or persist state.
      let unavailable = faulted;
      try { if (!closing && !ownsLocalStoreLock(acquired.lock)) unavailable = true; } catch { unavailable = true; }
      const entries = state.entries.map(row => unavailable ? { enrollmentId: row.enrollmentId, enrollmentDigest: row.enrollmentDigest,
        attempts: row.attempts, state: 'unavailable' as const, reasons: ['evidence-unavailable' as const] } : project(row));
      return { schemaVersion: 1, configId: config.id, configDigest, sourceState: unavailable ? 'degraded' : 'healthy',
        state: unavailable ? 'unavailable' : closing ? 'closed' : config.maxEnrollments === undefined && entries.every(row => row.state === 'completed') ? 'completed' :
          expired() ? 'timed-out' : state.paused ? 'paused' : started ? 'running' : 'idle',
        deadlineAt: state.deadlineAt, paused: state.paused, revision: state.revision, entries,
        ...(config.maxEnrollments === undefined ? {} : { admission: { maxEnrollments: config.maxEnrollments, remainingEnrollments: config.maxEnrollments - state.entries.length,
          autoAdmitPrepared: config.autoAdmitPrepared === true } }) };
    },
    admit(input) {
      const request = data<ResourceConsoleEngineeringSupervisionAdmission>(input);
      if (!exact(request, ['enrollments', 'expectedRevision']) || !integer(request.expectedRevision, 0, Number.MAX_SAFE_INTEGER) ||
          !Array.isArray(request.enrollments) || request.enrollments.length < 1 || request.enrollments.length > 32 ||
          request.enrollments.some(row => !exact(row, ['enrollmentId', 'expectedEnrollmentDigest']) ||
            !isEngineeringId(row.enrollmentId) || !isEngineeringHash(row.expectedEnrollmentDigest)) ||
          new Set(request.enrollments.map(row => row.enrollmentId)).size !== request.enrollments.length) fail('INVALID_INPUT', 'Invalid engineering supervision admission');
      if (config.maxEnrollments === undefined) fail('CONFLICT', 'Engineering supervision admission is not enabled');
      if (closing || faulted || signal?.aborted) fail('UNAVAILABLE', 'Engineering supervision unavailable');
      verifyPersistedState();
      const currentCatalog = host.catalog();
      const additions: DurableState['entries'] = [];
      for (const row of request.enrollments) {
        const matches = currentCatalog.filter(value => value.id === row.enrollmentId);
        if (matches.length !== 1 || matches[0]!.enrollmentDigest !== row.expectedEnrollmentDigest) {
          fail('CONFLICT', 'Engineering supervision enrollment changed');
        }
        const existing = state.entries.find(value => value.enrollmentId === row.enrollmentId);
        if (existing && existing.enrollmentDigest !== row.expectedEnrollmentDigest) fail('CONFLICT', 'Engineering supervision enrollment changed');
        if (!existing) additions.push({ enrollmentId: row.enrollmentId, enrollmentDigest: row.expectedEnrollmentDigest,
          attempts: 0, lastEvidenceDigest: null, lastOutcome: null });
      }
      // A lost-response retry does not consume capacity, rewrite state or wake
      // work. Only this exact all-existing case may ignore an old form revision.
      if (!additions.length) {
        if (request.expectedRevision > state.revision) fail('CONFLICT', 'Engineering supervision admission revision changed');
        verifyPersistedState();
        return supervisor.snapshot();
      }
      if (stopped()) fail('UNAVAILABLE', 'Engineering supervision admission deadline or ownership unavailable');
      if (request.expectedRevision !== state.revision) fail('CONFLICT', 'Engineering supervision admission revision changed');
      if (state.entries.length + additions.length > config.maxEnrollments) fail('CAPACITY', 'Engineering supervision enrollment capacity reached');
      if (state.revision === Number.MAX_SAFE_INTEGER) fail('CAPACITY', 'Engineering supervision revision exhausted');
      persist({ ...state, revision: state.revision + 1, writtenAt: new Date().toISOString(), entries: [...state.entries, ...additions] });
      wake?.(); return supervisor.snapshot();
    },
    setPaused(paused, expectedRevision) {
      if (typeof paused !== 'boolean' || !integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER)) fail('INVALID_INPUT', 'Invalid engineering supervision pause');
      if (closing || faulted) fail('UNAVAILABLE', 'Engineering supervision unavailable');
      own();
      if (expectedRevision !== state.revision) fail('CONFLICT', 'Engineering supervision pause revision changed');
      if (state.paused !== paused) {
        if (state.revision === Number.MAX_SAFE_INTEGER) fail('CAPACITY', 'Engineering supervision pause revision exhausted');
        persist({ ...state, paused, revision: state.revision + 1, writtenAt: new Date().toISOString() });
      }
      wake?.(); return supervisor.snapshot();
    },
    start() {
      if (closing || faulted) fail('UNAVAILABLE', 'Engineering supervision unavailable');
      if (started) return;
      own(); started = true; loop = run();
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; signal?.removeEventListener('abort', onAbort);
      for (const value of active.values()) value.abort.abort(); wake?.();
      closePromise = (async () => {
        await loop; await Promise.allSettled([...active.values()].map(value => value.promise));
        if (!releaseLocalStoreLock(acquired.lock)) faulted = true;
        if (faulted) fail('UNAVAILABLE', 'Engineering supervision shutdown unavailable');
      })();
      return closePromise;
    },
  };
  function onAbort() { void supervisor.close().catch(() => {}); }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) { void supervisor.close(); fail('UNAVAILABLE', 'Engineering supervision startup cancelled'); }
  return supervisor;
}
