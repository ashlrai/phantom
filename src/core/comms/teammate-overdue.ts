import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTeammateTexts, type TeammateText } from './imessage-teammate-inbox.js';
import { emptyOwnerSettings } from './owner-channel.js';
import { postOwnerThreadNotice } from './owner-thread.js';

/** The inbox reader supplies pending texts with answered markers already removed. */
export function findOverdueTeammateTexts(pending: readonly TeammateText[], opts: { now: number; thresholdMs?: number }): TeammateText[] {
  return pending.filter(t => opts.now - Date.parse(t.at) > (opts.thresholdMs ?? 5 * 60_000))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.rowid - b.rowid);
}

export async function noticeOverdueTeammateTexts(opts: { runsDir: string; now?: () => number; apply?: boolean }): Promise<{ state: 'ok' | 'unavailable'; raised: number; skipped: number }> {
  let raised = 0, skipped = 0;
  try {
    const now = (opts.now ?? Date.now)();
    const inbox = readTeammateTexts({ runsDir: opts.runsDir, now: () => now });
    if (inbox.sourceState !== 'healthy') return { state: 'unavailable', raised, skipped };
    const path = join(opts.runsDir, 'queue', 'teammate-overdue-seen.json');
    let ids: number[] = [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(parsed) || !parsed.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('invalid seen file');
      ids = parsed.slice(-500) as number[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const text of findOverdueTeammateTexts(inbox.texts, { now })) {
      if (ids.includes(text.rowid) || !opts.apply) { skipped++; continue; }
      const excerpt = text.text.slice(0, 80).replace(/[\r\n\t]+/g, ' ');
      const result = await postOwnerThreadNotice(`Teammate texted ${Math.floor((now - Date.parse(text.at)) / 60_000)} min ago, no reply yet: ${excerpt}`, `teammate-overdue-${text.rowid}`, {
        runsDir: opts.runsDir, now: () => now, settings: emptyOwnerSettings(),
      });
      if (result.status !== 'accepted' && result.status !== 'duplicate') return { state: 'unavailable', raised, skipped };
      ids = [...ids, text.rowid].slice(-500);
      mkdirSync(join(opts.runsDir, 'queue'), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${randomUUID()}.tmp`;
      try { writeFileSync(tmp, JSON.stringify(ids), { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
      finally { try { unlinkSync(tmp); } catch { /* already renamed */ } }
      if (result.status === 'accepted') raised++; else skipped++;
    }
    return { state: 'ok', raised, skipped };
  } catch { return { state: 'unavailable', raised, skipped }; }
}
