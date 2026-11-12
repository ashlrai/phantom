/**
 * LinkedIn drop folder reader: each LinkedIn message Mason (or a helper) saves
 * as `<runsDir>/comms/linkedin/inbox/<name>.json` becomes an item in the
 * unified comms inbox. Two envelope shapes are accepted:
 *
 *   flat     `{ id, from, text, at, threadUrl? }` — the current drop contract.
 *   original `{ id, threadId, from: { name, profileUrl? }, receivedAt, text }`
 *            — the exporter envelope from the original LinkedIn drop spec.
 *            `threadId` and `from.profileUrl` are validated as evidence but the
 *            public `LinkedInMessage` shape has no fields for them, so they are
 *            not surfaced.
 *
 * A message is suppressed when `<runsDir>/comms/linkedin/answered/<id>` exists
 * (current contract) or `<runsDir>/comms/linkedin/handled/<id>.handled` exists
 * (original exporter contract). Both live under the same LinkedIn base
 * directory; ids are pattern-checked so neither marker path can escape it.
 *
 * Reading is side-effect free: no network, no writes, no sends. The one write
 * is `markLinkedInAnswered`, an owner action that drops the answered marker.
 * File contents are untrusted
 * (scrubbed, single-lined, length-capped). Bounded: at most MAX_FILES files of
 * at most MAX_FILE_BYTES each. Never throws.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';

export const LINKEDIN_DROP_MAX_FILES = 200;
export const LINKEDIN_DROP_MAX_FILE_BYTES = 64 * 1024;
const ID_MAX = 80;
const FROM_MAX = 80;
const TEXT_MAX = 500;
const URL_MAX = 300;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface LinkedInMessage {
  id: string;
  from: string;
  text: string;
  /** ISO time the message arrived. */
  at: string;
  threadUrl?: string;
}

export interface LinkedInDropResult {
  sourceState: 'healthy' | 'missing' | 'degraded';
  messages: LinkedInMessage[];
  /** Files skipped as malformed, oversize or over the file bound. */
  skipped: number;
}

export interface LinkedInDropOptions {
  runsDir?: string;
  now?: () => number;
}

const clean = (text: string, max: number): string => {
  const line = scrubSecrets(text).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Non-empty after stripping control/format characters, matching the original exporter's `nonempty`. */
const hasContent = (value: unknown): value is string =>
  typeof value === 'string' && value.replace(/\p{C}/gu, '').trim().length > 0;

const ORIGINAL_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Strict `YYYY-MM-DDTHH:MM:SS(.sss)?Z` parse for the original exporter's
 * `receivedAt`. Component-wise comparison rejects impossible calendar dates
 * (e.g. Feb 30) that `Date.parse` would silently roll into the next month.
 */
function originalTimestamp(raw: string): string | null {
  const m = ORIGINAL_ISO.exec(raw);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(s);
  const ms = frac === undefined ? 0 : Number(frac.padEnd(3, '0'));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (year < 100) date.setUTCFullYear(year);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
  return date.toISOString();
}

interface ParsedEnvelope {
  id: string;
  from: string;
  text: string;
  /** Canonical ISO time. */
  at: string;
}

const validId = (r: Record<string, unknown>): r is Record<string, unknown> & { id: string } =>
  typeof r.id === 'string' && ID_PATTERN.test(r.id) && r.id.length <= ID_MAX;

/** Current flat contract: `{ id, from: string, text, at, threadUrl? }`. */
function parseFlatEnvelope(r: Record<string, unknown>): ParsedEnvelope | null {
  if (!validId(r) || typeof r.from !== 'string' || typeof r.text !== 'string' ||
      typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return null;
  return { id: r.id, from: r.from, text: r.text, at: new Date(Date.parse(r.at)).toISOString() };
}

/**
 * Original exporter contract: `{ id, threadId, from: { name, profileUrl? },
 * receivedAt, text }`. `threadId` and `profileUrl` are required to be present
 * and non-empty (the exporter always writes them) but are not surfaced: the
 * public shape carries no fields for them.
 */
function parseOriginalEnvelope(r: Record<string, unknown>): ParsedEnvelope | null {
  if (!validId(r) || typeof r.receivedAt !== 'string' || !hasContent(r.threadId) || !hasContent(r.text)) return null;
  const from = r.from;
  if (from === null || typeof from !== 'object' || Array.isArray(from)) return null;
  const sender = from as Record<string, unknown>;
  if (!hasContent(sender.name) || (sender.profileUrl !== undefined && !hasContent(sender.profileUrl))) return null;
  const at = originalTimestamp(r.receivedAt);
  if (at === null) return null;
  return { id: r.id, from: sender.name, text: r.text, at };
}

export function linkedInDropDir(runsDir: string): string {
  return join(runsDir, 'comms', 'linkedin');
}

export function readLinkedInDrop(options: LinkedInDropOptions = {}): LinkedInDropResult {
  const runsDir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const base = linkedInDropDir(runsDir);
  const inbox = join(base, 'inbox');
  if (!existsSync(inbox)) return { sourceState: 'missing', messages: [], skipped: 0 };
  let names: string[];
  try { names = readdirSync(inbox).filter(n => n.endsWith('.json')).sort(); }
  catch { return { sourceState: 'degraded', messages: [], skipped: 0 }; }

  let skipped = Math.max(0, names.length - LINKEDIN_DROP_MAX_FILES);
  const messages: LinkedInMessage[] = [];
  const seen = new Set<string>();
  for (const name of names.slice(0, LINKEDIN_DROP_MAX_FILES)) {
    try {
      const path = join(inbox, name);
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > LINKEDIN_DROP_MAX_FILE_BYTES) { skipped++; continue; }
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { skipped++; continue; }
      const r = raw as Record<string, unknown>;
      const env = parseFlatEnvelope(r) ?? parseOriginalEnvelope(r);
      if (env === null) { skipped++; continue; }
      if (seen.has(env.id)) { skipped++; continue; }
      seen.add(env.id);
      // The id passed ID_PATTERN, so it cannot escape the marker directories.
      if (existsSync(join(base, 'answered', env.id)) ||
          existsSync(join(base, 'handled', `${env.id}.handled`))) continue;
      const msg: LinkedInMessage = {
        id: env.id,
        from: clean(env.from, FROM_MAX) || 'unknown',
        text: clean(env.text, TEXT_MAX),
        at: env.at,
      };
      if (typeof r.threadUrl === 'string' && /^https:\/\/([a-z0-9-]+\.)?linkedin\.com\//i.test(r.threadUrl)) {
        msg.threadUrl = clean(r.threadUrl, URL_MAX);
      }
      messages.push(msg);
    } catch { skipped++; }
  }
  return { sourceState: skipped > 0 ? 'degraded' : 'healthy', messages, skipped };
}

/**
 * Mark a LinkedIn message answered by writing `<runsDir>/comms/linkedin/answered/<id>`
 * (mode 0600, ISO time) exclusively. Nothing is sent anywhere. The id is checked
 * against the same pattern the reader uses, so it cannot escape the answered
 * directory. Never throws for a bad id.
 */
export function markLinkedInAnswered(runsDir: string, id: string, now: () => Date = () => new Date()): 'marked' | 'already' | 'invalid' {
  if (typeof id !== 'string' || id.length === 0 || id.length > ID_MAX || !ID_PATTERN.test(id)) return 'invalid';
  const dir = join(linkedInDropDir(runsDir), 'answered');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(dir, id), `${now().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
    return 'marked';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'already';
    throw error;
  }
}
