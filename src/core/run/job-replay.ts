/** Read-only projection of the existing durable run stream. No engine dispatch. */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { readPrivateFileCapped } from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub-secrets.js';

export const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
export interface ReplayStep { at: string; kind: string; text: string }
export interface JobTimeline { steps: ReplayStep[]; incomplete: boolean }

/** Strip terminal controls before redaction, so escapes cannot split a token. */
function plainText(text: string): string {
  return [...stripVTControlCharacters(text)].filter(char => {
    const code = char.charCodeAt(0);
    return code > 31 && (code < 127 || code > 159);
  }).join('');
}

export function parseJobTimeline(text: string): JobTimeline {
  if (Buffer.byteLength(text) > MAX_REPLAY_BYTES) throw new Error('Replay log exceeds size limit.');
  const lines = text.split('\n');
  const incomplete = lines.at(-1) !== '';
  if (incomplete) lines.pop(); // A writer may still be appending the final record.
  const records: { at: string; kind: string; text: string }[] = [];
  const kinds = new Set(['task-start', 'model-delta', 'tool-call', 'task-done', 'retry', 'verify', 'log']);
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Invalid replay log.'); }
    if (!value || typeof value !== 'object') throw new Error('Invalid replay log.');
    const row = value as Record<string, unknown>;
    if (typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)) ||
        typeof row.kind !== 'string' || !kinds.has(row.kind) || typeof row.text !== 'string') {
      throw new Error('Invalid replay log.');
    }
    records.push({ at: new Date(row.ts).toISOString(), kind: row.kind, text: plainText(row.text) });
  }
  // Scrub the whole text stream before assigning text back to records: secrets
  // split across model-delta records must never be released one fragment at a time.
  const joined = records.map(row => row.text).join('');
  const safeJoined = scrubSecrets(joined);
  // Redaction changes offsets. In that case suppress all payloads rather than
  // guessing which records contain a fragment of a credential.
  const changed = safeJoined !== joined;
  return { incomplete, steps: records.map(row => ({
    at: row.at,
    kind: row.kind === 'verify' ? 'check' : row.kind === 'tool-call' &&
      /\b(write|edit|create|replace|patch|insert|delete|remove|move|rename|notebook)/i.test(row.text) ? 'edit' : row.kind,
    text: changed ? '[redacted log content]' : row.text,
  })) };
}

export function loadJobTimeline(jobId: string): JobTimeline {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/.test(jobId)) throw new Error('Invalid job ID.');
  const root = join(homedir(), '.ashlr');
  const directory = join(root, 'run-streams');
  try {
    for (const path of [root, directory]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    }
    const file = readPrivateFileCapped(join(directory, `${jobId}.log`), MAX_REPLAY_BYTES);
    if (!file || file.truncated) throw new Error();
    return parseJobTimeline(file.text);
  } catch {
    throw new Error('Replay log unavailable or invalid.');
  }
}
