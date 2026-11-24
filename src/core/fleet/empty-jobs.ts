import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ledgerFinishes, type EmptiesFinish } from './empties.js';
import { jobFamily } from './slot-yield.js';
import { summarizeEmptyDigest, type EmptyDigest, type EmptyDigestInput } from './empty-digest.js';
import { tagEmpty, summarizeEmptyTags, type EmptyTagsReport, type TaggedEmptyJob } from './empty-tags.js';
import { classifyFinalEmpty, summarizeFinalEmpty, type FinalEmptyJob, type FinalEmptyReport } from './empty-final-reason.js';
import { scrubSecrets } from '../util/scrub.js';
import type { DecideInput, DecideResult } from '../decide/options.js';
import { classifyEmptyLog, diagnoseEmptyJob, EMPTY_JOB_REASONS, EMPTY_JOB_SUGGESTIONS, FLEET_EMPTY_WHY_LOG_LINES, FLEET_EMPTY_WHY_REASONS, type EmptyJobDiagnosis, type FleetEmptyWhyReason } from './empty-why-classify.js';
export { classifyEmptyLog, FLEET_EMPTY_WHY_LOG_LINES, FLEET_EMPTY_WHY_REASONS, type FleetEmptyWhyReason } from './empty-why-classify.js';

export const EMPTY_CLASSES = ['duplicate', 'already-done', 'too-broad', 'tests-timeout', 'blocked-by-env', 'missing-input', 'scope-too-cautious', 'other'] as const;
export type EmptyClass = typeof EMPTY_CLASSES[number];
export type EmptyJobOutcome = 'already-implemented' | 'duplicate' | 'failed' | 'empty' | 'unknown';
/** `source: 'decide'` marks a class picked by a model (ASHLR_EMPTY_DECIDE=1) rather than a rule. It is advisory: retry planners skip it. */
export interface EmptyJobResult { id: string; lane: string; class: EmptyClass; reason: string; outcome?: EmptyJobOutcome; source?: 'decide' }
export interface EmptyCause { class: EmptyClass; label: string; count: number; exampleJob: string }
export interface EmptyJobReason { id: string; lane: string; reason: FleetEmptyWhyReason }
/** The `fleet empty-why` log-tail tags for the newest empty jobs (the CLI's classifier, shared). */
export interface EmptyJobsReasons { by_reason: Record<FleetEmptyWhyReason, number>; recent: EmptyJobReason[] }
/** `reasons` is optional so the desktop panel still reads an older server's report. */
export interface EmptyJobsReport { schema: 'jobs.empty.v1'; hours: number; total: number; counts: Record<EmptyClass, number>; jobs: EmptyJobResult[]; topCauses: EmptyCause[]; reasons?: EmptyJobsReasons; diagnosis?: EmptyDiagnosisReport; /** Why each job said it stopped, per lane (empty-final-reason.ts). */ final?: FinalEmptyReport; /** Five plain tags per empty job, the empty rate and one example per tag (empty-tags.ts). */ tags?: EmptyTagsReport; /** Empty jobs grouped by plain reason with lanes and examples (empty-digest.ts); what `--by` prints. */ digest?: EmptyDigest; /** The tag of every empty job, oldest first; what `--record` stores. */ tagged?: TaggedEmptyJob[] }
export interface DiagnosedEmptyJob { id: string; lane: string; family: string; reason: EmptyJobDiagnosis }
export interface EmptyDiagnosisGroup { name: string; total: number; topReason: EmptyJobDiagnosis; suggestion: string }
export interface EmptyDiagnosisReport { jobs: DiagnosedEmptyJob[]; families: EmptyDiagnosisGroup[]; lanes: EmptyDiagnosisGroup[] }
export type EmptyJobsReader = (path: string, maxBytes?: number) => Promise<string | null>;
/** The option form of `decide` (core/decide), injectable for tests. */
export type EmptyDecider = (input: DecideInput) => Promise<Pick<DecideResult, 'choice'>>;
/** Off by default. Set to 1 to let `decide` class the empty jobs no rule matched. */
export const EMPTY_DECIDE_ENV = 'ASHLR_EMPTY_DECIDE';
/** Model calls per report: the newest unmatched jobs only. Answers are kept per job for the life of the process. */
export const EMPTY_DECIDE_LIMIT = 5;
const NO_RULE_MATCHED = 'No known reason found.';
const decided = new Map<string, EmptyClass | null>();

function groupDiagnoses(jobs: DiagnosedEmptyJob[], key: 'family' | 'lane'): EmptyDiagnosisGroup[] {
  const groups = new Map<string, DiagnosedEmptyJob[]>();
  for (const job of jobs) {
    const members = groups.get(job[key]) ?? [];
    members.push(job);
    groups.set(job[key], members);
  }
  return [...groups].map(([name, members]) => {
    const counts = EMPTY_JOB_REASONS.map(reason => ({ reason, count: members.filter(job => job.reason === reason).length }));
    // Stable reason-list order breaks ties, including unknown.
    const topReason = counts.sort((a, b) => b.count - a.count)[0]!.reason;
    return { name, total: members.length, topReason, suggestion: EMPTY_JOB_SUGGESTIONS[topReason] };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

const REASON_LOG_LIMIT = 50;
const REASON_RECENT_LIMIT = 20;

const labels: Record<EmptyClass, string> = { duplicate: 'Duplicate of an earlier job', 'already-done': 'Work already done', 'too-broad': 'Scope too broad', 'tests-timeout': 'Tests slow or timed out', 'blocked-by-env': 'Tool or environment problem', 'missing-input': 'Missing input', 'scope-too-cautious': 'Scope or approval', other: 'Unknown reason' };

// Return fixed descriptions: notes and logs may contain private information.
const rules: ReadonlyArray<readonly [EmptyClass, string, RegExp]> = [
  ['duplicate', 'The job duplicated an earlier job.', /\bduplicate(?:d)? (?:of )?(?:an? |the )?(?:earlier |previous |existing )?(?:job|task|request)\b|\b(?:job|task|request) (?:is |was )?(?:a )?duplicate\b|\b(?:existing|open) (?:pr|pull request)\b[^\n]{0,80}\bcovers?\b|\bcovered by (?:an? )?(?:existing |open )?(?:pr|pull request)\b/i],
  ['already-done', 'Work was already completed or covered.', /no change(?:s)? (?:is |are |was |were )?needed|already (?:done|implemented|completed|fixed|merged|covered|shipped|exists)|already (?:on|in) (?:origin\/)?(?:master|main)\b/i],
  ['too-broad', 'The task was too broad.', /\b(?:too broad|scope too (?:large|broad)|task is too large)\b/i],
  ['tests-timeout', 'Tests were slow or timed out.', /(?:tests?|test suite).{0,80}(?:slow|timed?\s*out|timeout)|(?:timed?\s*out|timeout).{0,80}(?:tests?|test suite)/i],
  ['blocked-by-env', 'A tool or environment problem blocked the work.', /\bEPERM\b|\bEACCES\b|permission denied|command not found|(?:tool|dependency|binary|executable).{0,30}(?:missing|unavailable|not found)|timed?\s*out|timeout|network (?:unavailable|error)|rate limit/i],
  ['missing-input', 'Required input was unavailable.', /missing (?:input|context|information|file|credentials?|data)|(?:need|needs|requires?|awaiting|waiting for) (?:user |owner |human )?(?:input|clarification|information|credentials?|access|approval)|(?:no|without) (?:access|input|context)/i],
  ['scope-too-cautious', 'The job stopped over scope or approval.', /(?:out(?:side)? of|beyond) (?:the )?scope|scope (?:extension|is unclear|was unclear)|(?:approval|permission|confirmation) (?:is )?(?:required|needed)|(?:cannot|can't|unable to) (?:proceed|continue) without/i],
];
const FAILED = /\b(?:tests?|test suite|build|typecheck|tsc|lint|command|tool)\s+(?:(?:has|have|had)\s+)?(?:failed|crashed)\b/i;
const NO_DIFF = /\bno (?:diff|changes? (?:made|produced))\b|\bnothing to commit\b|\bworking tree clean\b/i;
const FAILED_CLASSES = new Set<EmptyClass>(['tests-timeout', 'blocked-by-env', 'missing-input']);

/** Outcome is separate from the legacy cause classes; absent evidence stays unknown. */
export function classifyEmpty(notes: string | null, log: string | null, finish?: Pick<EmptiesFinish, 'exitCode' | 'poolError'>): Pick<EmptyJobResult, 'class' | 'reason' | 'outcome'> {
  if (finish?.poolError) return { class: 'blocked-by-env', reason: 'A provider error blocked the work.', outcome: 'failed' };
  const failed = finish?.exitCode != null && finish.exitCode !== 0;
  for (const text of [notes, log?.split(/\r?\n/).slice(-FLEET_EMPTY_WHY_LOG_LINES).join('\n')]) {
    if (!text) continue;
    const asserted = text.replace(/\b(?:not|never)\s+(?:already\s+)?(?:done|implemented|completed|fixed|merged|covered|shipped)\b|\b(?:does not|doesn't|cannot|can't) cover\b/gi, '');
    for (const [kind, reason, pattern] of rules) {
      if (!pattern.test(asserted)) continue;
      if ((failed || FAILED.test(text)) && !FAILED_CLASSES.has(kind)) continue;
      const outcome: EmptyJobOutcome = kind === 'duplicate' ? 'duplicate' : kind === 'already-done' ? 'already-implemented'
        : FAILED_CLASSES.has(kind) ? 'failed' : 'unknown';
      return { class: kind, reason, outcome };
    }
    if (!failed && FAILED.test(text)) return { class: 'other', reason: 'The run failed without a publishable change.', outcome: 'failed' };
    if (!failed && NO_DIFF.test(text)) return { class: 'other', reason: 'The run produced no change.', outcome: 'empty' };
  }
  return { class: 'other', reason: failed ? 'The run failed without a publishable change.' : notes || log ? NO_RULE_MATCHED : 'Notes and log were unavailable.',
    outcome: failed ? 'failed' : finish?.exitCode === 0 ? 'empty' : 'unknown' };
}

/**
 * Behind the flag only: ask `decide` to pick a class for the newest jobs whose notes and log matched no rule.
 * "unknown", an unlisted answer or a failed call leaves the rule's answer in place. The reason stays a fixed sentence.
 */
async function decideUnmatched(jobs: EmptyJobResult[], evidence: ReadonlyMap<string, string>, decider?: EmptyDecider): Promise<void> {
  const ask: EmptyDecider = decider ?? (async input => (await import('../decide/decide.js')).decide(input));
  const options = EMPTY_CLASSES.filter(kind => kind !== 'other');
  const meanings = options.map(kind => `${kind}: ${labels[kind]}`).join('\n');
  if (decided.size > 1000) decided.clear();
  for (const job of jobs.filter(row => row.class === 'other' && row.reason === NO_RULE_MATCHED).slice(-EMPTY_DECIDE_LIMIT)) {
    if (!decided.has(job.id)) {
      const choice = await ask({ question: 'Why did this job finish with no change?', options, use: 'empty-job-class',
        context: `What each option means:\n${meanings}\n\nThe job's notes and log tail:\n${scrubSecrets(evidence.get(job.id) ?? '')}` }).then(result => result.choice, () => null);
      decided.set(job.id, options.find(kind => kind === choice) ?? null);
    }
    const kind = decided.get(job.id);
    if (kind) Object.assign(job, { class: kind, reason: rules.find(rule => rule[0] === kind)![1], source: 'decide' });
  }
}

async function tail(path: string, size: number): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return null; } finally { await file?.close(); }
}

export async function readEmptyJobs(hours = 24, root = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs'), worktrees = process.env.ASHLR_WT_DIR?.trim() || join(homedir(), 'Projects/ashlrai/wt'), now = Date.now(), options: { read?: EmptyJobsReader; family?: string; lane?: string; /** Include the matched sentence in `final` examples. Off by default: logs can hold private text; only the CLI asks. */ quote?: boolean; decide?: boolean; decider?: EmptyDecider } = {}): Promise<EmptyJobsReport | null> {
  const reader: EmptyJobsReader = options.read ?? ((path, max) => max ? tail(path, max) : readFile(path, 'utf8'));
  const read: EmptyJobsReader = (path, max) => reader(path, max).catch(() => null);
  const ledger = await read(join(root, 'metrics/jobs.jsonl'));
  if (ledger === null) return null;
  const finishes = ledgerFinishes(ledger, now, hours).finishes;
  const selected = finishes.filter(job => job.empty &&
    (!options.family || jobFamily(job.id) === jobFamily(options.family)) && (!options.lane || job.lane === options.lane));
  const jobs: EmptyJobResult[] = [];
  const logs = new Map<string, string | null>();
  const evidence = new Map<string, string>();
  const diagnoses = new Map<string, DiagnosedEmptyJob>();
  const finals = new Map<string, FinalEmptyJob>();
  const emptyTags = new Map<string, TaggedEmptyJob>();
  const digestInputs = new Map<string, EmptyDigestInput>();
  for (let offset = 0; offset < selected.length; offset += 16) {
    const batch = selected.slice(offset, offset + 16);
    jobs.push(...await Promise.all(batch.map(async job => {
      const [notes, log, publish] = await Promise.all([read(join(worktrees, job.id, 'BRIDGE_NOTES.md'), 65536), read(join(root, `${job.id}.log`), 65536), read(join(root, `${job.id}.publish`), 65536)]);
      logs.set(job.id, log);
      digestInputs.set(job.id, { id: job.id, lane: job.lane, log, publish });
      emptyTags.set(job.id, { id: job.id, lane: job.lane, tag: tagEmpty(log).tag });
      finals.set(job.id, { id: job.id, lane: job.lane, verdict: options.quote ? classifyFinalEmpty(log) : { ...classifyFinalEmpty(log), sentence: null } });
      evidence.set(job.id, [notes?.slice(0, 4000), log?.split(/\r?\n/).slice(-FLEET_EMPTY_WHY_LOG_LINES).join('\n').slice(-4000)].filter(Boolean).join('\n\n'));
      diagnoses.set(job.id, { id: job.id, lane: job.lane, family: jobFamily(job.id), reason: diagnoseEmptyJob(log, publish) });
      return { id: job.id, lane: job.lane, ...classifyEmpty(notes, log, job) };
    })));
  }
  if (options.decide ?? process.env[EMPTY_DECIDE_ENV] === '1') await decideUnmatched(jobs, evidence, options.decider);
  const counts: Record<EmptyClass, number> = { duplicate: 0, 'already-done': 0, 'too-broad': 0, 'tests-timeout': 0, 'blocked-by-env': 0, 'missing-input': 0, 'scope-too-cautious': 0, other: 0 };
  for (const job of jobs) counts[job.class]++;
  const topCauses = EMPTY_CLASSES.filter(kind => counts[kind] > 0)
    .map(kind => ({ class: kind, label: labels[kind], count: counts[kind], exampleJob: jobs.find(job => job.class === kind)!.id }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 5);
  // The ledger is chronological, so the newest jobs are last. A missing or unreadable log reads as null, which is `other`.
  const by_reason = Object.fromEntries(FLEET_EMPTY_WHY_REASONS.map(r => [r, 0])) as Record<FleetEmptyWhyReason, number>;
  const tagged = jobs.slice(-REASON_LOG_LIMIT).map(({ id, lane }) => ({ id, lane, reason: classifyEmptyLog(logs.get(id) ?? null) }));
  for (const t of tagged) by_reason[t.reason]++;
  const recent = tagged.slice(-REASON_RECENT_LIMIT).reverse();
  const diagnosed = [...diagnoses.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { schema: 'jobs.empty.v1', hours, total: jobs.length, counts, jobs, topCauses, reasons: { by_reason, recent },
    diagnosis: { jobs: diagnosed, families: groupDiagnoses(diagnosed, 'family'), lanes: groupDiagnoses(diagnosed, 'lane') },
    final: summarizeFinalEmpty(selected.flatMap(job => finals.get(job.id) ?? [])),
    // The rate is over every finish in the window unless a family or lane filter narrowed the jobs.
    tags: summarizeEmptyTags(selected.flatMap(job => emptyTags.get(job.id) ?? []), options.family || options.lane ? selected.length : finishes.length),
    digest: summarizeEmptyDigest(selected.flatMap(job => digestInputs.get(job.id) ?? []), options.quote ?? false),
    tagged: selected.flatMap(job => emptyTags.get(job.id) ?? []) };
}
