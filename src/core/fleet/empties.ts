/**
 * `phm empties`: why jobs finished with no change, for the planner (RQ-EMPTYWHYN17NQ8).
 *
 * Extends the `fleet empties` reader in empty-cause.ts: same ledger rows, same
 * log-tail rules, plus each job's result notes, every finish as the denominator,
 * tokens spent and one next step per reason. Output carries ids, lanes, counts
 * and fixed sentences only: never log or note text. Anything not measured is
 * null (JSON) or "unknown" (text), never zero.
 */
import { join } from 'node:path';
import { classifyEmptyCause, EMPTY_CAUSE_TAIL_LINES, exists, readText, type EmptyCause, type EmptyEvidence } from './empty-cause.js';
import { ledgerFinishes, type EmptiesFinish } from './empty-finishes.js';
import { REASON_LINE, TIMEOUT_EXITS } from './lane-empty-causes.js';

export { finishesIn, ledgerFinishes, type EmptiesFinish } from './empty-finishes.js';

export const EMPTY_REASONS = ['already_on_master', 'no_eligible_target', 'no_diff', 'blocked_tool', 'tool_missing', 'precheck_skip', 'timeout', 'model_error', 'unknown'] as const;
export type EmptyReason = (typeof EMPTY_REASONS)[number];

const LABEL: Record<EmptyReason, string> = {
  already_on_master: 'already on master',
  no_eligible_target: 'no eligible target found',
  no_diff: 'no diff',
  blocked_tool: 'blocked tool',
  tool_missing: 'missing tool',
  precheck_skip: 'precheck skip',
  timeout: 'timeout',
  model_error: 'model limit or error',
  unknown: 'unknown',
};

// The agent's own EMPTY_REASON line (the launcher asks for one) is the best evidence.
const STATED: Record<string, EmptyReason> = {
  'duplicate-landed': 'already_on_master', 'no-change-needed': 'already_on_master',
  blocked: 'blocked_tool', 'prompt-unclear': 'no_eligible_target',
};
// Rule order of empty-cause.ts: a denial outranks the "nothing to do" verdict it often causes.
const BY_CAUSE: ReadonlyArray<readonly [EmptyCause, EmptyReason | null]> = [
  ['precheck_skip', 'precheck_skip'], ['sandbox_denied', 'blocked_tool'], ['tool_missing', 'tool_missing'],
  ['model_error', 'model_error'], ['no_candidate', null], ['timeout', 'timeout'],
];
const ALREADY = /\balready (?:on|in|landed|merged|done|implemented|fixed|covered|shipped|exists)\b|\bno changes? (?:is |are |was |were )?needed\b|\bduplicate of\b|\b(?:existing|open) (?:pr|pull request)\b[^\n]{0,60}\bcover/i;
const NO_TARGET = /\bNO[ _-]CANDIDATE\b|\bno (?:eligible |conflicting |matching |open )?(?:targets?|candidates?|prs?|pull requests?)\b[^\n]{0,30}\b(?:found|left|remain(?:s|ing)?)\b|\bnothing (?:left )?to (?:do|fix|recut|change)\b/i;
const NO_DIFF = /\bno[ _-]diff\b|\bno changes? (?:made|produced)\b|\bnothing to commit\b|\bworking tree clean\b/i;

/** Pure: one reason per empty finish. Notes are read whole; only the log's final lines count (its head echoes the prompt). */
export function classifyEmptyReason(finish: Pick<EmptiesFinish, 'skipped' | 'exitCode' | 'poolError'>, evidence: EmptyEvidence): EmptyReason {
  if (finish.skipped) return 'precheck_skip';
  const tail = evidence.log === null ? null : evidence.log.split(/\r?\n/).slice(-EMPTY_CAUSE_TAIL_LINES).join('\n');
  const texts = [evidence.notes, tail].filter((text): text is string => !!text);
  for (const text of texts) {
    const code = REASON_LINE.exec(text)?.[1];
    if (code) return STATED[code]!;
  }
  if (evidence.timedOut || (finish.exitCode !== null && TIMEOUT_EXITS.has(finish.exitCode))) return 'timeout';
  if (finish.poolError) return 'model_error';
  const already = texts.some(text => ALREADY.test(text));
  const causes = texts.map(text => classifyEmptyCause(text));
  for (const [cause, reason] of BY_CAUSE) {
    if (causes.includes(cause)) return reason ?? (already ? 'already_on_master' : 'no_eligible_target');
  }
  if (already) return 'already_on_master';
  if (texts.some(text => NO_TARGET.test(text))) return 'no_eligible_target';
  return texts.some(text => NO_DIFF.test(text)) ? 'no_diff' : 'unknown';
}

export interface EmptiesCount { name: string; count: number }
export interface EmptiesFamily {
  name: string; finishes: number; empties: number; empty_rate: number;
  /** Recorded tokens from empty finishes only; null when none were measured. */
  wasted_tokens: number | null;
  tokens_unknown_jobs: number;
  recommendation: 'suppress' | 'observe' | 'keep';
}
export interface EmptiesReason {
  reason: EmptyReason; label: string; count: number;
  /** Share of every finish in the window, 0..1. */
  share_of_finishes: number;
  /** Sum over jobs that recorded tokens; null when none did. */
  tokens: number | null;
  tokens_unknown_jobs: number;
  lanes: EmptiesCount[]; prefixes: EmptiesCount[]; examples: string[];
  /** Plain-words action for the planner; null when the reason has no jobs. */
  next_step: string | null;
}
export interface EmptiesReport {
  schema: 'empties.v1';
  since_hours: number;
  metrics_path: string;
  metrics: 'ok' | 'unreadable';
  /** Counts below are null when the metrics file is unreadable. */
  finishes: number | null;
  empties: number | null;
  empty_share: number | null;
  tokens: number | null;
  tokens_unknown_jobs: number | null;
  malformed_lines: number | null;
  notes_missing: number | null;
  /** Top three empty-job families across all reasons in the window; null when unreadable. */
  top_families: EmptiesCount[] | null;
  /** Every reason, most frequent first; empty when the metrics file is unreadable. */
  reasons: EmptiesReason[];
  /** All families, ordered by empty rate, wasted tokens (unknown last), then name. */
  families: EmptiesFamily[];
}

const share = (part: number, total: number): number => Math.round((part / total) * 1000) / 1000;
const ranked = (counts: Map<string, number>): EmptiesCount[] => [...counts]
  .map(([name, count]) => ({ name, count }))
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

/**
 * Pure: job families, largest first. Ids drop their routing prefix (RQ-, PHX-, FIXUP-, CI-);
 * names sharing their first five characters are one family, named by what all of them share:
 * RQ-PHX-RECUTCOREFLEETC518 and RQ-RECUTWEBUIC502 are both RECUT.
 */
export function jobFamilies(ids: readonly string[]): EmptiesCount[] {
  return ranked(new Map([...familyGroups(ids.map(id => ({ id })))].map(([name, jobs]) => [name, jobs.length])));
}

function familyGroups<T extends { id: string }>(jobs: readonly T[]): Map<string, T[]> {
  const nameOf = ({ id }: T) => id.replace(/^(?:(?:RQ|PHX|FIXUP|CI)-)+/, '') || id;
  const groups = new Map<string, T[]>();
  for (const job of jobs) {
    const key = nameOf(job).slice(0, 5);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(job);
  }
  const families = new Map<string, T[]>();
  for (const group of groups.values()) {
    const members = group.map(nameOf);
    let shared = members[0]!;
    for (const member of members) while (!member.startsWith(shared)) shared = shared.slice(0, -1);
    // A cut inside a word reads badly: fall back to the last whole segment.
    const cut = shared.lastIndexOf('-');
    if (cut >= 5 && members.some(m => m.length > shared.length && m[shared.length] !== '-')) shared = shared.slice(0, cut);
    const name = shared.replace(/[-_.\d]+$/, '') || shared;
    families.set(name, [...(families.get(name) ?? []), ...group]);
  }
  return families;
}

function nextStep(reason: EmptyReason, family: string, lane: string, count: number, noNotes: number): string {
  switch (reason) {
    case 'already_on_master': return `Stop queuing ${family} jobs: the work is already on master. Check master before queuing more.`;
    case 'no_eligible_target': return `Stop queuing ${family} jobs: no eligible target is left.`;
    case 'no_diff': return `Review ${family} prompts and result notes to find why workers produced no change.`;
    case 'blocked_tool': return `Fix tool access on lane ${lane} (for example GitHub sign-in), or send ${family} jobs to a lane that has it.`;
    case 'tool_missing': return `Install the required tool on lane ${lane}, or send ${family} jobs to a lane that has it.`;
    case 'precheck_skip': return `Remove ${family} jobs from the queue: the precheck already skips them.`;
    case 'timeout': return `Split ${family} jobs into smaller ones, or raise the time limit on lane ${lane}.`;
    case 'model_error': return `Pause lane ${lane} until its model limit or API error clears, then retry these jobs.`;
    case 'unknown': return `Have workers end an empty run with an EMPTY_REASON line: ${noNotes} of these ${count} left no notes.`;
  }
}

/** Pure: group classified finishes. `ledger` null means the metrics file was unreadable. */
export function buildEmptiesReport(input: {
  ledger: { finishes: EmptiesFinish[]; malformed: number } | null;
  evidence: ReadonlyMap<string, EmptyEvidence>;
  hours: number; metricsPath: string;
}): EmptiesReport {
  const head = { schema: 'empties.v1', since_hours: input.hours, metrics_path: input.metricsPath } as const;
  if (input.ledger === null) {
    return { ...head, metrics: 'unreadable', finishes: null, empties: null, empty_share: null, tokens: null, tokens_unknown_jobs: null, malformed_lines: null, notes_missing: null, top_families: null, reasons: [], families: [] };
  }
  const { finishes, malformed } = input.ledger;
  const empties = finishes.filter(finish => finish.empty);
  const none: EmptyEvidence = { log: null, notes: null, timedOut: false };
  const byReason = new Map<EmptyReason, EmptiesFinish[]>(EMPTY_REASONS.map(reason => [reason, []]));
  const noNotes = (finish: EmptiesFinish) => !finish.skipped && !input.evidence.get(finish.id)?.notes;
  for (const finish of empties) byReason.get(classifyEmptyReason(finish, input.evidence.get(finish.id) ?? none))!.push(finish);
  const tokensOf = (jobs: EmptiesFinish[]) => {
    const known = jobs.filter(job => job.tokens !== null);
    return { tokens: known.length ? known.reduce((sum, job) => sum + job.tokens!, 0) : null, tokens_unknown_jobs: jobs.length - known.length };
  };
  const families = [...familyGroups(finishes)].map(([name, jobs]): EmptiesFamily => {
    const empty = jobs.filter(job => job.empty);
    const { tokens, tokens_unknown_jobs } = tokensOf(empty);
    const rate = empty.length / jobs.length;
    return {
      name, finishes: jobs.length, empties: empty.length, empty_rate: rate,
      wasted_tokens: empty.length ? tokens : 0, tokens_unknown_jobs,
      recommendation: jobs.length < 5 ? 'observe' : rate > 0.6 ? 'suppress' : 'keep',
    };
  }).sort((a, b) => b.empty_rate - a.empty_rate || (b.wasted_tokens ?? -1) - (a.wasted_tokens ?? -1) || a.name.localeCompare(b.name));
  const reasons = EMPTY_REASONS.map((reason): EmptiesReason => {
    const jobs = byReason.get(reason)!;
    const lanes = new Map<string, number>();
    for (const job of jobs) lanes.set(job.lane, (lanes.get(job.lane) ?? 0) + 1);
    const topLanes = ranked(lanes), families = jobFamilies(jobs.map(job => job.id));
    return {
      reason, label: LABEL[reason], count: jobs.length,
      share_of_finishes: jobs.length ? share(jobs.length, finishes.length) : 0,
      ...tokensOf(jobs),
      lanes: topLanes.slice(0, 3), prefixes: families.slice(0, 3), examples: jobs.slice(0, 2).map(job => job.id),
      next_step: jobs.length ? nextStep(reason, families[0]!.name, topLanes[0]!.name, jobs.length, jobs.filter(noNotes).length) : null,
    };
  }).sort((a, b) => b.count - a.count || EMPTY_REASONS.indexOf(a.reason) - EMPTY_REASONS.indexOf(b.reason));
  return {
    ...head, metrics: 'ok', finishes: finishes.length, empties: empties.length,
    empty_share: finishes.length ? share(empties.length, finishes.length) : null,
    ...tokensOf(empties),
    malformed_lines: malformed, notes_missing: empties.filter(noNotes).length,
    top_families: jobFamilies(empties.map(job => job.id)).slice(0, 3), reasons, families,
  };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const percent = (value: number): string => `${Math.round(value * 100)}%`;
const tokenText = (tokens: number | null, unknownJobs: number): string => tokens === null ? 'tokens unknown'
  : `${tokens.toLocaleString('en-US')} tokens${unknownJobs ? ` (${plural(unknownJobs, 'job')} unknown)` : ''}`;

/** Pure: the `--text` view. At most 20 lines: summary, reasons, top three empty families, gaps. */
export function emptiesText(report: EmptiesReport): string[] {
  const window = `the last ${report.since_hours} h`;
  if (report.finishes === null || report.empties === null) return [`Empty finishes in ${window}: unknown. Cannot read the job metrics file ${report.metrics_path}.`];
  if (!report.finishes) return [`No finishes recorded in ${window} (${report.metrics_path}).`];
  const lines = [`Empty finishes in ${window}: ${report.empties} of ${report.finishes} ${report.finishes === 1 ? 'finish' : 'finishes'} (${percent(report.empty_share ?? 0)}), ${tokenText(report.tokens, report.tokens_unknown_jobs ?? 0)}.`];
  for (const reason of report.reasons) {
    if (!reason.count) continue;
    const list = (items: EmptiesCount[]) => items.map(item => `${item.name} ${item.count}`).join(', ');
    lines.push(`${reason.label}: ${plural(reason.count, 'job')}, ${percent(reason.share_of_finishes)} of finishes, ${tokenText(reason.tokens, reason.tokens_unknown_jobs)}. Lanes: ${list(reason.lanes)}. Jobs: ${list(reason.prefixes)}.`);
    lines.push(`  Next: ${reason.next_step}`);
  }
  for (const family of report.families.filter(row => row.empties > 0).slice(0, 3)) {
    const next = family.recommendation === 'suppress' ? 'Suppress new jobs in this family.'
      : family.recommendation === 'observe' ? 'Collect at least five finishes before suppressing.' : 'No suppression recommended.';
    lines.push(`Family ${family.name}: ${family.empties}/${family.finishes} empty (${percent(family.empty_rate)}), wasted ${tokenText(family.wasted_tokens, family.tokens_unknown_jobs)}. ${next}`);
  }
  const gaps: string[] = [];
  if (report.notes_missing) gaps.push(`${plural(report.notes_missing, 'empty job')} left no notes, so their reason comes from the log alone.`);
  if (report.malformed_lines) gaps.push(`${plural(report.malformed_lines, 'metrics line')} could not be read and ${report.malformed_lines === 1 ? 'was' : 'were'} skipped.`);
  if (gaps.length) lines.push(gaps.join(' '));
  for (let i = lines.length - 1; lines.length > 20 && i > 0; i--) {
    if (lines[i]!.startsWith('  Next:')) lines.splice(i - 1, 2, `${lines[i - 1]} ${lines[i]!.trim()}`);
  }
  return lines;
}

const LEDGER_TAIL_BYTES = 32 * 1024 * 1024;
const FILE_TAIL_BYTES = 64 * 1024;

/** Read the metrics file, then each launched empty job's notes, log tail and timeout marker. Read-only; never throws. */
export async function readEmpties(opts: { metricsPath: string; runsDir: string; notesDir: string; hours: number; now: number }): Promise<EmptiesReport> {
  const text = await readText(opts.metricsPath, LEDGER_TAIL_BYTES);
  const ledger = text === null ? null : ledgerFinishes(text, opts.now, opts.hours);
  const evidence = new Map<string, EmptyEvidence>();
  const launched = ledger?.finishes.filter(finish => finish.empty && !finish.skipped) ?? [];
  for (let i = 0; i < launched.length; i += 16) {
    await Promise.all(launched.slice(i, i + 16).map(async ({ id }) => {
      const [notes, log, timedOut] = await Promise.all([
        readText(join(opts.notesDir, id, 'BRIDGE_NOTES.md'), FILE_TAIL_BYTES),
        readText(join(opts.runsDir, `${id}.log`), FILE_TAIL_BYTES),
        exists(join(opts.runsDir, 'queue', 'run', `${id}.timeout`)),
      ]);
      evidence.set(id, { notes, log, timedOut });
    }));
  }
  return buildEmptiesReport({ ledger, evidence, hours: opts.hours, metricsPath: opts.metricsPath });
}

/** Evidence-only EMPTY finish report. Never reads inferred worker logs or calls providers. */
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
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
      const kind = String([row.event, row.type, row.kind].find(v => typeof v === 'string') ?? '').toLowerCase();
      if (!['launch', 'finish', 'outcome', 'empty_done', 'publish', 'published'].includes(kind)) continue;
      const job = label(row.job ?? row.jobId ?? row.job_id ?? row.id), stamp = row.ts ?? row.timestamp ?? row.at ?? row.time ?? row.mergedAt ?? row.closedAt ?? row.recordedAt ?? row.updatedAt;
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
