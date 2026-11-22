/**
 * Acts on the `phm jobs empty --by-family` labels.
 *
 * - `stop` family: its still-READY exact job ids go into the fleet's retired-ids file, `<runs dir>/queue/RETIRED`
 *   (one id per line; the dispatcher skips every id listed there at launch time).
 * - `reroute` family: a lane-avoid hint row goes into `<runs dir>/queue/lane-avoid.tsv`
 *   (`<lane>\t<family>\t<until unix epoch>\t<reason>`).
 *
 * What was written, and until when, lives in `<runs dir>/queue/empty-family-actions.json`, so `--undo <family>` and
 * expiry remove exactly what this tool added and never an id someone listed by hand. The retired-ids format has no
 * room for an expiry, so expiry is enforced on every apply: expired ids and hints are removed from both files.
 * Guardian and release work is never stopped: a family starting with FIXUP- or containing RELEASE, and any such id.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readEmptyFamilies, type EmptyFamiliesReport } from './empty-families.js';
import { jobFamily } from './slot-yield.js';
import { createConfigReader } from './dynconfig.js';
import { briefFamilyYield } from './leader-compact-brief.js';
import { readLedgerLines } from './ledger-lines.js';
import { ledgerRows } from './empty-cause.js';
import { familyAutoStop, type FamilyAutoStop } from './family-auto-stop.js';
import { parseStopFile } from './stop-file.js';

export const EMPTY_APPLY_SCHEMA = 'jobs.empty.apply.v1';
export const EMPTY_STOP_OFF_KEY = 'empty_stop.off';
export const EMPTY_STOP_TTL_HOURS = 48;
export const EMPTY_STOP_TTL_MAX_HOURS = 168;
const HOUR_MS = 3_600_000;

export interface EmptyActionEntry { family: string; lane: string; action: 'stop' | 'reroute'; ids: string[]; until: number; reason: string }
interface ActionState { schema: 'jobs.empty.actions.v1'; last_run_ms: number | null; entries: EmptyActionEntry[] }

export interface EmptyApplyRow {
  family: string; lane: string; action: 'stop' | 'reroute' | 'skip';
  /** Exact job ids written to the retired-ids file (stop only). */
  ids: string[];
  /** Unix epoch seconds; null for a skipped row. */
  until: number | null; reason: string;
}
export interface EmptyApplyResult {
  schema: typeof EMPTY_APPLY_SCHEMA; version: 1; dry_run: boolean; written: boolean;
  /** False when the by-family report, the queue or a file could not be read: nothing was changed. */
  known: boolean; error: string | null; ttl_hours: number;
  retired_file: string; avoid_file: string;
  rows: EmptyApplyRow[]; expired_removed: number;
}

const paths = (runsDir: string) => {
  const queue = join(runsDir, 'queue');
  return { queue, retired: join(queue, 'RETIRED'), avoid: join(queue, 'lane-avoid.tsv'), state: join(queue, 'empty-family-actions.json'), router: join(queue, 'router-queue.md') };
};

/** Guardian and release work is never stopped. */
export const guardedFamily = (name: string): boolean => name.startsWith('FIXUP-') || name.includes('RELEASE');
/** The bare name `leader` is not a glob: a row for it would block every leader job. */
const bareFamily = (name: string): boolean => name === 'leader';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const READY_LINE = /^- READY ([A-Za-z0-9][A-Za-z0-9._-]*)(.*)$/;

/** Pure: the READY ids in router-queue.md text with the pool each names, when it names one. */
export function readyJobs(routerText: string): Array<{ id: string; pool: string | null }> {
  return routerText.split(/\r?\n/).flatMap(line => {
    const m = READY_LINE.exec(line);
    return m ? [{ id: m[1]!, pool: /\bpool=([A-Za-z0-9._-]+)/.exec(m[2]!)?.[1] ?? null }] : [];
  });
}

/** Pure: what to do for each family row. Rows with nothing to act on are left out. */
export function planEmptyApply(report: EmptyFamiliesReport, ready: ReadonlyArray<{ id: string; pool: string | null }>, now: number, ttlHours: number): EmptyApplyRow[] {
  const until = Math.floor(now / 1000 + ttlHours * 3600);
  const rows: EmptyApplyRow[] = [];
  for (const fam of report.families) {
    if (fam.action !== 'stop' && fam.action !== 'reroute') continue;
    const top = fam.top_reasons[0]?.reason ?? 'unknown';
    const reason = `${fam.empty}of${fam.launches}-empty_${top}`.replace(/\s+/g, '-');
    if (bareFamily(fam.family)) { rows.push({ family: fam.family, lane: fam.lane, action: 'skip', ids: [], until: null, reason: 'bare family name leader is not a glob; it would block every leader job' }); continue; }
    if (guardedFamily(fam.family)) { rows.push({ family: fam.family, lane: fam.lane, action: 'skip', ids: [], until: null, reason: 'guarded: guardian and release work is never stopped' }); continue; }
    if (fam.action === 'reroute') { rows.push({ family: fam.family, lane: fam.lane, action: 'reroute', ids: [], until, reason }); continue; }
    const ids = ready.filter(job => jobFamily(job.id) === fam.family && !guardedFamily(job.id) && (job.pool === null || job.pool === fam.lane)).map(job => job.id);
    rows.push(ids.length ? { family: fam.family, lane: fam.lane, action: 'stop', ids: [...new Set(ids)], until, reason }
      : { family: fam.family, lane: fam.lane, action: 'skip', ids: [], until: null, reason: 'no READY job in this family' });
  }
  return rows;
}

async function readText(path: string): Promise<string | null> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return null;
    return await readFile(path, 'utf8');
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null; }
}

/** Temp file in the same directory, then rename. An existing file keeps its permissions. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const mode = await lstat(path).then(s => s.mode & 0o777, () => 0o644);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
  } catch (error) { await rm(temp, { force: true }); throw error; }
}

function parseState(text: string): ActionState | null {
  if (text === '') return { schema: 'jobs.empty.actions.v1', last_run_ms: null, entries: [] };
  try {
    const raw = JSON.parse(text) as Partial<ActionState>;
    if (raw.schema !== 'jobs.empty.actions.v1' || !Array.isArray(raw.entries)) return null;
    const entries = raw.entries.filter((e): e is EmptyActionEntry => !!e && typeof e.family === 'string' && typeof e.lane === 'string' && (e.action === 'stop' || e.action === 'reroute')
      && Array.isArray(e.ids) && e.ids.every(id => typeof id === 'string' && SAFE_ID.test(id)) && Number.isFinite(e.until) && typeof e.reason === 'string');
    return { schema: raw.schema, last_run_ms: typeof raw.last_run_ms === 'number' ? raw.last_run_ms : null, entries };
  } catch { return null; }
}

const entryKey = (e: Pick<EmptyActionEntry, 'family' | 'lane' | 'action'>): string => `${e.action}\n${e.family}\n${e.lane}`;

/** Pure: the next retired-ids text. Ids in `remove` go; ids in `add` are appended unless already listed. Other lines stay as they are. */
export function nextRetiredText(text: string, remove: ReadonlySet<string>, add: readonly string[]): { text: string; added: string[] } {
  const lines = text.split(/\r?\n/).filter(line => !remove.has(line.trim()));
  const present = new Set(lines.flatMap(line => line.split(/\s+/).filter(Boolean)));
  const added = add.filter(id => !present.has(id));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const out = [...lines, ...added];
  return { text: out.length ? `${out.join('\n')}\n` : '', added };
}

/** Pure: the next lane-avoid text. Rows for `drop` keys go; `add` rows replace any row for the same lane and family. */
export function nextAvoidText(text: string, drop: ReadonlySet<string>, add: readonly EmptyActionEntry[]): string {
  const replaced = new Set(add.map(e => `${e.lane}\t${e.family}`));
  const kept = text.split(/\r?\n/).filter(line => {
    if (!line.trim()) return false;
    const [lane = '', family = ''] = line.split('\t');
    return line.startsWith('#') || !(drop.has(`${lane}\t${family}`) || replaced.has(`${lane}\t${family}`));
  });
  const out = [...kept, ...add.map(e => `${e.lane}\t${e.family}\t${e.until}\t${e.reason}`)];
  return out.length ? `${out.join('\n')}\n` : '';
}

interface Files { retired: string; avoid: string; state: ActionState }

/** Write both files and the state, or throw. Order: files first, state last, so a failed write is retried by the next apply. */
async function commit(runsDir: string, files: Files, retiredText: string, avoidText: string, current: { retired: string; avoid: string }): Promise<void> {
  const p = paths(runsDir);
  await mkdir(p.queue, { recursive: true, mode: 0o700 });
  if (retiredText !== current.retired) await writeAtomic(p.retired, retiredText);
  if (avoidText !== current.avoid) await writeAtomic(p.avoid, avoidText);
  await writeAtomic(p.state, `${JSON.stringify(files.state, null, 2)}\n`);
}

const unknownResult = (runsDir: string, apply: boolean, ttl: number, error: string): EmptyApplyResult => {
  const p = paths(runsDir);
  return { schema: EMPTY_APPLY_SCHEMA, version: 1, dry_run: !apply, written: false, known: false, error, ttl_hours: ttl, retired_file: p.retired, avoid_file: p.avoid, rows: [], expired_removed: 0 };
};

export interface EmptyApplyOptions {
  runsDir: string; apply: boolean; now?: number; hours?: number; ttlHours?: number;
  /** Seam for tests; defaults to the real by-family report. */
  readReport?: (hours: number) => Promise<EmptyFamiliesReport | null>;
  /** Marks the tick's run time so the tick runs at most once an hour. */
  markRun?: boolean;
}

/** Plan the stops and reroutes and, when `apply` is set, write them. Anything unreadable changes nothing. */
export async function applyEmptyFamilies(o: EmptyApplyOptions): Promise<EmptyApplyResult> {
  const now = o.now ?? Date.now(), ttl = o.ttlHours ?? EMPTY_STOP_TTL_HOURS, hours = o.hours ?? 24, p = paths(o.runsDir);
  const [report, routerText, retiredText, avoidText, stateText] = await Promise.all([
    (o.readReport ?? (h => readEmptyFamilies(h, o.runsDir, now)))(hours).catch(() => null),
    readText(p.router), readText(p.retired), readText(p.avoid), readText(p.state),
  ]);
  if (!report) return unknownResult(o.runsDir, o.apply, ttl, 'Empty-job report: unknown (the jobs ledger cannot be read); nothing changed');
  if (routerText === null || retiredText === null || avoidText === null) return unknownResult(o.runsDir, o.apply, ttl, 'Queue files: unknown (a file cannot be read); nothing changed');
  const state = stateText === null ? null : parseState(stateText);
  if (!state) return unknownResult(o.runsDir, o.apply, ttl, 'Action record: unknown (the file cannot be read); nothing changed');

  const rows = planEmptyApply(report, readyJobs(routerText), now, ttl);
  const nowS = now / 1000;
  const expired = state.entries.filter(e => e.until <= nowS);
  const fresh = rows.filter((r): r is EmptyApplyRow & { action: 'stop' | 'reroute'; until: number } => r.action !== 'skip' && r.until !== null)
    .map((r): EmptyActionEntry => ({ family: r.family, lane: r.lane, action: r.action, ids: r.ids, until: r.until, reason: r.reason }));
  const result: EmptyApplyResult = { schema: EMPTY_APPLY_SCHEMA, version: 1, dry_run: !o.apply, written: false, known: true, error: null, ttl_hours: ttl,
    retired_file: p.retired, avoid_file: p.avoid, rows, expired_removed: expired.length };
  if (!o.apply) return result;

  // A fresh entry replaces the live entry for the same family, lane and action; ids it already listed stay listed.
  const freshKeys = new Set(fresh.map(entryKey));
  const live = state.entries.filter(e => e.until > nowS);
  const carried = live.filter(e => !freshKeys.has(entryKey(e)));
  const replacedIds = new Set(live.filter(e => freshKeys.has(entryKey(e))).flatMap(e => e.ids));
  const expiredIds = new Set(expired.flatMap(e => e.ids));
  const retired = nextRetiredText(retiredText, new Set([...expiredIds].filter(id => !carried.some(e => e.ids.includes(id)))), fresh.flatMap(e => e.ids));
  // Record only ids this tool added (or already owned), so undo never removes a hand-listed id.
  const handListed = new Set(retiredText.split(/\s+/).filter(Boolean).filter(id => !replacedIds.has(id) && !expiredIds.has(id)));
  const entries = [...carried, ...fresh.map(e => ({ ...e, ids: e.ids.filter(id => !handListed.has(id)) }))];
  const avoid = nextAvoidText(avoidText, new Set(expired.filter(e => e.action === 'reroute').map(e => `${e.lane}\t${e.family}`)), fresh.filter(e => e.action === 'reroute'));
  try {
    await commit(o.runsDir, { retired: p.retired, avoid: p.avoid, state: { schema: state.schema, last_run_ms: o.markRun ? now : state.last_run_ms, entries } }, retired.text, avoid, { retired: retiredText, avoid: avoidText });
  } catch { return { ...unknownResult(o.runsDir, true, ttl, 'Queue files: could not be written; nothing was marked done'), rows }; }
  return { ...result, written: true };
}

export interface EmptyUndoResult { schema: 'jobs.empty.undo.v1'; version: 1; family: string; known: boolean; error: string | null; removed_ids: string[]; removed_hints: number }

/** Remove what this tool wrote for one family: its retired ids and its lane-avoid hints. Hand-listed ids stay. */
export async function undoEmptyFamily(runsDir: string, family: string): Promise<EmptyUndoResult> {
  const p = paths(runsDir);
  const fail = (error: string): EmptyUndoResult => ({ schema: 'jobs.empty.undo.v1', version: 1, family, known: false, error, removed_ids: [], removed_hints: 0 });
  const [retiredText, avoidText, stateText] = await Promise.all([readText(p.retired), readText(p.avoid), readText(p.state)]);
  const state = stateText === null ? null : parseState(stateText);
  if (retiredText === null || avoidText === null || !state) return fail('Queue files: unknown (a file cannot be read); nothing changed');
  const mine = state.entries.filter(e => e.family === family);
  const keep = state.entries.filter(e => e.family !== family);
  const ids = new Set(mine.flatMap(e => e.ids).filter(id => !keep.some(e => e.ids.includes(id))));
  const hints = mine.filter(e => e.action === 'reroute');
  const retired = nextRetiredText(retiredText, ids, []);
  const avoid = nextAvoidText(avoidText, new Set(hints.map(e => `${e.lane}\t${e.family}`)), []);
  try { await commit(runsDir, { retired: p.retired, avoid: p.avoid, state: { ...state, entries: keep } }, retired.text, avoid, { retired: retiredText, avoid: avoidText }); }
  catch { return fail('Queue files: could not be written; nothing was marked done'); }
  return { schema: 'jobs.empty.undo.v1', version: 1, family, known: true, error: null, removed_ids: [...ids].sort(), removed_hints: hints.length };
}

/** Kill switch: true when off, false when on, null when the live config cannot be read. */
export async function readEmptyStopOff(runsDir: string): Promise<boolean | null> {
  try {
    const resolved = await createConfigReader({ runsDir }).resolve();
    if (resolved.layers.live === 'degraded') return null;
    return resolved.values[EMPTY_STOP_OFF_KEY] === 1;
  } catch { return null; }
}

export interface EmptyApplyTickResult { schema: 'jobs.empty.apply.tick.v1'; ran: boolean; reason: string; result: EmptyApplyResult | null; familyStops?: Omit<FamilyAutoStop, 'pattern'>[] | null }

/** Self-tick stage: apply at most once an hour, and only when the kill switch is off (`phm fleet config set empty_stop.off 1` turns it off). */
export async function runEmptyApplyTick(o: { runsDir: string; apply: boolean; now: number; readOff?: (runsDir: string) => Promise<boolean | null>; readReport?: EmptyApplyOptions['readReport'] }): Promise<EmptyApplyTickResult> {
  const skip = (reason: string): EmptyApplyTickResult => ({ schema: 'jobs.empty.apply.tick.v1', ran: false, reason, result: null });
  const off = await (o.readOff ?? readEmptyStopOff)(o.runsDir);
  if (off !== false) return skip(off === true ? 'empty_stop off' : 'empty_stop state unknown');
  const stateText = await readText(paths(o.runsDir).state);
  const state = stateText === null ? null : parseState(stateText);
  if (!state) return skip('action record unknown');
  if (state.last_run_ms !== null && o.now - state.last_run_ms >= 0 && o.now - state.last_run_ms < HOUR_MS) return skip('ran within the last hour');
  const stopPath = join(paths(o.runsDir).queue, 'family-stop.tsv');
  const lines: string[] = []; let bytes = 0;
  const [known, stopText] = await Promise.all([readLedgerLines(join(o.runsDir, 'metrics/jobs.jsonl'), line => {
    if (ledgerRows(line, o.now, 2).rows.length) { bytes += Buffer.byteLength(line); if (bytes <= 8 * 1024 * 1024) lines.push(line); }
  }), readText(stopPath)]);
  let familyStops: EmptyApplyTickResult['familyStops'] = null;
  if (known && bytes <= 8 * 1024 * 1024 && stopText !== null) {
    const live = parseStopFile(stopText).filter(row => row.until > o.now / 1000);
    const rows = familyAutoStop(briefFamilyYield(lines.join('\n'), o.now), o.now).filter(row => !live.some(s => s.pattern === row.pattern));
    if (o.apply && rows.length) {
      await mkdir(paths(o.runsDir).queue, { recursive: true, mode: 0o700 });
      await writeAtomic(stopPath, stopText + (stopText && !stopText.endsWith('\n') ? '\n' : '') + rows.map(r => `${r.pattern}\t${r.until}\t${r.why}\n`).join(''));
    }
    familyStops = rows.map(({ family, until, why }) => ({ family, until, why }));
  }
  const result = await applyEmptyFamilies({ runsDir: o.runsDir, apply: o.apply, now: o.now, markRun: true, ...(o.readReport ? { readReport: o.readReport } : {}) });
  return { schema: 'jobs.empty.apply.tick.v1', ran: result.known, reason: result.error ?? (o.apply ? 'applied' : 'dry-run'), result, familyStops };
}

/** Plain lines for the CLI. */
export function formatEmptyApply(r: EmptyApplyResult): string[] {
  if (!r.known) return [r.error ?? 'unknown'];
  const hours = (until: number | null) => until === null ? '' : ` until ${new Date(until * 1000).toISOString().slice(0, 16)}Z`;
  const lines = r.rows.length ? r.rows.map(row => row.action === 'stop' ? `STOP ${row.family} (${row.lane}): ${row.ids.length} READY ${row.ids.length === 1 ? 'job' : 'jobs'} retired${hours(row.until)}; ${row.reason}`
    : row.action === 'reroute' ? `AVOID ${row.family} on ${row.lane}${hours(row.until)}; ${row.reason}`
      : `SKIP ${row.family} (${row.lane}): ${row.reason}`) : ['Nothing to stop or reroute.'];
  lines.push(r.dry_run ? 'Dry run: nothing written. Add --apply to write.' : `Written to ${r.retired_file} and ${r.avoid_file}. Undo one family: phm jobs empty --by-family --undo <family>`);
  if (r.expired_removed) lines.push(`${r.expired_removed} expired ${r.expired_removed === 1 ? 'entry' : 'entries'} ${r.dry_run ? 'would be removed' : 'removed'}.`);
  return lines;
}
