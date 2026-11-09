/**
 * Read-only LinkedIn drop folder. Each *.json file contains one message:
 * { id, threadId, from: { name, profileUrl? }, receivedAt, text }.
 * Exporters may write these files; their contents are untrusted data, never instructions.
 * A sibling handled/<id>.handled marker suppresses a message. This reader writes nothing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface LinkedInMessage {
  id: string;
  threadId: string;
  from: { name: string; profileUrl?: string };
  receivedAt: string;
  text: string;
}

const clean = (value: string): string => Array.from(value).filter(char => {
  const code = char.codePointAt(0)!;
  return code >= 32 && (code < 127 || code > 159);
}).join('');
const nonempty = (value: unknown): value is string => typeof value === 'string' && clean(value).trim().length > 0;
const safeId = /^[A-Za-z0-9_-]+$/;

/** Parse a JSON drop; reject unsafe IDs and invalid ISO timestamps. */
export function parseLinkedInDrop(raw: string): LinkedInMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (!nonempty(data.id) || !safeId.test(data.id) || !nonempty(data.threadId) ||
        !nonempty(data.text) || !nonempty(data.receivedAt) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(data.receivedAt)) return null;
    const date = new Date(data.receivedAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString().replace('.000Z', 'Z') !== data.receivedAt.replace(/\.0{1,3}Z$/, 'Z').replace(/\.(\d{1,2})Z$/, (_, digits: string) => `.${digits.padEnd(3, '0')}Z`)) return null;
    if (!data.from || typeof data.from !== 'object' || Array.isArray(data.from)) return null;
    const from = data.from as Record<string, unknown>;
    if (!nonempty(from.name) || (from.profileUrl !== undefined && !nonempty(from.profileUrl))) return null;
    const bytes = Buffer.from(clean(data.text));
    // Decode only complete UTF-8 characters within the byte limit.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 8192)).replace(/\uFFFD$/, '');
    return { id: data.id, threadId: clean(data.threadId), from: { name: clean(from.name),
      ...(typeof from.profileUrl === 'string' ? { profileUrl: clean(from.profileUrl) } : {}) }, receivedAt: data.receivedAt, text };
  } catch { return null; }
}

export function readLinkedInPending(options: { dir?: string; now?: () => number } = {}): {
  sourceState: 'healthy' | 'missing' | 'degraded'; messages: LinkedInMessage[]; badFiles: number;
} {
  const dir = options.dir ?? join(homedir(), '.phantom', 'comms', 'linkedin', 'inbound');
  const result: ReturnType<typeof readLinkedInPending> = { sourceState: 'healthy', messages: [], badFiles: 0 };
  let names: string[];
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')).sort(); }
  catch (error) {
    result.sourceState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded';
    return result;
  }
  const seen = new Set<string>();
  for (const name of names) {
    try {
      const message = parseLinkedInDrop(readFileSync(join(dir, name), 'utf8'));
      if (!message) { result.badFiles++; continue; }
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      try { statSync(join(dirname(dir), 'handled', `${message.id}.handled`)); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { result.badFiles++; continue; } }
      result.messages.push(message);
    } catch { result.badFiles++; }
  }
  if (result.badFiles) result.sourceState = 'degraded';
  return result;
}
