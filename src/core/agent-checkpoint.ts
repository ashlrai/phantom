import { readFile } from 'node:fs/promises';
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
