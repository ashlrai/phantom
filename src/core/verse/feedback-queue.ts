import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface FrictionFlag { description: string; surface: string }

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
export async function enqueueFrictionFlag(input: unknown, root = join(homedir(), '.ashlr', 'router')) {
  const flag = parseFrictionFlag(input);
  const entry = {
    v: 1, id: `RQ-DESKTOP-FRICTION-${randomUUID()}`, createdAt: new Date().toISOString(),
    repo: 'phantom', tier: 'work', lead: 'Adoption', flag: 'agentWorkspace',
    source: 'desktop-feedback', ...flag,
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = await open(join(root, 'feedback.jsonl'),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Queue must be a regular file');
    await file.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  return { id: entry.id };
}
