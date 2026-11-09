import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubPrivateText } from '../util/scrub.js';

export interface LibraryFile {
  name: string;
  size: number;
  modifiedAt: string;
  preview: string;
}

// Read complete, bounded files before redaction: cutting a token at a byte
// boundary before scrubbing could expose a secret-shaped prefix.
const MAX_BYTES = 256 * 1024;
const MAX_DRAFTS = 200;

export async function listLeaderFiles(root = join(homedir(), '.ashlr-runs')): Promise<LibraryFile[]> {
  const leader = join(root, 'leader');
  try {
    if (!(await lstat(root)).isDirectory() || !(await lstat(leader)).isDirectory()) return [];
  } catch { return []; }
  const names = ['VISION.md', 'PLAN-LOG.md', 'INSPIRATION.md'];
  const drafts = join(leader, 'drafts');
  try {
    if ((await lstat(drafts)).isDirectory()) {
      const entries = await readdir(drafts, { withFileTypes: true });
      names.push(...entries.filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => `drafts/${entry.name}`).sort().slice(0, MAX_DRAFTS));
    }
  } catch { /* An absent drafts directory is normal. */ }
  const rows = await Promise.all(names.map(async name => {
    let file;
    try {
      file = await open(join(leader, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) return null;
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > MAX_BYTES) return null;
      const content = buffer.subarray(0, used).toString('utf8');
      return { name: scrubPrivateText(name), size: stat.size, modifiedAt: stat.mtime.toISOString(),
        preview: scrubPrivateText(content).replace(/\s+/g, ' ').trim().slice(0, 240) };
    } catch { return null; } finally { await file?.close(); }
  }));
  return rows.filter((row): row is LibraryFile => row !== null)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
}
