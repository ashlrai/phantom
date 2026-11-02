import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';

export interface RefSegment {
  kind: 'text' | 'job' | 'pr';
  value: string;
  repo?: string;
  number?: number;
}

export interface RefOptions {
  prefixes?: readonly string[];
  defaultRepo?: string;
}

export function pullUrl(repo: string, number: number): string | null {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(number) || number <= 0) return null;
  const [owner, name] = repo.split('/');
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return null;
  return `https://github.com/${owner}/${name}/pull/${number}`;
}

/** Split references without changing any of the original text. Repo context resets on each line. */
export function splitRefs(text: string, opts: RefOptions = {}): RefSegment[] {
  const segments: RefSegment[] = [];
  const prefixes = opts.prefixes ?? ['RQ-', 'LAND-', 'FIX-'];
  const defaultRepo = opts.defaultRepo ?? 'ashlrai/phantom';
  let repo: string | undefined;
  let cursor = 0;
  // Scan whole words and paths so a suffix of an invalid path or job cannot become a reference.
  const tokens = /\n|(?<![A-Za-z0-9_./-])[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*|(?<![A-Za-z0-9_./-])[A-Za-z0-9_.-]+|(?<![A-Za-z0-9_#])#\d+(?![A-Za-z0-9_]|\.\d)/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === '\n') { repo = undefined; continue; }
    if (token.includes('/')) { repo = token; continue; }
    let segment: RefSegment | undefined;
    let value = token;
    if (token.startsWith('#')) {
      const number = Number(token.slice(1));
      const selectedRepo = repo ?? defaultRepo;
      if (pullUrl(selectedRepo, number)) segment = { kind: 'pr', value: token, repo: selectedRepo, number };
    } else {
      // A terminal full stop is sentence punctuation; internal dots remain part of an ID.
      value = token.replace(/\.+$/, '');
      if (prefixes.some(prefix => value.startsWith(prefix)) && JOB_ID_RE.test(value)) segment = { kind: 'job', value };
    }
    if (!segment) continue;
    const index = match.index;
    if (index > cursor) segments.push({ kind: 'text', value: text.slice(cursor, index) });
    segments.push(segment);
    cursor = index + value.length;
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) });
  return segments;
}
