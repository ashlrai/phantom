/** Bounded, symlink-safe reads of the bridge's memory files for core and cli. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export interface FleetMemoryFiles {
  memstat: unknown;
  memguard: unknown;
}

/** Each file degrades independently: missing, non-regular or unparseable JSON is null. */
async function readJsonFile(path: string): Promise<unknown> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const limit = 1024 * 1024;
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) return null;
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) return null;
    try { return JSON.parse(buffer.subarray(0, offset).toString('utf8')) as unknown; } catch { return null; }
  } finally { await file.close(); }
}

export async function readFleetMemoryFiles(root: string): Promise<FleetMemoryFiles> {
  const [memstat, memguard] = await Promise.all([
    readJsonFile(join(root, 'memstat.json')),
    readJsonFile(join(root, '.memguard2.json')),
  ]);
  return { memstat, memguard };
}
