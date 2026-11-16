import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LEADER_ATTACHMENT_NAME_RE, MIME_BY_EXT, leaderAttachmentDir } from './leader-attachment-api.js';

export interface LeaderAttachment { name: string; bytes: number; type: string; modifiedAt: string }
export interface LeaderAttachmentList { state: 'ok' | 'absent' | 'unavailable'; items: LeaderAttachment[] }

export async function listLeaderAttachments({ limit = 24 }: { limit?: number } = {}): Promise<LeaderAttachmentList> {
  const dir = leaderAttachmentDir();
  try {
    const dirStat = await lstat(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { state: 'unavailable', items: [] };
    const names = await readdir(dir);
    const items: LeaderAttachment[] = [];
    for (const name of names) {
      const match = LEADER_ATTACHMENT_NAME_RE.exec(name);
      if (!match) continue;
      try {
        const st = await lstat(join(dir, name));
        if (st.isFile() && !st.isSymbolicLink()) items.push({ name, bytes: st.size,
          type: MIME_BY_EXT[match[1] as keyof typeof MIME_BY_EXT], modifiedAt: st.mtime.toISOString() });
      } catch { /* A file may disappear while listing. */ }
    }
    items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.floor(limit))) : 24;
    return { state: 'ok', items: items.slice(0, count) };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable', items: [] };
  }
}
