import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';

export interface IngestedRow { at: string; id: string; pass: string; lane: string; tier: string; title: string }
export interface DropJobFate {
  id: string; fate: 'ingested' | 'rejected'; at: string; lane: string | null; tier: string | null;
  reason: string | null; ageSeconds: number; queued: boolean;
}
export interface DropJobFatesV1 {
  v: 1; generatedAt: string; sourceState: 'healthy' | 'missing' | 'degraded'; fates: DropJobFate[];
}
export function parseIngestedTsv(text: string): IngestedRow[] {
  return text.split('\n').flatMap(line => {
    const [at, fullId, pass = '', lane = '', tier = '', ...title] = line.replace(/\r$/, '').split('\t');
    const id = /^RQ-PHX-([A-Z0-9]{3,40})$/.exec(fullId ?? '')?.[1];
    if (!id || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at ?? '') || !Number.isFinite(Date.parse(at!.replace(' ', 'T')))) return [];
    return [{ at: at!, id: fullId!, pass, lane, tier, title: title.join('\t') }];
  });
}
export function parseDoneName(fileName: string): { id: string; reason: string } | null {
  const match = /^RQ-PHX-([A-Z0-9]{3,40})\.md\.(.+)$/.exec(fileName);
  if (!match || /[\\/]/.test(fileName) || fileName.includes('\0')) return null;
  return { id: match[1]!, reason: match[2]! };
}

/** Refuse symlink components: no source, including queue evidence, may escape the root. */
async function safeStat(root: string, path: string) {
  let cursor = root;
  let result = await lstat(root);
  if (result.isSymbolicLink()) throw new Error('symlink root');
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    result = await lstat(cursor);
    if (result.isSymbolicLink()) throw new Error('symlink source');
  }
  return result;
}
export async function readDropJobFates({ runsRoot, limit = 20, now = Date.now }: {
  runsRoot?: string; limit?: number; now?: () => number;
} = {}): Promise<DropJobFatesV1> {
  const nowMs = now();
  const result: DropJobFatesV1 = { v: 1, generatedAt: new Date(nowMs).toISOString(), sourceState: 'missing', fates: [] };
  const root = resolve(runsRoot ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'));
  let found = false;
  let degraded = false;
  const failure = (error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') degraded = true; };
  const add = (id: string, fate: DropJobFate['fate'], at: string, lane: string | null, tier: string | null, reason: string | null) => {
    result.fates.push({ id, fate, at, lane, tier, reason, ageSeconds: Math.max(0, Math.floor((nowMs - Date.parse(at)) / 1000)), queued: false });
  };
  try {
    const path = join(root, 'leader/drop/ingested.tsv');
    const stat = await safeStat(root, path);
    if (!stat.isFile()) throw new Error('not a file');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const start = Math.max(0, stat.size - 65536);
      const buffer = Buffer.alloc(Math.min(stat.size, 65536));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) { const newline = text.indexOf('\n'); text = newline < 0 ? '' : text.slice(newline + 1); }
      for (const row of parseIngestedTsv(text)) add(row.id.slice('RQ-PHX-'.length), 'ingested', new Date(row.at.replace(' ', 'T')).toISOString(), row.lane || null, row.tier || null, null);
      found = true;
    } finally { await handle.close(); }
  } catch (error) { failure(error); }
  try {
    const dir = join(root, 'leader/drop/done');
    await safeStat(root, dir);
    const names = await readdir(dir);
    found = true;
    for (const name of names) {
      const parsed = parseDoneName(name);
      if (!parsed) continue;
      try {
        const stat = await safeStat(root, join(dir, name));
        if (stat.isFile()) add(parsed.id, 'rejected', stat.mtime.toISOString(), null, null, parsed.reason);
      } catch (error) { failure(error); }
    }
  } catch (error) { failure(error); }
  result.fates.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  result.fates = result.fates.slice(0, Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20);
  for (const fate of result.fates) {
    try { fate.queued = (await safeStat(root, join(root, 'queue/prompts', `RQ-PHX-${fate.id}.md`))).isFile(); }
    catch (error) { failure(error); }
  }
  result.sourceState = degraded ? 'degraded' : found ? 'healthy' : 'missing';
  return result;
}
