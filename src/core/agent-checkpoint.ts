import { readFile, open, realpath, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { assertMetadata } from './connectors/profile.js';

/** A complete, explicitly authored handoff; arrays may be empty when there is nothing to record. */
export interface AgentCheckpoint {
  version: 1;
  goal: string;
  done: string[];
  next: string[];
  evidence: string[];
  openQuestions: string[];
  /** Present on checkpoints written by save; absent (unverifiable) on hand-authored or older files. */
  freshness?: CheckpointFreshness;
}

/** Machine-checkable snapshot of the world the checkpoint was written against. */
export interface CheckpointFreshness {
  savedAt: string;
  worktreeHead: string;
  /** sha256 of the porcelain status, excluding the checkpoint file itself. */
  worktreeStatusDigest: string;
}

export interface CheckpointFreshnessVerdict {
  state: 'fresh' | 'stale' | 'unverifiable';
  reasons: string[];
}

/** A checkpoint older than this is treated as stale even if the worktree is unchanged. */
export const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class AgentCheckpointError extends Error {}

function validFreshness(value: unknown): value is CheckpointFreshness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  return Object.keys(f).length === 3 && typeof f.savedAt === 'string' && Number.isFinite(Date.parse(f.savedAt))
    && typeof f.worktreeHead === 'string' && /^[0-9a-f]{40,64}$/.test(f.worktreeHead)
    && typeof f.worktreeStatusDigest === 'string' && /^[0-9a-f]{64}$/.test(f.worktreeStatusDigest);
}

/** Validate without changing, truncating, or silently discarding any checkpoint field. */
export function parseAgentCheckpoint(raw: string): AgentCheckpoint {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AgentCheckpointError('Checkpoint is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentCheckpointError('Checkpoint must be an object.');
  const record = value as Record<string, unknown>;
  const keys = ['version', 'goal', 'done', 'next', 'evidence', 'openQuestions'];
  const extra = Object.keys(record).filter(key => !keys.includes(key));
  if (keys.some(key => !Object.hasOwn(record, key)) || extra.some(key => key !== 'freshness')) {
    throw new AgentCheckpointError('Checkpoint must contain exactly version, goal, done, next, evidence and openQuestions (plus optional freshness).');
  }
  if (Object.hasOwn(record, 'freshness') && !validFreshness(record.freshness)) {
    throw new AgentCheckpointError('freshness must hold savedAt, worktreeHead and worktreeStatusDigest.');
  }
  if (record.version !== 1 || typeof record.goal !== 'string' || !record.goal.trim()) {
    throw new AgentCheckpointError('Checkpoint requires version 1 and a nonempty goal.');
  }
  for (const key of keys.slice(2)) {
    const items = record[key];
    if (!Array.isArray(items) || items.some(item => typeof item !== 'string' || !item.trim())) {
      throw new AgentCheckpointError(`${key} must be an array of nonempty strings.`);
    }
  }
  // freshness is shape-validated hex/ISO only; its 64-hex digest would trip the secret scrubber.
  const { freshness: _freshness, ...scanned } = record;
  try { assertMetadata(JSON.stringify(scanned)); } catch { throw new AgentCheckpointError('Secret-shaped checkpoint refused; use secret references only.'); }
  return value as AgentCheckpoint;
}

/** Read the caller-selected durable artifact; never infer a checkpoint from a transcript. */
export async function readAgentCheckpoint(path: string): Promise<AgentCheckpoint> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch { throw new AgentCheckpointError('Cannot read checkpoint file.'); }
  return parseAgentCheckpoint(raw);
}

const git = promisify(execFile);

/** HEAD plus a digest of the working-tree inventory, ignoring `ignore` (the checkpoint file itself). */
async function inspectWorktree(worktree: string, ignore?: string): Promise<{ head: string; status: string; digest: string }> {
  try {
    const run = async (...args: string[]) => (await git('git', ['-C', worktree, ...args], { maxBuffer: 1024 * 1024 })).stdout;
    const head = (await run('rev-parse', '--verify', 'HEAD')).trim();
    const status = await run('status', '--porcelain=v1', '-z', '--untracked-files=all');
    let skip: string | undefined;
    // Compare real paths: the destination may not exist yet, so resolve its directory (symlinked tmp dirs).
    if (ignore) skip = relative((await run('rev-parse', '--show-toplevel')).trim(), join(await realpath(dirname(resolve(ignore))), basename(ignore)));
    const entries = status.split('\0').filter(entry => entry && !(skip && entry.slice(3) === skip));
    return { head, status, digest: createHash('sha256').update(entries.join('\0')).digest('hex') };
  } catch { throw new AgentCheckpointError('Cannot inspect worktree.'); }
}

/**
 * Compare a saved checkpoint with the worktree as it is now. Anything but `fresh` means the recorded
 * done/next/evidence may describe state that no longer exists; re-verify before acting on it.
 */
export async function assessAgentCheckpointFreshness(checkpoint: AgentCheckpoint, worktree: string, options: {
  checkpointPath?: string; now?: Date; maxAgeMs?: number } = {}): Promise<CheckpointFreshnessVerdict> {
  const saved = checkpoint.freshness;
  if (!saved) return { state: 'unverifiable', reasons: ['Checkpoint carries no freshness metadata; re-verify against the worktree.'] };
  const reasons: string[] = [];
  const now = (options.now ?? new Date()).getTime();
  const age = now - Date.parse(saved.savedAt);
  if (age < 0) reasons.push('Checkpoint is dated in the future; clock or provenance is untrustworthy.');
  else if (age > (options.maxAgeMs ?? CHECKPOINT_MAX_AGE_MS)) reasons.push(`Checkpoint is ${Math.floor(age / 3_600_000)}h old.`);
  const current = await inspectWorktree(worktree, options.checkpointPath);
  if (current.head !== saved.worktreeHead) reasons.push(`Worktree HEAD moved from ${saved.worktreeHead} to ${current.head}.`);
  if (current.digest !== saved.worktreeStatusDigest) reasons.push('Worktree changes differ from those present when the checkpoint was saved.');
  return { state: reasons.length ? 'stale' : 'fresh', reasons };
}

/** Save an authored handoff and the current worktree inventory without changing Git state. */
export async function saveAgentCheckpoint(source: string, destination: string, worktree: string, now = new Date()): Promise<AgentCheckpoint> {
  const authored = await readAgentCheckpoint(source);
  const { head, status, digest } = await inspectWorktree(worktree, destination);
  const checkpoint = parseAgentCheckpoint(JSON.stringify({ ...authored, evidence: [
    ...authored.evidence, `Worktree HEAD: ${head}`, `Worktree status (porcelain v1, NUL separated): ${JSON.stringify(status)}`,
  ], freshness: { savedAt: now.toISOString(), worktreeHead: head, worktreeStatusDigest: digest } }));
  const temporary = join(dirname(destination), `.checkpoint-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, destination);
  } catch {
    await unlink(temporary).catch(() => {});
    throw new AgentCheckpointError('Cannot save checkpoint.');
  }
  return checkpoint;
}
