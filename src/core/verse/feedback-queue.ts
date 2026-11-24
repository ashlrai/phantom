import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface FrictionFlag { description: string; surface: string }

/**
 * The directory the writer appends `feedback.jsonl` under when no root
 * override is given — `~/.ashlr/router`, resolved per call through
 * `homedir()` like the writer so a relocated HOME is honoured. The path is
 * deliberately not `$ASHLR_HOME`-relative: the console endpoint and any
 * reader must agree on the one file the flag button writes.
 */
export function frictionFeedbackDir(): string {
  return join(homedir(), '.ashlr', 'router');
}

/** The journal path inside a queue directory (default: the writer's own). */
export function frictionFeedbackPath(dir: string = frictionFeedbackDir()): string {
  return join(dir, 'feedback.jsonl');
}

/** Strict, bounded data contract; callers cannot choose routing or a file path. */
export function parseFrictionFlag(value: unknown): FrictionFlag {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid flag');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'description' && key !== 'surface')
    || typeof record.description !== 'string' || !record.description.trim()
    || record.description.length > 2000 || typeof record.surface !== 'string'
    || !/^[a-z][a-z0-9-]{0,63}$/.test(record.surface)) throw new Error('Invalid flag');
  return { description: record.description.trim(), surface: record.surface };
}

/** One private JSONL append; no subprocess, interpolation, or dispatch capability. */
export async function enqueueFrictionFlag(input: unknown, root = frictionFeedbackDir()) {
  const flag = parseFrictionFlag(input);
  const entry = {
    v: 1, id: `RQ-DESKTOP-FRICTION-${randomUUID()}`, createdAt: new Date().toISOString(),
    repo: 'phantom', tier: 'work', lead: 'Adoption', flag: 'agentWorkspace',
    source: 'desktop-feedback', ...flag,
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = await open(frictionFeedbackPath(root),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Queue must be a regular file');
    await file.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  return { id: entry.id };
}
