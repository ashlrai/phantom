import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { redactHomePaths, scrubPrivateText } from '../util/scrub.js';

export const VERSE_OPS_LEADER_JOURNAL_PATH = '/api/verse/ops/leader-journal';
export interface JournalSection { title: string; bullets: string[] }
export interface LeaderNote { at: string; bullets: string[] }
export interface JournalPass { at: string; sections: JournalSection[] }
export interface DropIngestRow { verb: string; file: string; reason: string | null }
export interface DropIngestedRow { at: string; id: string; leader: string; lane: string; tier: string; title: string }
export interface LeaderJournalV1 {
  v: 1; generatedAt: string;
  sources: Record<'planLog' | 'ingestLog' | 'ingested' | 'orchestration', 'healthy' | 'missing' | 'degraded'>;
  notes: LeaderNote[];
  passes: JournalPass[]; ingest: DropIngestRow[]; ingested: DropIngestedRow[];
  rejectedLastHour: number | null;
}

const TAIL_BYTES = 256 * 1024;
const SENSITIVE = /token|secret|api[_-]?key|authorization|bearer/i;
const limitTo = (n: number, max: number) => Number.isFinite(n) ? Math.min(max, Math.max(0, Math.floor(n))) : 0;
function clean(text: string, max: number): string {
  return redactHomePaths(scrubPrivateText(text)).replace(/\p{Cc}/gu, ' ').slice(0, max);
}
function safeLine(line: string): string { return SENSITIVE.test(line) ? '[redacted line]' : line; }

export function parsePlanLog(markdown: string, limit = 8): JournalPass[] {
  const passes: JournalPass[] = [];
  let pass: JournalPass | undefined;
  let section: JournalSection | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      pass = { at: clean(safeLine(heading[1]), 80), sections: [] };
      passes.push(pass);
      section = undefined;
      continue;
    }
    const title = /^\s*\*\*(.+?)\*\*\s*$/.exec(line);
    if (title && pass) {
      section = pass.sections.length < 32 ? { title: clean(safeLine(title[1]), 80), bullets: [] } : undefined;
      if (section) pass.sections.push(section);
      continue;
    }
    const bullet = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (bullet && section && section.bullets.length < 12) section.bullets.push(clean(safeLine(bullet[1]), 300));
  }
  return passes.reverse().slice(0, limitTo(limit, 8));
}

export function parseLeaderNotes(markdown: string, limit = 12): LeaderNote[] {
  const notes: LeaderNote[] = [];
  let note: LeaderNote | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const heading = /^## Leader notes, (.+?)(?: \(.*)?$/.exec(line);
      note = heading ? { at: clean(safeLine(heading[1].trim()), 80), bullets: [] } : undefined;
      if (note) notes.push(note);
    } else if (note && line.startsWith('- ')) {
      note.bullets.push(clean(safeLine(line.slice(2).trim()), 400));
    }
  }
  return notes.reverse().slice(0, limitTo(limit, 12));
}

// Accept timestamps only as a prefix, so a timestamp in a reason cannot change the count.
function ingestParts(line: string): { at: number | null; body: string } {
  const match = /^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\]?\s+(.+)$/.exec(line);
  if (!match) return { at: null, body: line };
  const at = Date.parse(match[1]);
  return { at: Number.isFinite(at) ? at : null, body: match[2] };
}
export function parseIngestLog(text: string, limit = 30): DropIngestRow[] {
  return text.split(/\r?\n/).filter(Boolean).slice(-30).reverse().flatMap(line => {
    const safe = safeLine(line);
    if (safe === '[redacted line]') return [{ verb: clean(safe, 80), file: '', reason: null }];
    const match = /^(\S+)\s+(\S+)(?:\s+(.+))?$/.exec(ingestParts(safe).body.trim());
    return match ? [{ verb: clean(match[1], 80), file: clean(match[2], 300), reason: match[3] ? clean(match[3], 300) : null }] : [];
  }).slice(0, limitTo(limit, 30));
}
export function parseIngestedTsv(text: string, limit = 30): DropIngestedRow[] {
  return text.split(/\r?\n/).filter(Boolean).slice(-30).reverse().flatMap(line => {
    const fields = line.split('\t');
    if (fields.length !== 6) return [];
    if (SENSITIVE.test(line)) fields.splice(0, 6, '[redacted line]', '', '', '', '', '');
    const [at, id, leader, lane, tier, title] = fields.map(value => clean(value, 300));
    return [{ at, id, leader, lane, tier, title }];
  }).slice(0, limitTo(limit, 30));
}

async function directory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error('invalid directory');
}
async function readTail(path: string): Promise<{ text: string; truncated: boolean }> {
  if (!(await lstat(path)).isFile()) throw new Error('invalid source');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('invalid source');
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, start + used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const text = buffer.subarray(0, used).toString('utf8');
    return { text: start ? text.slice(text.indexOf('\n') + 1 || text.length) : text, truncated: start > 0 };
  } finally { await file.close(); }
}
export async function readLeaderJournal(opts: { runsDir?: string; now?: () => number } = {}): Promise<LeaderJournalV1> {
  let now = Date.now();
  try { const value = (opts.now ?? Date.now)(); if (Number.isFinite(value) && Math.abs(value) <= 8.64e15) now = value; } catch { /* use the system clock */ }
  const state: LeaderJournalV1 = { v: 1, generatedAt: new Date(now).toISOString(),
    sources: { orchestration: 'missing', planLog: 'missing', ingestLog: 'missing', ingested: 'missing' },
    notes: [], passes: [], ingest: [], ingested: [], rejectedLastHour: null };
  const root = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const leader = join(root, 'leader');
  const drop = join(leader, 'drop');
  async function source(key: keyof LeaderJournalV1['sources'], path: string, dirs: string[], consume: (text: string, truncated: boolean) => void): Promise<void> {
    try {
      if (!isAbsolute(root)) throw new Error('invalid runs directory');
      for (const dir of dirs) await directory(dir);
      const result = await readTail(path);
      consume(result.text, result.truncated);
      state.sources[key] = 'healthy';
    } catch (error) { state.sources[key] = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'degraded'; }
  }
  await Promise.all([
    source('orchestration', join(leader, 'ORCHESTRATION.md'), [root, leader], text => { state.notes = parseLeaderNotes(text); }),
    source('planLog', join(leader, 'PLAN-LOG.md'), [root, leader], text => { state.passes = parsePlanLog(text); }),
    source('ingestLog', join(drop, 'ingest.log'), [root, leader, drop], (text, truncated) => {
      state.ingest = parseIngestLog(text);
      let found = false; let count = 0;
      for (const line of text.split(/\r?\n/)) {
        const { at, body } = ingestParts(line);
        if (at === null) continue;
        found = true;
        if (at <= now && at >= now - 3600000 && /^reject(?:\s|$)/i.test(body)) count++;
      }
      state.rejectedLastHour = found && !truncated ? count : null;
    }),
    source('ingested', join(drop, 'ingested.tsv'), [root, leader, drop], text => { state.ingested = parseIngestedTsv(text); }),
  ]);
  return state;
}
