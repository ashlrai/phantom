/** Shared research/ideation transaction: re-read, plan and append under one lock. */
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function readResearchFile(path: string, maxBytes = 1024 * 1024): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid research file');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('research file changed');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead));
  } finally { await file.close(); }
}

export async function writeResearchFile(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(text); await file.sync(); await file.close(); await rename(temp, path);
  } finally { await file.close().catch(() => undefined); await unlink(temp).catch(() => undefined); }
}

export async function researchQueueTransaction<T>(path: string, plan: (queue: string) => Promise<{ lines: string[]; result: T }>): Promise<T> {
  const lockPath = `${path}.research-digest.lock`;
  const lock = await open(lockPath, 'wx', 0o600); // Never steal a busy or crashed writer's lock.
  const token = randomUUID();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token }));
    const queue = await readResearchFile(path); // Missing/unreadable is not an empty queue.
    const { lines, result } = await plan(queue);
    if (lines.length) {
      const updated = `${queue}${queue.endsWith('\n') ? '' : '\n'}${lines.join('\n')}\n`;
      if (Buffer.byteLength(updated) > 1024 * 1024) throw new Error('queue size limit');
      await writeResearchFile(path, updated);
    }
    return result;
  } finally {
    await lock.close();
    const held = await readResearchFile(lockPath).catch(() => null);
    if (held?.includes(token)) await unlink(lockPath);
  }
}
