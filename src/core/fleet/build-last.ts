/**
 * build-last.ts — the result of the host's last rebuild, read from `leader/phm-live-state.txt` (the file the
 * 30-minute rebuild writes). Read-only and tolerant: the file is plain text written by a shell script, so this
 * looks for a commit, a time and a result word per line and keeps the latest of each. Nothing is guessed:
 * a missing or unreadable file is "unknown" with the reason.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type LastBuild =
  | { state: 'known'; result: 'ok' | 'failed' | 'skipped'; sha: string | null; at: string | null; line: string }
  | { state: 'unknown'; why: string };

export const liveStatePath = (runsDir: string): string => join(runsDir, 'leader', 'phm-live-state.txt');

const SHA = /\b[0-9a-f]{7,40}\b/i;
const TIME = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?/;
const FAILED = /\b(fail(?:ed|ure)?|error|broken)\b/i;
const SKIPPED = /\bskipp?ed\b/i;
const RESULT = /\b(built|ok|success|succeeded|fail(?:ed|ure)?|error|skipp?ed)\b/i;

export function parseLiveState(text: string): LastBuild {
  let sha: string | null = null, at: string | null = null, result: 'ok' | 'failed' | 'skipped' | null = null, line = '';
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const s = SHA.exec(l)?.[0]; if (s) sha = s.toLowerCase();
    const t = TIME.exec(l)?.[0];
    if (t && Number.isFinite(Date.parse(t.replace(' ', 'T')))) at = new Date(t.replace(' ', 'T')).toISOString();
    if (RESULT.test(l)) {
      result = SKIPPED.test(l) ? 'skipped' : FAILED.test(l) ? 'failed' : 'ok';
      line = l.slice(0, 160);
    }
  }
  if (!result && !sha) return { state: 'unknown', why: 'live-state file has no build result' };
  return { state: 'known', result: result ?? 'ok', sha, at, line: line || 'built' };
}

export function readLastBuild(path: string, read: (p: string) => string = p => readFileSync(p, 'utf8')): LastBuild {
  try { return parseLiveState(read(path)); } catch { return { state: 'unknown', why: 'no phm-live-state.txt to read' }; }
}
