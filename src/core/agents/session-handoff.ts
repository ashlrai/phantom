import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { acquireCoordination, renewCoordination, settleCoordination } from './claim-store.js';
import { handoffRepoState } from './session-handoff-repo.js';
import { HANDOFF_LOG_BYTES, handoffId, handoffModel, handoffTier, handoffPressure, handoffSignalSchema, parseHandoff, refuseHandoff,
  scrubHandoffDraft, type HandoffDraft, type HandoffSignal, type SessionHandoff } from './session-handoff-schema.js';

function directory(runs: string, create = false): string {
  const root = realpathSync(runs);
  const dir = join(root, 'handffs'); // Wire spelling is intentional: runs/handffs/<job>.jsonl.
  if (create) mkdirSync(dir, { mode: 0o700 });
  if (!assurePrivateStoragePath(dir, 'directory', 'inspect-existing', { anchorPath: root }).ok) {
    return refuseHandoff('Unsafe handoff directory.');
  }
  return dir;
}

function journal(dir: string, job: string): { text: string; records: SessionHandoff[] } {
  if (!handoffId.safeParse(job).success) return refuseHandoff('Invalid job id.');
  const path = join(dir, `${job}.jsonl`);
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', records: [] };
    return refuseHandoff('Cannot inspect handoff journal.');
  }
  const read = readStableRegularFile(path, { anchorPath: dir, maxFileBytes: HANDOFF_LOG_BYTES, remainingBytes: HANDOFF_LOG_BYTES });
  if (!read.ok || !read.text.endsWith('\n')) return refuseHandoff('Unreadable or incomplete handoff journal.');
  try {
    const records = read.text.slice(0, -1).split('\n').map(line => parseHandoff(JSON.parse(line)));
    if (records.some((record, i) => record.job !== job || record.revision !== i + 1 || record.attempt !== records[0].attempt ||
      record.repo !== records[0].repo || (i > 0 && records[i - 1].signal.kind === 'completed'))) return refuseHandoff('Broken handoff history.');
    return { text: read.text, records };
  } catch { return refuseHandoff('Invalid handoff journal.'); }
}

export function readSessionHandoff(runs: string, job: string): SessionHandoff {
  return journal(directory(runs), job).records.at(-1) ?? refuseHandoff('No checkpoint available.');
}

export interface SessionHandoffListEntry {
  job: string;
  attempt: string;
  revision: number;
  at: string;
  lane: string;
  model: string;
  minTier: HandoffDraft['minTier'];
  repo: string;
  signal: HandoffSignal;
  needs: string[];
  /** 'open' while the latest signal is not 'completed'; a completed journal is retained history. */
  state: 'open' | 'completed';
  /** repoState.head only; the absolute root, diff digest and Entire reference stay in the per-job read. */
  head: string;
}

export interface SessionHandoffList {
  schema: 'session-handoff.list.v1';
  /** 'missing' is a verified-absent store (no runs or handoffs directory); 'unavailable' means the
   * directory could not be read, so handoffs and unreadable stay null — unknown, never a fabricated empty. */
  status: 'ok' | 'missing' | 'unavailable';
  handoffs: SessionHandoffListEntry[] | null;
  /** Job ids whose journal failed the same validation `show` applies; other journals still list. */
  unreadable: string[] | null;
  /** More journal files exist than the bounded scan covers; the newest by journal mtime were read. */
  truncated: boolean;
}

const HANDOFF_LIST_MAX_JOURNALS = 256;

function handoffList(status: 'missing' | 'unavailable'): SessionHandoffList {
  const empty = status === 'missing';
  return { schema: 'session-handoff.list.v1', status,
    handoffs: empty ? [] : null, unreadable: empty ? [] : null, truncated: false };
}

/** Fleet-wide index of session-handoff journals: which jobs hold a checkpoint awaiting resume or
 * failover, without knowing each job id. Read-only; per-file validation matches `show`, so one
 * corrupt journal lands in `unreadable` instead of poisoning the index. Existence is staged before
 * the private-storage check because a never-written store is 'missing', not 'unsafe'. */
export function listSessionHandoffs(runs: string): SessionHandoffList {
  let root: string;
  try { root = realpathSync(runs); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return handoffList('missing');
    return handoffList('unavailable');
  }
  const dir = join(root, 'handoffs'); // Wire spelling is intentional: runs/handffs/<job>.jsonl.
  try { lstatSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return handoffList('missing');
    return handoffList('unavailable');
  }
  if (!assurePrivateStoragePath(dir, 'directory', 'inspect-existing', { anchorPath: root }).ok) {
    return refuseHandoff('Unsafe handoff directory.');
  }
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return handoffList('missing');
    return handoffList('unavailable');
  }
  const candidates = names.filter(name => name.endsWith('.jsonl'))
    .map(name => name.slice(0, -'.jsonl'.length))
    .filter(job => handoffId.safeParse(job).success)
    .map(job => {
      let mtime = Number.NEGATIVE_INFINITY;
      try { mtime = lstatSync(join(dir, `${job}.jsonl`)).mtimeMs; } catch { /* journal() reports it unreadable */ }
      return { job, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime || a.job.localeCompare(b.job));
  const scanned = candidates.slice(0, HANDOFF_LIST_MAX_JOURNALS);
  const handoffs: SessionHandoffListEntry[] = [];
  const unreadable: string[] = [];
  for (const { job } of scanned) {
    try {
      const record = journal(dir, job).records.at(-1);
      if (record === undefined) { unreadable.push(job); continue; }
      handoffs.push({ job: record.job, attempt: record.attempt, revision: record.revision, at: record.at,
        lane: record.lane, model: record.model, minTier: record.minTier, repo: record.repo,
        signal: record.signal, needs: [...record.needs],
        state: record.signal.kind === 'completed' ? 'completed' : 'open', head: record.repoState.head });
    } catch { unreadable.push(job); }
  }
  handoffs.sort((a, b) => b.at.localeCompare(a.at) || a.job.localeCompare(b.job));
  unreadable.sort();
  return { schema: 'session-handoff.list.v1', status: 'ok', handoffs, unreadable,
    truncated: candidates.length > scanned.length };
}

/** Atomic append preserving every previous row. CAS prevents stale workers overwriting newer progress. */
export async function checkpointSession(input: {
  runs: string; worktree: string; draft: unknown; signal: unknown; expectedRevision: number;
  beforeWrite?: () => void;
}): Promise<SessionHandoff> {
  const draft = scrubHandoffDraft(input.draft);
  const signal = handoffSignalSchema.safeParse(input.signal);
  if (!signal.success || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return refuseHandoff('Invalid checkpoint signal or revision.');
  if (signal.data.kind === 'completed' && draft.plan.some(step => step.state !== 'done')) return refuseHandoff('Incomplete plan cannot be completed.');
  // Refuse any Git worktree as the runs root, even an ignored directory or a different repository.
  const root = realpathSync(input.runs);
  const inRepo = await promisify(execFile)('git', ['-C', root, 'rev-parse', '--show-toplevel'], { timeout: 5000 })
    .then(() => true, (error: { code?: unknown }) => {
      if (error.code === 128) return false;
      return refuseHandoff('Cannot verify external runs directory.');
    });
  if (inRepo) return refuseHandoff('Handoffs must live outside repositories.');
  let dir: string;
  try { dir = directory(root, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; dir = directory(root); }
  const repoState = await handoffRepoState(input.worktree);
  const lock = acquireLocalStoreLock(join(dir, `${draft.job}.lock`), 0, { anchorPath: dir, exactPrivateStorage: true });
  if (!lock) return refuseHandoff('Checkpoint writer busy or unavailable.');
  try {
    input.beforeWrite?.();
    const old = journal(dir, draft.job), previous = old.records.at(-1);
    if (old.records.length !== input.expectedRevision || (previous &&
      (previous.attempt !== draft.attempt || previous.repo !== draft.repo || previous.goal !== draft.goal ||
       !previous.needs.every(need => draft.needs.includes(need)) ||
       handoffTier.options.indexOf(draft.minTier) < handoffTier.options.indexOf(previous.minTier) || previous.signal.kind === 'completed'))) {
      return refuseHandoff('Checkpoint revision, attempt or repository conflict.');
    }
    const record = parseHandoff({ ...draft, schema: 'session-handoff.v1', revision: input.expectedRevision + 1,
      at: new Date().toISOString(), signal: signal.data, repoState });
    const text = old.text + JSON.stringify(record) + '\n';
    if (Buffer.byteLength(text) > HANDOFF_LOG_BYTES) return refuseHandoff('Handoff journal full.');
    const path = join(dir, `${draft.job}.jsonl`);
    writePrivateFileAtomically(`${path}.${randomUUID()}.tmp`, path, text, { anchorPath: dir, label: 'Handoff' });
    return record;
  } finally { releaseLocalStoreLock(lock); }
}

export interface ResumeOptions {
  runs: string; worktree: string; job: string; attempt: string; repo: string;
  lane: string; model: string; tier: HandoffDraft['minTier']; owner: string; capabilities: string[]; claimsRoot?: string;
}

/** Read-only contract. A plan is not a claim, execution permission, restored files or proof of model quality. */
export async function planSessionResume(options: ResumeOptions) {
  const record = readSessionHandoff(options.runs, options.job);
  if (record.attempt !== options.attempt || record.repo !== options.repo || record.signal.kind === 'completed') return refuseHandoff('Wrong attempt, repository or completed job.');
  if (![options.lane, options.owner].every(v => handoffId.safeParse(v).success) || !handoffModel.safeParse(options.model).success ||
      !handoffTier.safeParse(options.tier).success || handoffTier.options.indexOf(options.tier) < handoffTier.options.indexOf(record.minTier) ||
      !record.needs.every(need => options.capabilities.includes(need))) return refuseHandoff('Resume agent lacks required capabilities.');
  const age = Date.now() - Date.parse(record.at);
  if (age < 0 || age > 24 * 60 * 60 * 1000) return refuseHandoff('Checkpoint expired or clock moved backwards.');
  const current = await handoffRepoState(options.worktree);
  if (JSON.stringify(current) !== JSON.stringify(record.repoState)) return refuseHandoff('Repository changed; reconcile and checkpoint before resuming.');
  return { advisory: true as const, record, packet: join(directory(options.runs), `${record.job}.jsonl`),
    nextAction: record.nextAction, claimKeys: [`queue:${record.job}`, `repo:${record.repo.toLowerCase()}`],
    target: { lane: options.lane, model: options.model, tier: options.tier } };
}

export interface HandoffCandidate {
  lane: string; model: string; tier: HandoffDraft['minTier']; capabilities: string[];
  available: boolean; remainingFraction: number | null;
}

/** Trusted enrollment/usage snapshots only. Unknown capacity stays pending; no silent tier downgrade. */
export async function planSessionFailover(options: ResumeOptions, candidates: HandoffCandidate[]) {
  const record = readSessionHandoff(options.runs, options.job);
  if (!handoffPressure(record.signal)) return refuseHandoff('Latest checkpoint does not request failover.');
  if (!Array.isArray(candidates) || candidates.length > 32) return refuseHandoff('Invalid failover candidates.');
  for (const candidate of candidates) {
    if (candidate.lane === record.lane || candidate.available !== true ||
      typeof candidate.remainingFraction !== 'number' || !Number.isFinite(candidate.remainingFraction) ||
      candidate.remainingFraction <= 0 || candidate.remainingFraction > 1 ||
      !handoffTier.safeParse(candidate.tier).success || handoffTier.options.indexOf(candidate.tier) < handoffTier.options.indexOf(record.minTier) ||
      !Array.isArray(candidate.capabilities) || !record.needs.every(need => candidate.capabilities.includes(need))) continue;
    const resume = { ...options, lane: candidate.lane, model: candidate.model, tier: candidate.tier, capabilities: candidate.capabilities };
    const plan = await planSessionResume(resume);
    return { advisory: true as const, status: 'ready' as const, plan, resume };
  }
  return { advisory: true as const, status: 'pending' as const, reason: 'No capable lane with measured capacity.' };
}

class YieldSession extends Error { constructor(readonly record: SessionHandoff) { super('Checkpointed for failover.'); } }

/** Explicit harness integration. Checkpoint at every safe boundary and before exiting on provider pressure.
 * The callback owns provider execution. This function never invokes a model, shell action or dispatcher.
 */
export async function runSessionTurn<T>(options: ResumeOptions, work: (context: {
  record: SessionHandoff; assertLease: () => void; signal: AbortSignal;
  checkpoint: (draft: HandoffDraft, signal?: HandoffSignal) => Promise<SessionHandoff>;
}) => Promise<T>): Promise<{ status: 'completed'; value: T } | { status: 'handoff'; record: SessionHandoff }> {
  const plan = await planSessionResume(options);
  const leases: { key: string; token: string }[] = [];
  const leaseMs = 60_000;
  let revision = plan.record.revision, completed = false;
  const controller = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const assertLease = () => {
    if (controller.signal.aborted) refuseHandoff('Session claim lost; stop work.');
    for (const lease of leases) {
      if (renewCoordination({ root: options.claimsRoot, ...lease, leaseUntil: Date.now() + leaseMs }).status !== 'renewed') {
        refuseHandoff('Session claim lost; stop work.');
      }
    }
  };
  try {
    for (const key of plan.claimKeys) {
      const now = Date.now();
      const result = acquireCoordination({ root: options.claimsRoot, origin: 'resource', key, owner: options.owner,
        leaseMs, leaseUntil: now + leaseMs, sourceId: randomUUID(), now });
      if (result.status !== 'acquired' || !result.token) return refuseHandoff('Session claim conflict or unavailable.');
      leases.push({ key, token: result.token });
    }
    // Recheck after acquiring, including the journal revision: another turn may have finished while acquiring.
    if ((await planSessionResume(options)).record.revision !== revision) return refuseHandoff('Checkpoint changed during claim acquisition.');
    heartbeat = setInterval(() => { try { assertLease(); } catch { controller.abort(); } }, leaseMs / 3);
    heartbeat.unref();
    const value = await work({ record: plan.record, assertLease, signal: controller.signal, checkpoint: async (draft, signal = { kind: 'checkpoint' }) => {
      assertLease();
      if (draft.job !== options.job || draft.attempt !== options.attempt || draft.repo !== options.repo) return refuseHandoff('Turn identity changed.');
      const record = await checkpointSession({ ...options, expectedRevision: revision,
        draft: { ...draft, lane: options.lane, model: options.model }, signal, beforeWrite: assertLease });
      revision = record.revision;
      if (handoffPressure(signal)) throw new YieldSession(record);
      return record;
    } });
    assertLease();
    if (readSessionHandoff(options.runs, options.job).signal.kind !== 'completed') return refuseHandoff('Turn returned without a completion checkpoint.');
    completed = true;
    return { status: 'completed', value };
  } catch (error) {
    if (error instanceof YieldSession) return { status: 'handoff', record: error.record };
    throw error;
  } finally {
    clearInterval(heartbeat);
    for (const lease of leases.reverse()) settleCoordination({ root: options.claimsRoot, ...lease, outcome: completed ? 'completed' : 'released' });
  }
}
