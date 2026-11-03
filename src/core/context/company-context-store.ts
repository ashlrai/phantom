import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { scrubSecrets } from '../util/scrub-secrets.js';

export const contextSections = ['decisions', 'priorities', 'clients', 'people', 'fleet-state'] as const;
export type ContextSection = typeof contextSections[number];
export interface ContextEntry {
  id: string; section: ContextSection; text: string; source: string; createdAt: number; expiresAt?: number;
}
export interface ContextWrite {
  section: ContextSection; text: string; source: string; id?: string; expiresAt?: number;
}
const schema = 'company.context.v1';
const root = () => join(homedir(), '.ashlr-runs', 'context');
export function contextSection(value: string): ContextSection {
  if (!contextSections.includes(value as ContextSection)) throw new Error('Choose decisions, priorities, clients, people, or fleet-state.');
  return value as ContextSection;
}
function safe(value: string, limit: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit &&
    scrubSecrets(value) === value && !/[A-Za-z0-9_+/=-]{32,}/.test(value);
}
function entries(directory: string): ContextEntry[] {
  let fd: number;
  try { fd = openSync(join(directory, 'company.context.v1.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Cannot read company context.'); }
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 8 * 1024 * 1024) throw new Error('Company context is too large or invalid.');
    return readFileSync(fd, 'utf8').split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line) as ContextEntry & { schema: string };
      if (row.schema !== schema || !safe(row.id, 128) || !safe(row.text, 16000) || !safe(row.source, 256) ||
          contextSection(row.section) !== row.section || !Number.isFinite(row.createdAt) ||
          (row.expiresAt !== undefined && !Number.isFinite(row.expiresAt))) throw new Error('Invalid company context.');
      return row;
    });
  } catch { throw new Error('Cannot read company context: invalid store.'); }
  finally { closeSync(fd); }
}
export function writeCompanyContext(input: ContextWrite, directory = root()): { id: string; appended: boolean } {
  contextSection(input.section);
  if (!safe(input.text, 16000) || !safe(input.source, 256) || (input.id !== undefined && !safe(input.id, 128)))
    throw new Error('Context refused: use plain text without keys or credentials.');
  if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()))
    throw new Error('Expiry must be a future time.');
  const id = input.id ?? createHash('sha256').update(JSON.stringify([input.section, input.text.trim(), input.source.trim()])).digest('hex').slice(0, 24);
  const lock = acquireLocalStoreLock(join(directory, '.write.lock'), 10000);
  if (!lock) throw new Error('Company context is busy. Try again.');
  try {
    const rows = entries(directory);
    if (rows.some(row => row.id === id)) return { id, appended: false };
    const row = { schema, ...input, id, text: input.text.trim(), source: input.source.trim(), createdAt: Date.now() };
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    const fd = openSync(join(directory, 'company.context.v1.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).nlink !== 1 || fstatSync(fd).size + bytes.length > 8 * 1024 * 1024)
        throw new Error('Company context is too large or invalid.');
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return { id, appended: true };
  } finally { releaseLocalStoreLock(lock); }
}
/** One UTF-8 byte per budget unit conservatively bounds model tokens, including Unicode. */
export function readCompanyContext(options: { section?: ContextSection; maxTokens?: number; now?: number } = {}, directory = root()) {
  const maxTokens = options.maxTokens ?? 1024;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16000) throw new Error('Token limit must be 1 to 16000.');
  if (options.section) contextSection(options.section);
  const rows = entries(directory).filter(row => (!options.section || row.section === options.section) &&
    (row.expiresAt === undefined || row.expiresAt > (options.now ?? Date.now())));
  const full = rows.map(row => `[${row.section}] ${row.text} (source: ${row.source})`).join('\n');
  let digest = ''; let bytes = 0;
  for (const character of full) {
    const cost = Buffer.byteLength(character);
    if (bytes + cost > maxTokens) break;
    digest += character; bytes += cost;
  }
  return { schema, digest, maxTokens, truncated: digest.length < full.length };
}
