/**
 * The job stop file: which job kinds the fleet's precheck turns away before any model call.
 *
 * One row per line, tab-separated: `<ERE on job id>\t<until unix epoch>\t<reason-no-spaces>`.
 * Lines starting with # are comments; rows past their epoch are ignored. `phm jobs yield --stop-file`
 * writes one row per job kind with a stop verdict and marks each with a `# auto:phm-yield` line
 * right after it. Rows and comments without that mark are hand-written and never changed.
 *
 * The path is the `ASHLR_JOBS_STOP_FILE` environment variable (absolute). There is no default: unset is unknown.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { FILLER_ID, jobKind, type JobYieldParts } from './slot-yield.js';

export const STOP_FILE_SCHEMA = 'jobs.stop-file.v1';
export const STOP_FILE_ENV = 'ASHLR_JOBS_STOP_FILE';
export const STOP_MARK = '# auto:phm-yield';
export const STOP_TTL_HOURS = 24;
export const STOP_TTL_MAX_HOURS = 72;

export interface StopRow { pattern: string; until: number; reason: string; auto: boolean }
export interface StopEmit { family: string; pattern: string; until: number; reason: string }
/** One line of the "Stopped families" list. `family` is the pattern for a hand-written row. */
export interface StoppedFamily { family: string; why: string; until: number; expires_in_s: number; auto: boolean }

/** Null when no path is set: the stop file is then unknown, never guessed. */
export function stopFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env[STOP_FILE_ENV];
  return typeof path === 'string' && isAbsolute(path) ? path : null;
}

const escapeEre = (text: string): string => text.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');
/** Endings tried against a candidate pattern: every one it accepts must belong to the same job kind. */
const PROBES = ['', '5', '55', 'C5', '5X', '5Q8', '17HQ8', '17AQ8', 'Q8', 'N17HQ8', '-1', '-N17', '3-N17', '3A111800Q8', 'C5Q8', '5-1Q8', 'C5N17HQ8'];

/**
 * An anchored ERE for the ids `jobKind` maps to this kind: the kind, then the counters `jobKind` drops
 * (a glued cycle, a `-<digits>` sequence, a Q8 queue stamp). It leans narrow: an id it misses still launches,
 * while an id it wrongly matched would be stopped. Filler kinds are named by repo, so their pattern comes from
 * the repo codes in the ids seen. Null when no pattern is safe.
 */
export function familyPattern(family: string, ids: readonly string[] = []): string | null {
  if (family.startsWith('one-test filler ')) {
    const codes = [...new Set(ids.flatMap(id => FILLER_ID.exec(id)?.[1] ?? []))].sort();
    return codes.length ? `^RQ-(${codes.join('|')})[0-9]+A[0-9]+Q8$` : null;
  }
  if (!/^[A-Za-z0-9][\w.:@/-]*[A-Za-z0-9]$/.test(family) || jobKind(family) !== family) return null;
  // A kind ending in N, or shaped like a filler prefix, could swallow a neighbour's ids through the digit form.
  const glued = /N$|^RQ-[A-Z]+$/.test(family) ? 'C[0-9]+'
    : /[A-Za-z]C$/.test(family) ? 'C[0-9]+|[0-9]+[A-Za-z][A-Za-z0-9]*' : 'C[0-9]+|[0-9][A-Za-z0-9]*';
  const pattern = `^${escapeEre(family)}(${glued})?(-N?[0-9]+)?((N[0-9]+[A-Z]?)?Q8)?$`;
  const test = new RegExp(pattern);
  return PROBES.every(end => !test.test(family + end) || jobKind(family + end) === family) ? pattern : null;
}

/** One row per stop verdict. A kind with no safe pattern, or one that would match another kind's job, is listed in `unsafe` instead. */
export function stopRows(parts: JobYieldParts, now: number, ttlHours = STOP_TTL_HOURS): { rows: StopEmit[]; unsafe: { family: string; why: string }[] } {
  const rows: StopEmit[] = [], unsafe: { family: string; why: string }[] = [];
  const until = Math.floor(now / 1000 + ttlHours * 3600);
  for (const row of parts.report.families) {
    if (row.verdict !== 'stop') continue;
    const pattern = familyPattern(row.family, parts.ids.get(row.family));
    const test = pattern ? new RegExp(pattern) : null;
    const other = test && [...parts.ids].find(([family, ids]) => family !== row.family && ids.some(id => test.test(id)))?.[0];
    if (!pattern || !test) unsafe.push({ family: row.family, why: 'no safe pattern for this job kind' });
    else if (other) unsafe.push({ family: row.family, why: `its pattern would also stop ${other}` });
    else if (!(parts.ids.get(row.family) ?? []).some(id => test.test(id))) unsafe.push({ family: row.family, why: 'its pattern matches none of its own jobs' });
    else rows.push({ family: row.family, pattern, until, reason: `${row.family.replace(/\s+/g, '-')}_${row.merged}of${row.launches}` });
  }
  return { rows, unsafe };
}

const parseRow = (line: string): Omit<StopRow, 'auto'> | null => {
  const [pattern, until, reason = ''] = line.split('\t');
  return !pattern || line.startsWith('#') || !/^\d+$/.test(until ?? '') ? null : { pattern, until: Number(until), reason: reason.trim() };
};

export function parseStopFile(text: string): StopRow[] {
  const lines = text.split(/\r?\n/);
  return lines.flatMap((line, i) => { const row = parseRow(line); return row ? [{ ...row, auto: lines[i + 1]?.trim() === STOP_MARK }] : []; });
}

export interface StopFilePlan { text: string; kept_hand: number; kept_auto: number; dropped_expired: number }

/**
 * The next file text. Hand-written lines stay exactly as they are. Tool rows are rebuilt: expired ones go,
 * live ones stay until they expire unless a new row for the same pattern replaces them, and a pattern a live
 * hand-written row already stops is not written twice.
 */
export function planStopFile(text: string, rows: readonly StopEmit[], now: number): StopFilePlan {
  const lines = text.split(/\r?\n/), nowS = now / 1000, hand: string[] = [], auto = new Map<string, string>();
  const fresh = new Set(rows.map(row => row.pattern)), handLive = new Set<string>();
  let keptHand = 0, droppedExpired = 0;
  for (let i = 0; i < lines.length; i++) {
    const row = parseRow(lines[i]!);
    if (row && lines[i + 1]?.trim() === STOP_MARK) {
      if (row.until <= nowS) droppedExpired++;
      else if (!fresh.has(row.pattern)) auto.set(row.pattern, lines[i]!);
      i++;
      continue;
    }
    if (row) { keptHand++; if (row.until > nowS) handLive.add(row.pattern); }
    hand.push(lines[i]!);
  }
  while (hand.length && !hand[hand.length - 1]!.trim()) hand.pop();
  const keptAuto = auto.size;
  for (const row of rows) if (!handLive.has(row.pattern)) auto.set(row.pattern, `${row.pattern}\t${row.until}\t${row.reason}`);
  const out = [...hand, ...[...auto.values()].flatMap(line => [line, STOP_MARK])];
  return { text: out.length ? `${out.join('\n')}\n` : '', kept_hand: keptHand, kept_auto: keptAuto, dropped_expired: droppedExpired };
}

/** The file text; '' when there is no file yet, null when it cannot be read. */
export async function readStopFileText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null; }
}

/** Temp file in the same directory, then rename, so a reader never sees half a file. */
export async function writeStopFile(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  try { await writeFile(temp, text, { mode: 0o600 }); await rename(temp, path); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}

/** Rows not yet past their epoch. Null when no path is set or the file cannot be read: unknown, not empty. */
export async function readLiveStops(path: string | null, now: number): Promise<StopRow[] | null> {
  const text = path === null ? null : await readStopFileText(path);
  return text === null ? null : parseStopFile(text).filter(row => row.until > now / 1000);
}

/** The first live row whose pattern matches one of the ids. A pattern JavaScript cannot read never stops anything here. */
export function stoppedBy(rows: readonly StopRow[], ids: readonly string[]): StopRow | null {
  return rows.find(row => { try { const test = new RegExp(row.pattern); return ids.some(id => test.test(id)); } catch { return false; } }) ?? null;
}

/** Tool rows carry `<family>_<merged>of<launches>`; a hand-written row shows its pattern and its own reason. */
export function stoppedFamilies(rows: readonly StopRow[], now: number): StoppedFamily[] {
  return rows.map(row => {
    const made = row.auto ? /^(.+)_(\d+)of(\d+)$/.exec(row.reason) : null;
    return { family: made ? made[1]! : row.pattern, why: made ? `${made[2]} merged from ${made[3]} launches` : row.reason || 'unknown',
      until: row.until, expires_in_s: Math.max(0, Math.round(row.until - now / 1000)), auto: row.auto };
  });
}
