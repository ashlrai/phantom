/** Read-only view of what the daily ideation loop did recently. Ids and flags only, never file contents. */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ideationConfig } from './ideation-loop.js';
import { readResearchFile } from './queue.js';

export type IdeationDayState = 'completed' | 'scheduled' | 'absent' | 'unknown';
export interface IdeationStatusRow {
  day: string; session: string; state: IdeationDayState; selected: string[]; archivedCount: number; strategyDoc: boolean;
}
export interface IdeationStatusReport {
  v: 1; authority: 'none'; asOf: string; stateDir: 'present' | 'missing' | 'unknown';
  rows: IdeationStatusRow[]; lastCompleted: string | null; streakMissing: number;
}

const MAX_DAYS = 30;
const ID = /^[\w.:-]{1,120}$/;
const REQUEST_MAX_BYTES = 16 * 1024 * 1024;
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const exists = (file: string) => stat(file).then(() => true, () => false);
// Missing is a state, not an error; anything else (including a parse failure) is unknown.
const readOptional = (file: string, maxBytes?: number) =>
  readResearchFile(file, maxBytes).then(s => ({ text: s as string | null }), (e: unknown) => code(e) === 'ENOENT' ? { text: null } : { text: undefined });

export async function readIdeationStatus(configFile: string, opts: { now?: Date; days?: number } = {}): Promise<IdeationStatusReport> {
  const config = ideationConfig.parse(JSON.parse(await readResearchFile(configFile)));
  const now = opts.now ?? new Date();
  const days = Math.min(MAX_DAYS, Math.max(1, Math.trunc(opts.days ?? 7)));
  const stateDir = await stat(config.state).then(s => s.isDirectory() ? 'present' as const : 'unknown' as const, e => code(e) === 'ENOENT' ? 'missing' as const : 'unknown' as const);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rows: IdeationStatusRow[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(today - i * 86_400_000).toISOString().slice(0, 10);
    const row: IdeationStatusRow = { day, session: `RQ-IDEATION-${day.replaceAll('-', '')}`, state: 'absent', selected: [], archivedCount: 0,
      strategyDoc: await exists(join(config.repoRoot, 'docs', 'strategy', `IDEATION-${day}.md`)) };
    if (stateDir === 'missing') { rows.push(row); continue; }
    if (stateDir === 'unknown') { row.state = 'unknown'; rows.push(row); continue; }
    const result = await readOptional(join(config.state, `${day}.result.json`));
    if (result.text === undefined) row.state = 'unknown';
    else if (result.text !== null) {
      try {
        const parsed = JSON.parse(result.text) as { ids?: unknown; archived?: unknown };
        if (!Array.isArray(parsed.ids) || !parsed.ids.every(id => typeof id === 'string' && ID.test(id))) throw new Error('bad ids');
        row.state = 'completed';
        row.selected = parsed.ids as string[];
        row.archivedCount = Array.isArray(parsed.archived) ? parsed.archived.length : 0;
      } catch { row.state = 'unknown'; }
    } else {
      const request = await readOptional(join(config.state, `${day}.request.json`), REQUEST_MAX_BYTES);
      if (request.text === undefined) row.state = 'unknown';
      else if (request.text !== null) {
        try { JSON.parse(request.text); row.state = 'scheduled'; } catch { row.state = 'unknown'; }
      }
    }
    rows.push(row);
  }
  const firstPresent = rows.findIndex(r => r.state !== 'absent');
  return { v: 1, authority: 'none', asOf: now.toISOString(), stateDir, rows,
    lastCompleted: rows.find(r => r.state === 'completed')?.day ?? null, streakMissing: firstPresent === -1 ? rows.length : firstPresent };
}
