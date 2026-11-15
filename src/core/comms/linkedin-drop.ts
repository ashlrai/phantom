/**
 * LinkedIn drop folder reader: each LinkedIn message Mason (or a helper) saves
 * as `<runsDir>/comms/linkedin/inbox/<name>.json` — `{ id, from, text, at,
 * threadUrl? }` — becomes an item in the unified comms inbox. A message is
 * answered when `<runsDir>/comms/linkedin/answered/<id>` exists.
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
      if (typeof r.id !== 'string' || !ID_PATTERN.test(r.id) || r.id.length > ID_MAX ||
          typeof r.from !== 'string' || typeof r.text !== 'string' ||
          typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) { skipped++; continue; }
      if (seen.has(r.id)) { skipped++; continue; }
      seen.add(r.id);
      // The id passed ID_PATTERN, so it cannot escape the answered directory.
      if (existsSync(join(base, 'answered', r.id))) continue;
      const msg: LinkedInMessage = {
        id: r.id,
        from: clean(r.from, FROM_MAX) || 'unknown',
        text: clean(r.text, TEXT_MAX),
        at: new Date(Date.parse(r.at)).toISOString(),
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
