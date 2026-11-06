import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isQueueVisit, type QueueVisit } from './stats.js';

export const queueJournalPath = () => join(homedir(), '.ashlr', 'queue', 'visits.jsonl');

/** Record metadata only: reuse the visit id at each transition; retries need a new id. */
export async function recordQueueVisit(visit: QueueVisit, path = queueJournalPath()): Promise<void> {
  if (!isQueueVisit(visit)) throw new Error('Invalid queue visit');
  const { id, station, pool, arrivedAt, startedAt, completedAt } = visit;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify({ id, station, pool, arrivedAt, startedAt, completedAt }) + '\n', { mode: 0o600 });
}

export async function readQueueVisits(path = queueJournalPath()): Promise<QueueVisit[]> {
  let content: string;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Cannot read queue journal');
  }
  return content.split('\n').filter(line => line.trim()).map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid queue journal line ${index + 1}`); }
    if (!isQueueVisit(value)) throw new Error(`Invalid queue journal line ${index + 1}`);
    return value;
  });
}
