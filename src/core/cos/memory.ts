/** Durable preferences and doctrine, one markdown file per entry under ~/.phantom/memory/. */
import { mkdir, readFile, readdir, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertMetadata } from '../connectors/profile.js';

export class MemoryError extends Error {}
const fail = (message: string): never => { throw new MemoryError(message); };

export const MEMORY_KINDS = ['preference', 'doctrine', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export interface MemoryEntry { id: string; kind: MemoryKind; source: string; updated: string; text: string; }

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TEXT = 2000;
const MAX_SOURCE = 200;
const KIND_ORDER: Record<MemoryKind, number> = { doctrine: 0, preference: 1, fact: 2 };

export const memoryDir = (home = homedir()): string => join(home, '.phantom', 'memory');

/** Same secret-shape gate as connector profiles. Diagnostics never echo the rejected value. */
function assertClean(...parts: string[]): void {
  try { for (const p of parts) assertMetadata(p); }
  catch { fail('Secret-shaped memory refused. Store credentials in Phantom Secrets and refer to them by binding name only.'); }
}

const isKind = (v: unknown): v is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(v as string);

function encode(e: MemoryEntry): string {
  return `---\nid: ${e.id}\nkind: ${e.kind}\nsource: ${e.source}\nupdated: ${e.updated}\n---\n${e.text}\n`;
}

/** Returns null for anything malformed or secret-shaped so a tampered file never reaches a caller. */
function decode(raw: string, expectedId: string): MemoryEntry | null {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*?)\n?$/.exec(raw);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(': ');
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 2);
  }
  const { id, kind, source, updated } = fields;
  const text = m[2]!;
  if (id !== expectedId || !isKind(kind) || source === undefined || !updated || !text || text.length > MAX_TEXT || Number.isNaN(Date.parse(updated))) return null;
  try { assertMetadata(raw); } catch { return null; }
  return { id, kind, source, updated, text };
}

async function guardDir(dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('Memory directory must be a regular directory. Remove the symlink or file at ~/.phantom/memory.');
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

export async function listMemory(opts: { kind?: MemoryKind; home?: string } = {}): Promise<MemoryEntry[]> {
  const dir = memoryDir(opts.home);
  if (!(await guardDir(dir))) return [];
  const entries: MemoryEntry[] = [];
  for (const name of await readdir(dir)) {
    const id = name.endsWith('.md') ? name.slice(0, -3) : '';
    if (!ID.test(id)) continue;
    let raw: string;
    try { raw = await readFile(join(dir, name), 'utf8'); } catch { continue; }
    const entry = decode(raw, id);
    if (entry && (!opts.kind || entry.kind === opts.kind)) entries.push(entry);
  }
  return entries.sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
}

/** Entry ids derive from kind and text, so re-adding identical memory refreshes it instead of duplicating. */
export async function addMemory(input: { kind: string; text: string; source?: string; id?: string }, opts: { home?: string; now?: Date } = {}): Promise<MemoryEntry> {
  if (!isKind(input.kind)) fail(`Unknown kind. Use ${MEMORY_KINDS.join(', ')}.`);
  const text = input.text.trim();
  const source = (input.source ?? 'cli').trim();
  if (!text) fail('Memory text is empty. Supply the preference, doctrine or fact to remember.');
  if (text.length > MAX_TEXT) fail(`Memory text is longer than ${MAX_TEXT} characters. Split it into separate entries.`);
  if (/^---\s*$/m.test(text)) fail('Memory text cannot contain a front matter delimiter line.');
  if (!source || source.length > MAX_SOURCE || /[\r\n]/.test(source)) fail(`Source must be one line of at most ${MAX_SOURCE} characters.`);
  assertClean(text, source);
  const id = input.id ?? `${input.kind.slice(0, 4)}-${createHash('sha256').update(`${input.kind}\n${text}`).digest('hex').slice(0, 10)}`;
  if (!ID.test(id)) fail('Invalid id. Use lowercase letters, digits and hyphens, up to 64 characters.');
  const entry: MemoryEntry = { id, kind: input.kind as MemoryKind, source, updated: (opts.now ?? new Date()).toISOString(), text };
  const dir = memoryDir(opts.home);
  await guardDir(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${id}-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, encode(entry), { mode: 0o600, flag: 'wx' });
    await rename(tmp, join(dir, `${id}.md`));
  } finally { await rm(tmp, { force: true }); }
  return entry;
}

/** Case-insensitive match on every whitespace separated term, across text, id, kind and source. */
export async function searchMemory(query: string, opts: { home?: string } = {}): Promise<MemoryEntry[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) fail('Supply a search term.');
  return (await listMemory(opts)).filter(e => {
    const hay = `${e.id} ${e.kind} ${e.source} ${e.text}`.toLowerCase();
    return terms.every(t => hay.includes(t));
  });
}

export async function forgetMemory(id: string, opts: { home?: string } = {}): Promise<boolean> {
  if (!ID.test(id)) fail('Invalid id. Run phm memory list to see ids.');
  const dir = memoryDir(opts.home);
  if (!(await guardDir(dir))) return false;
  try { await lstat(join(dir, `${id}.md`)); } catch { return false; }
  await rm(join(dir, `${id}.md`), { force: true });
  return true;
}

/**
 * Read-only prompt block for COS intake. Doctrine first, then preferences, then facts,
 * newest first inside each kind; stops at maxChars so intake size stays bounded.
 * Returns an empty string when nothing is stored or the store is unreadable.
 */
export async function memoryContext(opts: { home?: string; maxChars?: number } = {}): Promise<string> {
  let entries: MemoryEntry[];
  try { entries = await listMemory({ home: opts.home }); } catch { return ''; }
  entries.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const budget = opts.maxChars ?? 4000;
  const lines: string[] = [];
  let used = 0;
  for (const e of entries) {
    const line = `- [${e.kind}] ${e.text.replace(/\s*\n\s*/g, ' ')}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? `Mason's memory (preferences, doctrine, facts):\n${lines.join('\n')}` : '';
}
