import { readFile, open, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { assertMetadata } from './connectors/profile.js';

/** A complete, explicitly authored handoff; arrays may be empty when there is nothing to record. */
export interface AgentCheckpoint {
  version: 1;
  goal: string;
  done: string[];
  next: string[];
  evidence: string[];
  openQuestions: string[];
}

export class AgentCheckpointError extends Error {}

/** Validate without changing, truncating, or silently discarding any checkpoint field. */
export function parseAgentCheckpoint(raw: string): AgentCheckpoint {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AgentCheckpointError('Checkpoint is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentCheckpointError('Checkpoint must be an object.');
  const record = value as Record<string, unknown>;
  const keys = ['version', 'goal', 'done', 'next', 'evidence', 'openQuestions'];
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    throw new AgentCheckpointError('Checkpoint must contain exactly version, goal, done, next, evidence and openQuestions.');
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
  try { assertMetadata(raw); } catch { throw new AgentCheckpointError('Secret-shaped checkpoint refused; use secret references only.'); }
  return value as AgentCheckpoint;
}

/** Read the caller-selected durable artifact; never infer a checkpoint from a transcript. */
export async function readAgentCheckpoint(path: string): Promise<AgentCheckpoint> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch { throw new AgentCheckpointError('Cannot read checkpoint file.'); }
  return parseAgentCheckpoint(raw);
}

/** Save an authored handoff and the current worktree inventory without changing Git state. */
export async function saveAgentCheckpoint(source: string, destination: string, worktree: string): Promise<AgentCheckpoint> {
  const authored = await readAgentCheckpoint(source);
  const git = promisify(execFile);
  let head: string, status: string;
  try {
    head = (await git('git', ['-C', worktree, 'rev-parse', '--verify', 'HEAD'], { maxBuffer: 1024 * 1024 })).stdout.trim();
    status = (await git('git', ['-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBuffer: 1024 * 1024 })).stdout;
  } catch { throw new AgentCheckpointError('Cannot inspect worktree.'); }
  const checkpoint = parseAgentCheckpoint(JSON.stringify({ ...authored, evidence: [
    ...authored.evidence, `Worktree HEAD: ${head}`, `Worktree status (porcelain v1, NUL separated): ${JSON.stringify(status)}`,
  ] }));
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
