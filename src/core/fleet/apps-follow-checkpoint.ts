import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function readFollowCheckpoint(path: string, invocationId: string | undefined): number {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new Error('checkpoint read failed');
  }
  let record: unknown;
  try { record = JSON.parse(text); } catch { throw new Error('invalid checkpoint'); }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid checkpoint');
  const value = record as Record<string, unknown>;
  if (value.version !== 1 || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0 ||
    !Object.hasOwn(value, 'invocationId') || value.invocationId !== (invocationId ?? null)) throw new Error('invalid checkpoint');
  return value.cursor as number;
}

export function writeFollowCheckpoint(path: string, cursor: number, invocationId: string | undefined): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    created = true;
    try { writeFileSync(fd, JSON.stringify({ version: 1, cursor, invocationId: invocationId ?? null }) + '\n'); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally {
    if (created) { try { unlinkSync(temporary); } catch { /* Renamed or best-effort cleanup. */ } }
  }
}
