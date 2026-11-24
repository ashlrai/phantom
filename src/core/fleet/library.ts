/** One read-only projection for the Library CLI and desktop. Source readers retain their own bounds. */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { listMemory } from '../cos/memory.js';
import { scrubPrivateText } from '../util/scrub.js';
import { listLeaderAttachments } from '../verse/leader-attachment-list.js';
import { BUS_INBOX_MAX_MESSAGES, listBusInboxAfter } from './bus-inbox.js';
import { readHandoffFiles } from './handoff-files.js';
import { listLeaderFiles } from './library-files.js';
import { loadSpecialistRoster, readSpecialistFile } from './roster.js';
export const LIBRARY_KINDS = ['file', 'media', 'memory', 'message', 'context'] as const;
export type LibraryKind = typeof LIBRARY_KINDS[number];
/** Wire version shared by `phm library --json`, `phm library show --json` and the desktop API. Fields only ever get added. */
export const LIBRARY_SCHEMA_VERSION = 1;
/**
 * One Library row. `owner` is the agent that wrote it and `size` is bytes; both are
 * null when the source store does not record them, and every surface shows that as "unknown".
 */
export interface LibraryItem { id: string; kind: LibraryKind; title: string; source: string; owner: string | null; asOf: string; size: number | null; preview: string }
export interface LibraryFilter { kind?: LibraryKind; since?: string; q?: string }
export interface LibrarySnapshot { v: typeof LIBRARY_SCHEMA_VERSION; asOf: string; items: LibraryItem[]; unavailable: string[] }
export const LIBRARY_ID = /^(file|media|memory|message|context):[0-9a-f]{16}$/;
/**
 * The existing stores the Library projects. Injectable so tests read fixtures;
 * the defaults are the real stores, which keep their own bounds and scrubbing.
 */
export interface LibrarySources {
  leaderFiles: typeof listLeaderFiles;
  attachments: typeof listLeaderAttachments;
  memory: typeof listMemory;
  handoffs: typeof readHandoffFiles;
  bus: typeof listBusInboxAfter;
  agentMemory: typeof readAgentMemory;
}
/** One specialist's own memory file (queue/specialists/memory/<id>.md). */
export interface AgentMemoryFile { id: string; callsign: string; text: string; size: number; modifiedAt: string }
/**
 * Agent memory: each specialist's outcome log. A missing roster or file is empty;
 * the roster reader fails closed on symlinked, oversized or malformed state.
 */
export async function readAgentMemory(rosterDir: string): Promise<AgentMemoryFile[]> {
  const roster = await loadSpecialistRoster(rosterDir);
  const dir = join(rosterDir, 'memory');
  try { if (!(await lstat(dir)).isDirectory()) throw new Error('Unavailable'); } // lstat: a symlinked folder is not followed
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const rows = await Promise.all(roster.specialists.map(async s => {
    const path = join(dir, `${s.id}.md`);
    const text = await readSpecialistFile(path);
    if (!text?.trim()) return null;
    // As-of is the newest outcome's own timestamp; the file time is only a fallback.
    const stamps = [...text.matchAll(/^## (\S+) — /gm)].map(m => Date.parse(m[1]!)).filter(Number.isFinite);
    const at = stamps.length ? new Date(Math.max(...stamps)) : (await lstat(path)).mtime;
    return { id: s.id, callsign: s.callsign, text, size: Buffer.byteLength(text), modifiedAt: at.toISOString() };
  }));
  return rows.filter((row): row is AgentMemoryFile => row !== null);
}
/** Latest outcome first, so the preview shows what the agent learned most recently. */
const latestEntry = (text: string): string => text.trim().split(/\n(?=## )/).at(-1)!.replace(/^#+\s*/gm, '').replace(/^>\s?/gm, '');
export interface LibraryDeps { runsDir?: string; home?: string; now?: () => Date; sources?: Partial<LibrarySources> }
/** A missing leader folder is an empty Library, not an unavailable one. */
async function leaderFiles(runsDir?: string): ReturnType<typeof listLeaderFiles> {
  const dir = runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  try { if (!(await lstat(join(dir, 'leader'))).isDirectory()) throw new Error('Unavailable'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  return listLeaderFiles(dir);
}
const DEFAULT_SOURCES: LibrarySources = { leaderFiles, attachments: listLeaderAttachments, memory: listMemory, handoffs: readHandoffFiles, bus: listBusInboxAfter, agentMemory: readAgentMemory };
const duration = (value: string): number => Number(value.slice(0, -1)) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[value.slice(-1)] ?? NaN);
export function parseLibraryFilter(input: Record<string, string>): LibraryFilter {
  if (Object.keys(input).some(k => !['kind', 'since', 'q'].includes(k)) ||
    (input.kind !== undefined && !(LIBRARY_KINDS as readonly string[]).includes(input.kind)) ||
    (input.since !== undefined && (!/^[1-9]\d{0,8}[smhdw]$/.test(input.since) || !Number.isSafeInteger(duration(input.since)))) ||
    (input.q !== undefined && (typeof input.q !== 'string' || input.q.length > 512))) throw new Error('Invalid Library filter.');
  return { kind: input.kind as LibraryKind | undefined, since: input.since, q: input.q?.trim() };
}
const words = (s: string): string => Array.from(scrubPrivateText(s).replace(/\s+/g, ' '))
  .filter(c => c.charCodeAt(0) >= 32 && (c.charCodeAt(0) < 127 || c.charCodeAt(0) > 159)).join('').trim();
const known = (owner: unknown): string | null => typeof owner === 'string' && words(owner) ? words(owner).slice(0, 80) : null;
const bytes = (size: unknown): number | null => Number.isSafeInteger(size) && (size as number) >= 0 ? size as number : null;
function item(kind: LibraryKind, key: string, title: string, source: string, asOf: string, preview: string, owner: unknown, size: unknown): LibraryItem {
  if (![key, title, source, asOf, preview].every(v => typeof v === 'string') || !Number.isFinite(Date.parse(asOf))) throw new Error('Malformed Library source.');
  // Identity is opaque; scrub whole strings BEFORE titles/previews are shortened.
  return { id: `${kind}:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`, kind,
    title: words(title).slice(0, 100), source: words(source), owner: known(owner), asOf: new Date(asOf).toISOString(), size: bytes(size), preview: words(preview).slice(0, 240) };
}
const fileTitle = (name: string): string => name.replace(/\.md$/, '').replace(/^drafts\//, 'Draft: ').replace(/[-_]/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
export async function readLibrary(filter: LibraryFilter = {}, deps: LibraryDeps = {}): Promise<LibrarySnapshot> {
  const read: LibrarySources = { ...DEFAULT_SOURCES, ...deps.sources };
  const checked = parseLibraryFilter(Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)));
  const now = (deps.now ?? (() => new Date()))(), home = deps.home ?? homedir();
  const runsDir = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(home, '.ashlr-runs');
  const unavailable: string[] = [];
  const sources: [string, LibraryKind, () => Promise<LibraryItem[]>][] = [
    ['Files', 'file', async () => {
      return (await read.leaderFiles(runsDir)).map(f => item('file', `leader/${f.name}`, fileTitle(f.name), `leader/${f.name}`, f.modifiedAt, f.preview, 'leader', f.size));
    }],
    ['Media', 'media', async () => {
      const media = await read.attachments({ limit: 100, runsDir });
      if (media.state === 'unavailable') throw new Error('Unavailable');
      return media.items.map(f => item('media', `inbox-attachments/${f.name}`, 'Screenshot', `inbox-attachments/${f.name}`, f.modifiedAt, `${f.type} · ${f.bytes} bytes`, null, f.bytes));
    }],
    // The memory store records who wrote each entry in `source`.
    ['Memory', 'memory', async () => (await read.memory({ home })).map(m =>
      item('memory', m.id, m.text, `~/.phantom/memory/${m.id}.md`, m.updated, m.text, m.source, Buffer.byteLength(m.text)))],
    // Each agent's own memory; the agent is the owner.
    ['Agent memory', 'memory', async () => (await read.agentMemory(join(runsDir, 'queue', 'specialists'))).map(m =>
      item('memory', `specialists/${m.id}`, `${m.callsign} memory`, `specialists/memory/${m.id}.md`, m.modifiedAt, latestEntry(m.text), m.callsign, m.size))],
    ['Context', 'context', async () => {
      const data = await read.handoffs(runsDir);
      if (data.state === 'unavailable' || data.state === 'partial') unavailable.push('Context');
      return data.handoffs.map(f => item('context', `${f.folder}/${f.name}`, `${f.folder}: ${fileTitle(f.name)}`, `handoff/${f.folder}/${f.name}`, f.modifiedAt, f.preview, null, f.size));
    }],
    ['Messages', 'message', async () => {
      const rows: LibraryItem[] = [];
      let after = 0;
      // Cursors are sparse after pruning. Counts are never valid cursors.
      for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / 100); page++) {
        const data = read.bus(after, 100, { root: join(deps.home ? join(home, '.ashlr') : ashlrHome(), 'fleet'), now: () => now.getTime() });
        if (data.status !== 'ok') throw new Error('Unavailable');
        for (const { envelope: e, receivedAt } of data.messages) {
          if (e.external || (e.channel && !['bus', 'handoff'].includes(e.channel))) continue;
          const body = typeof e.body === 'string' ? e.body : e.body && typeof e.body === 'object' && !Array.isArray(e.body)
            ? [e.body.text, e.body.message, e.body.summary].find(v => typeof v === 'string') : '';
          const text = typeof body === 'string' ? body : null;
          rows.push(item('message', e.id, `${e.from} → ${e.to}`, e.channel ?? 'bus', new Date(receivedAt).toISOString(), text ?? 'Agent message', e.from, text === null ? null : Buffer.byteLength(text)));
        }
        if (data.messages.length < 100 || data.nextCursor <= after) break;
        after = data.nextCursor;
      }
      return rows;
    }],
  ];
  const batches = await Promise.all(sources.filter(([, kind]) => !checked.kind || kind === checked.kind).map(async ([name, , read]) => {
    try { return await read(); } catch { unavailable.push(name); return []; }
  }));
  const since = checked.since ? now.getTime() - duration(checked.since) : -Infinity, terms = checked.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const items = batches.flat().filter(row => Date.parse(row.asOf) >= since && terms.every(term => `${row.title} ${row.source} ${row.preview}`.toLowerCase().includes(term)))
    .sort((a, b) => b.asOf.localeCompare(a.asOf) || a.id.localeCompare(b.id));
  return { v: LIBRARY_SCHEMA_VERSION, asOf: now.toISOString(), items, unavailable: [...new Set(unavailable)].sort() };
}
export interface LibraryItemResult { v: typeof LIBRARY_SCHEMA_VERSION; asOf: string; item: LibraryItem | null; unavailable: string[] }
/** One item by its opaque id, read through the same projection (and redaction) as the list. */
export async function readLibraryItem(id: string, deps: LibraryDeps = {}): Promise<LibraryItemResult> {
  const match = LIBRARY_ID.exec(id);
  if (!match) throw new Error('Invalid Library id.');
  const snapshot = await readLibrary({ kind: match[1] as LibraryKind }, deps);
  return { v: snapshot.v, asOf: snapshot.asOf, item: snapshot.items.find(row => row.id === id) ?? null, unavailable: snapshot.unavailable };
}
