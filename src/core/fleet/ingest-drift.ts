/**
 * core/fleet/ingest-drift.ts: does the host ingest still match our copy?
 *
 * drop-job-writer.ts mirrors three things from `~/.ashlr-runs/bin/orch-ingest.py`:
 * its job header pattern (HEAD), its job id pattern (ID) and its lane list
 * (LANES). This reads that file as plain text (never runs it), pulls those
 * three out, and says "match", "drift: <field>" or "unknown: <reason>".
 * Read-only; the host file is never written.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DROP_JOB_LANES, INGEST_JOB_HEADER, INGEST_JOB_ID } from './drop-job-writer.js';

export type IngestDriftField = 'HEAD' | 'ID' | 'LANES';
/** `match`, `drift: <field>` or `unknown: <reason>`: the whole answer in one string. */
export type IngestDriftVerdict = 'match' | `drift: ${IngestDriftField}` | `unknown: ${string}`;

export interface IngestDriftReport {
  verdict: IngestDriftVerdict;
  /** Every field compared, with what each side holds. Empty when unknown. */
  fields: Array<{ field: IngestDriftField; ours: string; host: string; same: boolean }>;
}

/** The verdict for a host with no ingest file (not a problem: just unknown). */
export const INGEST_MISSING: IngestDriftVerdict = 'unknown: orch-ingest.py not found';

/** Where the host ingest lives; ASHLR_RUNS_DIR moves it like every runs reader. */
export function defaultIngestPath(): string {
  return join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'bin', 'orch-ingest.py');
}

/** Count rebinding forms too, so an unsupported override cannot look like a match. */
function assignments(text: string, name: string): number {
  return (text.match(new RegExp(`\\b${name}\\b[ \t]*(?:=|:|,|[-+*/%&|^]=)`, 'g')) ?? []).length;
}

/** Recognise complete static assignments only; never evaluate Python expressions. */
function patternOf(text: string, name: string): string | null {
  const lines = text.split('\n').filter(line => new RegExp(`\\b${name}\\b[ \t]*=`).test(line));
  if (assignments(text, name) !== 1) return null;
  if (lines.length !== 1) return null;
  const m = new RegExp(String.raw`^${name}[ \t]*=[ \t]*(re\.compile\([ \t]*)?([rR]?)(["'])((?:\\.|[^\\'"\r\n])*?)\3[ \t]*(\))?[ \t]*(?:#.*)?$`).exec(lines[0]!);
  if (!m || Boolean(m[1]) !== Boolean(m[5]) || (!m[2] && m[4]!.includes('\\'))) return null;
  return m[4]!;
}

/** `LANES = ('a', 'b')` (tuple, list or set): the quoted names, sorted. */
function lanesOf(text: string): string[] | null {
  if (assignments(text, 'LANES') !== 1) return null;
  const m = /^LANES[ \t]*=[ \t]*([(\[{])([^()[\]{}\r\n]*)([)\]}])[ \t]*(?:#.*)?$/m.exec(text);
  if (!m) return null;
  if (m[3] !== ({ '(': ')', '[': ']', '{': '}' }[m[1]!])) return null;
  const tokens = m[2]!.replace(/(['"])[a-z-]+\1/g, 'Q');
  if (!/^\s*(Q\s*,\s*)*(Q\s*,?\s*)?$/.test(tokens)) return null;
  const names = [...m[2]!.matchAll(/(['"])([a-z-]+)\1/g)].map(x => x[2]!);
  return names.length > 0 && new Set(names).size === names.length ? names.sort() : null;
}

/** Refuse continued/mismatched containers without interpreting Python. */
function singleLineContainers(source: string): boolean {
  const skeleton = source.replace(/(["'])(?:\\.|(?!\1)[^\\\r\n])*\1|#[^\r\n]*/g, '');
  return skeleton.split('\n').every(line => {
    const stack: string[] = [];
    for (const char of line) {
      if ('([{'.includes(char)) stack.push(char);
      if (')]}'.includes(char) && stack.pop() !== ({ ')': '(', ']': '[', '}': '{' }[char])) return false;
    }
    return stack.length === 0;
  });
}

/** Compare already-read ingest source with our contract. Pure. */
export function compareIngestSource(source: string): IngestDriftReport {
  // Multiline strings and continued statements require a Python parser. Refuse
  // those forms rather than interpreting quoted/commented assignments as code.
  if (/'''|"""|\\\r?\n/.test(source) || !singleLineContainers(source)) return { verdict: 'unknown: unsupported Python source form', fields: [] };
  const head = patternOf(source, 'HEAD');
  const id = patternOf(source, 'ID');
  const lanes = lanesOf(source);
  const missing = [head === null ? 'HEAD' : '', id === null ? 'ID' : '', lanes === null ? 'LANES' : ''].filter(Boolean);
  if (missing.length > 0) return { verdict: `unknown: ${missing.join(', ')} not found in orch-ingest.py`, fields: [] };
  const fields: IngestDriftReport['fields'] = [
    { field: 'HEAD', ours: INGEST_JOB_HEADER.source, host: head!, same: head === INGEST_JOB_HEADER.source },
    { field: 'ID', ours: INGEST_JOB_ID.source, host: id!, same: id === INGEST_JOB_ID.source },
    { field: 'LANES', ours: [...DROP_JOB_LANES].sort().join(','), host: lanes!.join(','), same: lanes!.join(',') === [...DROP_JOB_LANES].sort().join(',') },
  ];
  const drifted = fields.find((f) => !f.same);
  return { verdict: drifted ? `drift: ${drifted.field}` : 'match', fields };
}

/**
 * Read the host ingest (default `<runs>/bin/orch-ingest.py`) and compare.
 * A missing or unreadable file is "unknown", never an error.
 */
export function checkIngestDrift(path: string = defaultIngestPath()): IngestDriftReport {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { verdict: code === 'ENOENT' ? INGEST_MISSING : 'unknown: orch-ingest.py unreadable', fields: [] };
  }
  return compareIngestSource(source);
}
