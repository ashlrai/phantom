/** Evidence-only EMPTY finish report. Never reads inferred worker logs or calls providers. */
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { readSource } from './runs-parked-queue.js';
import { jobPrefix } from './empty-cause.js';
import { sanitizePublicJson } from '../util/public-json.js';

export const EMPTY_FINISH_CAUSES = ['already-done-on-main', 'needed-gh-or-network', 'refused-by-precheck', 'too-fast-to-have-worked', 'scope-unclear', 'unknown'] as const;
export type EmptyFinishCause = typeof EMPTY_FINISH_CAUSES[number];
type Row = Record<string, unknown>;
type Event = { row: Row; job: string; kind: string; at: number; line: number };
type Attempt = { launch?: Event; finishes: Event[]; outcomes: Event[]; published: boolean };
type Group = { family: string; lane: string; finished: number; measured: number; empty: number; emptyRate: number | null };
export interface FleetEmptiesReport {
  schema: 'fleet.empties.v2'; windowHours: number; known: boolean; malformedLines: number; notesMissing: number;
  launches: number | null; finished: number | null; measured: number | null; total: number | null; emptyRate: number | null;
  byCause: Record<EmptyFinishCause, number>; groups: Group[]; topFamilies: { family: string; empty: number }[];
  empties: { job: string; family: string; lane: string; at: string; wallSeconds: number | null; cause: EmptyFinishCause; evidence: string }[];
}
const label = (v: unknown): string => typeof v === 'string' && /^[\w][\w.-]{0,127}$/.test(v) ? v : 'unknown';
const seconds = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const rate = (empty: number, measured: number): number | null => measured ? empty / measured : null;
const affirmative: Partial<Record<EmptyFinishCause, RegExp>> = {
  'already-done-on-main': /^already (?:done|merged|landed) (?:on|in|into) (?:origin\/)?(?:main|master)[.!]?$/i,
  'needed-gh-or-network': /^(?:gh(?: cli)? (?:is )?(?:not installed|not logged in|unavailable)|gh: command not found|network (?:is )?(?:unavailable|blocked)|could not resolve host)[.!]?$/i,
  'refused-by-precheck': /^precheck (?:refused|rejected|skipped|blocked)(?: the job)?[.!]?$/i,
  'scope-unclear': /^(?:task )?scope (?:is |was )?(?:unclear|ambiguous|unspecified)[.!]?$/i,
};
function causeFrom(text: string): EmptyFinishCause[] {
  return text.split(/\r?\n/).flatMap(line => {
    const value = line.trim().replace(/^(?:empty cause|cause|reason):\s*/i, '');
    return EMPTY_FINISH_CAUSES.filter(c => value === c || affirmative[c]?.test(value));
  });
}
/** Only explicit assertions match; negations, generic failures and prompt mentions do not. */
export async function fleetEmpties(
  read: () => Promise<string | null>, hours = 24, now = Date.now(), readNotes: (path: string) => Promise<string | null> = async () => null,
): Promise<FleetEmptiesReport> {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 2160 || !Number.isFinite(now)) throw new RangeError('Invalid hours or time');
  const report: FleetEmptiesReport = { schema: 'fleet.empties.v2', windowHours: hours, known: false, malformedLines: 0, notesMissing: 0,
    launches: null, finished: null, measured: null, total: null, emptyRate: null,
    byCause: Object.fromEntries(EMPTY_FINISH_CAUSES.map(c => [c, 0])) as Record<EmptyFinishCause, number>, groups: [], topFamilies: [], empties: [] };
  const text = await read().catch(() => null);
  if (text === null) return report;
  const events: Event[] = [], seen = new Set<string>(), since = now - hours * 3_600_000;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const row: Row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error();
      const kind = String(row.event ?? '').toLowerCase();
      if (!['launch', 'finish', 'outcome', 'empty_done', 'publish', 'published'].includes(kind)) continue;
      const job = label(row.job ?? row.jobId ?? row.job_id ?? row.id), stamp = row.ts ?? row.timestamp ?? row.at;
      const at = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
      if (job === 'unknown' || !Number.isFinite(at)) throw Error();
      const key = JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
      if (seen.has(key) || at > now) continue;
      seen.add(key); events.push({ row, job, kind, at, line: index + 1 });
    } catch { report.malformedLines++; }
  }
  events.sort((a, b) => a.at - b.at || Number(b.kind === 'launch') - Number(a.kind === 'launch') || a.line - b.line);
  const attempts: Attempt[] = [], current = new Map<string, Map<string, Attempt>>();
  for (const e of events) {
    const lanes = current.get(e.job) ?? new Map<string, Attempt>(), lane = label(e.row.lane);
    if (e.kind === 'launch') for (const [key, prior] of lanes) if (prior.finishes.length || prior.outcomes.length) lanes.delete(key);
    // A missing lane can join only an unambiguous attempt; never borrow another lane's notes or timing.
    let a = lanes.get(lane) ?? (lane === 'unknown' && lanes.size === 1 ? [...lanes.values()][0] : undefined);
    if (!a || e.kind === 'launch') { a = { launch: e.kind === 'launch' ? e : undefined, finishes: [], outcomes: [], published: false }; attempts.push(a); lanes.set(lane, a); current.set(e.job, lanes); }
    if (e.kind === 'finish') a.finishes.push(e);
    if (['outcome', 'empty_done'].includes(e.kind)) a.outcomes.push(e);
    const url = e.row.url ?? e.row.prUrl ?? e.row.pr_url;
    if (['publish', 'published'].includes(e.kind) && typeof url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(url)) a.published = true;
  }
  const groups = new Map<string, Group>(), families = new Map<string, number>();
  report.known = true; report.launches = events.filter(e => e.kind === 'launch' && e.at >= since).length;
  report.finished = 0; report.measured = 0; report.total = 0;
  for (const a of attempts) for (const e of a.finishes.length ? a.finishes : a.outcomes) {
    if (e.at < since) continue;
    const empty = e.row.empty === true || [e.row.state, e.row.outcome, e.row.result, e.kind.toUpperCase()].some(v => v === 'EMPTY' || v === 'EMPTY_DONE');
    if (!empty && e.kind !== 'finish') continue;
    const family = jobPrefix(e.job), lane = label(e.row.lane ?? a.launch?.row.lane), key = JSON.stringify([family, lane]);
    const g = groups.get(key) ?? { family, lane, finished: 0, measured: 0, empty: 0, emptyRate: null };
    g.finished++; report.finished++;
    if (empty || e.row.empty === false || (a.published && a.finishes.length === 1)) { g.measured++; report.measured++; }
    groups.set(key, g);
    if (!empty) continue;
    const wall = seconds(e.row.wall_s) ?? (a.launch && a.finishes.length === 1 ? (e.at - a.launch.at) / 1000 : null);
    const notePath = e.row.notes_path ?? e.row.notesPath ?? a.launch?.row.notes_path ?? a.launch?.row.notesPath;
    const notes = typeof notePath === 'string' ? await readNotes(notePath).catch(() => null) : null;
    if (typeof notePath === 'string' && notes === null) report.notesMissing++;
    const rowCauses = [e.row.cause, e.row.reason].flatMap(v => typeof v === 'string' ? causeFrom(v) : []);
    const causes = [...new Set([...rowCauses, ...causeFrom(notes ?? '')])];
    const conflict = a.published || causes.length > 1 || (causes.includes('too-fast-to-have-worked') && (wall === null || wall >= 60));
    const cause: EmptyFinishCause = conflict ? 'unknown' : causes[0] ?? (wall !== null && wall < 60 ? 'too-fast-to-have-worked' : 'unknown');
    const evidence = conflict ? 'conflicting evidence' : causes.length ? rowCauses.length ? 'metrics reason' : 'result notes' : cause === 'too-fast-to-have-worked' ? 'measured duration' : 'no explicit cause';
    report.empties.push({ job: e.job, family, lane, at: new Date(e.at).toISOString(), wallSeconds: wall, cause, evidence });
    report.byCause[cause]++; report.total++; g.empty++; families.set(family, (families.get(family) ?? 0) + 1);
  }
  report.emptyRate = rate(report.total, report.measured);
  report.groups = [...groups.values()].map(g => ({ ...g, emptyRate: rate(g.empty, g.measured) })).sort((a, b) => b.empty - a.empty || a.family.localeCompare(b.family) || a.lane.localeCompare(b.lane));
  report.topFamilies = [...families].map(([family, empty]) => ({ family, empty })).sort((a, b) => b.empty - a.empty || a.family.localeCompare(b.family)).slice(0, 5);
  report.empties.sort((a, b) => a.at.localeCompare(b.at) || a.job.localeCompare(b.job) || a.lane.localeCompare(b.lane));
  return sanitizePublicJson(report) as FleetEmptiesReport;
}
export async function readFleetEmpties(hours = 24, now = Date.now(), root = join(homedir(), '.ashlr-runs'), jobsPath = join(root, 'metrics', 'jobs.jsonl')): Promise<FleetEmptiesReport> {
  const ledger = await readSource(jobsPath, 64 * 1024 * 1024, false);
  const realRoot = await realpath(root).catch(() => null);
  return fleetEmpties(async () => ledger.state === 'healthy' ? ledger.text : null, hours, now, async path => {
    // Ledger-controlled paths are restricted to this runs directory; notes are never returned.
    const target = resolve(root, path), parent = await realpath(dirname(target)).catch(() => null);
    if (!realRoot || !parent || (parent !== realRoot && !parent.startsWith(realRoot + sep))) return null;
    const note = await readSource(target, 12_000, false);
    if (note.state !== 'healthy') return null;
    // Do not turn a cut-off sentence into an affirmative assertion.
    return note.text.length <= 2999 ? note.text : note.text.slice(0, 2999).replace(/[^\n]*$/, '');
  });
}
export function humanFleetEmpties(r: FleetEmptiesReport): string {
  if (!r.known) return 'Empty jobs: unknown (metrics unavailable)';
  const percent = (n: number | null) => n === null ? 'unknown' : `${(n * 100).toFixed(1)}%`;
  return [`${r.total} empty finishes; empty rate ${percent(r.emptyRate)} (${r.measured} measured finishes; ${r.launches} launches).`,
    `Skipped ${r.malformedLines} malformed rows; ${r.notesMissing} result notes unavailable.`, 'Family | Lane | Empty | Measured | Empty rate',
    ...r.groups.slice(0, 10).map(g => `${g.family} | ${g.lane} | ${g.empty} | ${g.measured} | ${percent(g.emptyRate)}`),
    'Top 5 families by empty launches:', ...r.topFamilies.map(g => `${g.family}: ${g.empty}`),
    ...EMPTY_FINISH_CAUSES.filter(c => r.byCause[c]).map(c => `${c.replaceAll('-', ' ')}: ${r.byCause[c]}`)].join('\n');
}
