import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { acquireCoordination, renewCoordination, settleCoordination } from './claim-store.js';
import { handoffRepoState } from './session-handoff-repo.js';
import { handoffDir, readHandoffJournal, readSessionHandoff, listSessionHandoffs } from './session-handoff-read.js';
import { HANDOFF_LOG_BYTES, handoffId, handoffModel, handoffTier, handoffPressure, handoffSignalSchema, parseHandoff, refuseHandoff,
  scrubHandoffDraft, type HandoffDraft, type HandoffSignal, type SessionHandoff } from './session-handoff-schema.js';

// The read-only accessors live in session-handoff-read.ts so read surfaces can
// use them without this file's write/plan imports; re-exported here so every
// existing `session-handoff.js` importer keeps working unchanged.
export { readSessionHandoff, listSessionHandoffs };
export type { SessionHandoffList, SessionHandoffListEntry } from './session-handoff-read.js';

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
  try { dir = handoffDir(root, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; dir = handoffDir(root); }
  const repoState = await handoffRepoState(input.worktree);
  const lock = acquireLocalStoreLock(join(dir, `${draft.job}.lock`), 0, { anchorPath: dir, exactPrivateStorage: true });
  if (!lock) return refuseHandoff('Checkpoint writer busy or unavailable.');
  try {
    input.beforeWrite?.();
    const old = readHandoffJournal(dir, draft.job), previous = old.records.at(-1);
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
  return { advisory: true as const, record, packet: join(handoffDir(options.runs), `${record.job}.jsonl`),
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
