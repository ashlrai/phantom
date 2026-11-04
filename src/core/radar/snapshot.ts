/** Normalized observations only. Failing discovery is never evidence of removal. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { fetchRadarSource, RADAR_MAX_BYTES } from './fetch.js';
import { isRadarText, radarIdSchema, radarSourceSchema, type RadarSource } from './sources.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const textSchema = z.string().min(1).max(16_384).refine(isRadarText);
export const radarDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('atom'), entries: z.array(z.object({ id: textSchema, title: textSchema }).strict()).max(10_000)
    .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate Atom identity') }).strict(),
  z.object({ kind: z.literal('npm'), version: textSchema }).strict(),
  z.object({ kind: z.literal('pypi'), version: textSchema }).strict(),
  z.object({ kind: z.literal('page'), hash: hashSchema, headings: z.array(textSchema).max(10_000) }).strict(),
  z.object({ kind: z.literal('json'), hash: hashSchema }).strict(),
]);
export type RadarData = z.infer<typeof radarDataSchema>;
export const radarSnapshotSchema = z.object({
  id: radarIdSchema, url: radarSourceSchema.shape.url, observedAt: z.iso.datetime(), data: radarDataSchema,
}).strict();
export type RadarSnapshot = z.infer<typeof radarSnapshotSchema>;
const stateSchema = z.object({
  schemaVersion: z.literal(1), lastRunAt: z.iso.datetime(),
  current: radarSnapshotSchema.nullable(), previous: radarSnapshotSchema.nullable(), failed: z.boolean(),
}).strict();
export type RadarState = z.infer<typeof stateSchema>;
export const RADAR_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const clean = (text: string): string => text.replace(/\s+/gu, ' ').trim();
const MAX_STATE_BYTES = 8 * RADAR_MAX_BYTES;
function entities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, code: string) => {
    if (!code.startsWith('#')) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[code.toLowerCase()] ?? raw;
    const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    if (value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw new Error('Invalid character reference');
    return String.fromCodePoint(value);
  });
}
/** Each character is scanned at most once, including malformed tag fragments. */
function* htmlTokens(html: string): Generator<string> {
  let start = 0;
  while (start < html.length) {
    if (html[start] !== '<') {
      const next = html.indexOf('<', start);
      const end = next < 0 ? html.length : next;
      yield html.slice(start, end); start = end; continue;
    }
    if (html.startsWith('<!--', start)) {
      const next = html.indexOf('-->', start + 4);
      const end = next < 0 ? html.length : next + 3;
      yield html.slice(start, end); start = end; continue;
    }
    let quote = '';
    let end = start + 1;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') { end++; break; }
      else if (char === '<') break;
    }
    yield html.slice(start, end);
    start = end;
  }
}
/** Single token pass avoids rescanning many unterminated script/heading tags. */
function pageProjection(html: string): { text: string; headings: string[] } {
  const text: string[] = [];
  const headings: string[] = [];
  let hidden: string | undefined;
  let heading: { tag: string; text: string[] } | undefined;
  for (const raw of htmlTokens(html)) {
    if (raw.startsWith('<!--')) continue;
    if (raw.startsWith('<') && raw.endsWith('>')) {
      const tag = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)/i.exec(raw);
      if (!tag) { if (!hidden) { text.push(raw); heading?.text.push(raw); } continue; }
      const name = tag[2].toLowerCase();
      const closing = !!tag[1];
      if (hidden) { if (closing && name === hidden) hidden = undefined; continue; }
      if (!closing && (name === 'script' || name === 'style')) { hidden = name; continue; }
      text.push(' ');
      if (/^h[1-6]$/.test(name)) {
        if (closing && heading?.tag === name) {
          const title = clean(entities(heading.text.join('')));
          if (title) headings.push(title);
          heading = undefined;
        } else if (!closing) heading = { tag: name, text: [] };
      } else heading?.text.push(' ');
    } else if (!hidden) { text.push(raw); heading?.text.push(raw); }
  }
  return { text: clean(entities(text.join(''))), headings };
}
function plain(text: string): string { return pageProjection(text).text; }

/** Small non-expanding XML reader. Reject malformed/truncated feeds and all DTDs. */
function atomEntries(xml: string): Array<{ id: string; title: string }> {
  for (const char of xml) {
    const code = char.charCodeAt(0);
    if (code < 32 && ![9, 10, 13].includes(code)) throw new Error('Invalid XML character');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported XML declaration');
  const stack: Array<{ name: string; local: string; atom: boolean; text: string; type: string; namespaces: Record<string, string>; id?: string; title?: string }> = [];
  const entries: Array<{ id: string; title: string }> = [];
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w.:-]*(?:"[^"]*"|'[^']*'|[^'"<>])*>|[^<]+/g;
  let offset = 0;
  let feeds = 0;
  for (const match of xml.matchAll(token)) {
    if (match.index !== offset) throw new Error('Invalid XML');
    offset += match[0].length;
    const raw = match[0];
    if (raw.startsWith('<!--') || raw.startsWith('<?')) continue;
    if (!raw.startsWith('<') || raw.startsWith('<![CDATA[')) {
      const cdata = raw.startsWith('<![CDATA[');
      if (!cdata && /&(?!(?:amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);)/i.test(raw)) throw new Error('Unsupported XML entity');
      const text = cdata ? raw.slice(9, -3) : entities(raw);
      if (stack.length) stack[stack.length - 1].text += text;
      else if (text.trim()) throw new Error('Text outside feed');
      continue;
    }
    const name = /^<\/?([\w.:-]+)/.exec(raw)![1];
    const local = name.split(':').at(-1)!;
    if (raw.startsWith('</')) {
      if (raw.slice(name.length + 2, -1).trim()) throw new Error('Invalid XML close');
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error('Unbalanced XML');
      const parent = stack.at(-1);
      if (parent) parent.text += node.text;
      if (parent?.atom && parent.local === 'entry' && node.atom && (local === 'id' || local === 'title')) {
        if (parent[local] !== undefined) throw new Error('Duplicate entry field');
        parent[local] = local === 'title' && node.type === 'html' ? plain(node.text) : clean(node.text);
      }
      if (node.atom && local === 'entry' && parent?.atom && parent.local === 'feed') {
        if (!node.id || !node.title) throw new Error('Incomplete Atom entry');
        entries.push({ id: node.id, title: node.title });
      }
    } else {
      const attributes: Record<string, string> = Object.create(null);
      const attribute = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/gy;
      const selfClosing = /\/>$/.test(raw);
      const tail = raw.slice(name.length + 1, selfClosing ? -2 : -1);
      let pos = 0;
      while (tail.slice(pos).trim()) {
        attribute.lastIndex = pos;
        const attr = attribute.exec(tail);
        if (!attr || Object.hasOwn(attributes, attr[1])) throw new Error('Invalid XML attribute');
        const value = attr[2] ?? attr[3];
        if (/&(?!(?:amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);)/i.test(value)) throw new Error('Unsupported XML entity');
        attributes[attr[1]] = entities(value);
        pos = attribute.lastIndex;
      }
      const namespaces = { ...stack.at(-1)?.namespaces };
      for (const [key, value] of Object.entries(attributes)) {
        if (key === 'xmlns') namespaces[''] = value;
        else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value;
      }
      const atom = namespaces[name.includes(':') ? name.split(':')[0] : ''] === 'http://www.w3.org/2005/Atom';
      if (!stack.length) { if (local !== 'feed' || !atom || ++feeds !== 1) throw new Error('Expected one Atom feed'); }
      const type = attributes.type ?? 'text';
      if (atom && local === 'title' && !['text', 'html', 'xhtml'].includes(type)) throw new Error('Unsupported Atom title');
      // Entry identity and title must contain data, not an empty element.
      if (selfClosing && ['entry', 'id', 'title'].includes(local)) throw new Error('Empty Atom entry');
      if (!selfClosing) {
        if (stack.length >= 100) throw new Error('XML nesting limit');
        stack.push({ name, local, atom, type, namespaces, text: '' });
      }
    }
  }
  if (offset !== xml.length || stack.length || feeds !== 1) throw new Error('Incomplete Atom feed');
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Duplicate Atom id');
  return entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Sort object keys recursively, preserving JSON array order and primitive types. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 100) throw new Error('JSON nesting limit');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite JSON number');
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function normalizeRadarSnapshot(input: RadarSource, body: string, observedAt = new Date().toISOString()): RadarSnapshot {
  const source = radarSourceSchema.parse(input);
  if (Buffer.byteLength(body) > RADAR_MAX_BYTES || !body.trim()) throw new Error('Invalid Radar body');
  let data: RadarData;
  if (source.kind === 'atom') data = { kind: 'atom', entries: atomEntries(body) };
  else if (source.kind === 'page') {
    const { text, headings } = pageProjection(body);
    if (!text) throw new Error('Empty page');
    data = { kind: 'page', hash: digest(text), headings };
  } else {
    const json = JSON.parse(body);
    if (source.kind === 'json') data = { kind: 'json', hash: digest(canonical(json)) };
    else {
      const version = source.kind === 'npm' ? json?.['dist-tags']?.latest ?? json?.version : json?.info?.version;
      data = { kind: source.kind, version: z.string().trim().min(1).max(256).regex(/^\S+$/).refine(isRadarText).parse(version) };
    }
  }
  return radarSnapshotSchema.parse({ id: source.id, url: source.url, observedAt, data });
}

export const radarSnapshotsDir = (home = homedir()): string => join(home, '.phantom', 'radar', 'snapshots');
async function ensureDir(home: string): Promise<void> {
  let path = home;
  for (const segment of ['.phantom', 'radar', 'snapshots']) {
    path = join(path, segment);
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid Radar directory');
  }
}
function stateMatches(state: RadarState, source: RadarSource): void {
  for (const snapshot of [state.current, state.previous]) {
    if (snapshot && (snapshot.id !== source.id || snapshot.url !== source.url || snapshot.data.kind !== source.kind)) throw new Error('Radar source identity changed');
  }
}
export async function readRadarState(source: RadarSource, home = homedir()): Promise<RadarState | null> {
  radarSourceSchema.parse(source);
  // Also guard reads: diff must not follow a substituted parent directory.
  for (const path of [join(home, '.phantom'), join(home, '.phantom', 'radar'), radarSnapshotsDir(home)]) {
    try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid Radar directory'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  let file;
  try { file = await open(join(radarSnapshotsDir(home), `${source.id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error('Invalid Radar state');
    const state = stateSchema.parse(JSON.parse(await file.readFile('utf8')));
    stateMatches(state, source);
    return state;
  } finally { await file.close(); }
}
async function saveState(source: RadarSource, state: RadarState, home: string): Promise<void> {
  const dir = radarSnapshotsDir(home);
  const temp = join(dir, `${source.id}.${randomUUID()}.tmp`);
  const file = await open(temp, 'wx', 0o600);
  try {
    const serialized = `${JSON.stringify(stateSchema.parse(state), null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error('Radar state size limit');
    await file.writeFile(serialized);
    await file.close();
    await rename(temp, join(dir, `${source.id}.json`));
  } finally { await file.close(); await unlink(temp).catch(() => undefined); }
}

export type RadarRunResult = { id: string; status: 'updated' | 'throttled' | 'busy' | 'error' | 'unverified'; retryAt?: string; state?: RadarState };
/** A per-source exclusive lock covers the persisted cooldown and network read. */
export async function runRadarSource(input: RadarSource, options: {
  home?: string; now?: () => number; fetch?: (source: RadarSource) => Promise<string>;
} = {}): Promise<RadarRunResult> {
  const source = radarSourceSchema.parse(input);
  if (!source.verified) return { id: source.id, status: 'unverified' };
  const home = options.home ?? homedir();
  await ensureDir(home);
  const lockPath = join(radarSnapshotsDir(home), `${source.id}.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { id: source.id, status: 'busy' }; throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const now = (options.now ?? Date.now)();
    const observedAt = new Date(now).toISOString();
    const old = await readRadarState(source, home);
    if (old && now - Date.parse(old.lastRunAt) < RADAR_MIN_INTERVAL_MS) {
      return { id: source.id, status: 'throttled', retryAt: new Date(Date.parse(old.lastRunAt) + RADAR_MIN_INTERVAL_MS).toISOString() };
    }
    // Persist the attempt before I/O, so crashes and failed reads cannot bypass
    // the six-hour floor. Keep the last two successful observations intact.
    const state: RadarState = { schemaVersion: 1, lastRunAt: observedAt, current: old?.current ?? null, previous: old?.previous ?? null, failed: true };
    await saveState(source, state, home);
    let current: RadarSnapshot;
    try { current = normalizeRadarSnapshot(source, await (options.fetch ?? fetchRadarSource)(source), observedAt); }
    catch { return { id: source.id, status: 'error' }; }
    state.previous = state.current;
    state.current = current;
    state.failed = false;
    await saveState(source, state, home);
    return { id: source.id, status: 'updated', state };
  } finally { await lock.close(); await unlink(lockPath); }
}
