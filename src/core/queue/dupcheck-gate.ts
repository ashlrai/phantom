/**
 * Pre-launch gate on top of dupcheck.ts: turn one report into skip, warn or launch, and keep the record that lets
 * the check be measured. The dispatcher calls `phm queue dupcheck <prompt-file> --gate --json` before it claims a row.
 *
 *   skip    high confidence the work is already on master: do not launch; the reason and evidence are recorded
 *   warn    medium confidence: launch, with one "Check this first" line added to the job prompt
 *   launch  anything else (partial, new, unknown): launch as usual
 *
 * High needs more than named things existing: this job id already merged, or every named command, flag and file is
 * there and at least one flag is (a flag is what a job adds, so its presence is the sign the work landed).
 * Records live in `<runs>/metrics/dupcheck.jsonl` beside the job ledger; the directory is never created here.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DupcheckEvidence, DupcheckReport } from './dupcheck.js';

export const DUPCHECK_GATE_SCHEMA = 'queue.dupcheck-gate.v1';
export const DUPCHECK_STATS_SCHEMA = 'queue.dupcheck-stats.v1';
const EVENT_SCHEMA = 'queue.dupcheck-event.v1';
const MAX_LINE = 300;

export type DupcheckAction = 'skip' | 'warn' | 'launch';
export type DupcheckConfidence = 'high' | 'medium' | 'low' | 'none';
export interface DupcheckGate {
  schema: typeof DUPCHECK_GATE_SCHEMA;
  job: string | null;
  action: DupcheckAction;
  confidence: DupcheckConfidence;
  /** `already_done` when the work looks finished; null when the gate has nothing to say. */
  reason: 'already_done' | null;
  /** The matching file, command or merged job that backs the reason. */
  evidence: DupcheckEvidence[];
  /** The one line to add to the job prompt on warn; null otherwise. */
  line: string | null;
  summary: string;
}

const sameJobMerged = (e: DupcheckEvidence): boolean => e.type === 'merged' && e.detail.startsWith('this job id already merged');

export function dupcheckGate(report: DupcheckReport): DupcheckGate {
  const found = report.nouns.filter(n => n.found), missing = report.nouns.filter(n => !n.found);
  const sameJob = report.evidence.some(sameJobMerged);
  let confidence: DupcheckConfidence = 'none';
  if (report.verdict === 'likely_done') {
    const flagged = !missing.length && found.some(n => n.kind === 'flag') && found.some(n => n.kind === 'command');
    confidence = sameJob || flagged ? 'high' : 'medium';
  } else if (report.verdict === 'partial' && found.length) confidence = 'low';
  const action: DupcheckAction = confidence === 'high' ? 'skip' : confidence === 'medium' ? 'warn' : 'launch';
  const evidence = report.evidence.slice(0, 5);
  const refs = [...new Set(found.map(n => `${n.text} (${n.evidence[0]?.ref ?? 'on master'})`))].join(', ');
  const line = action === 'warn'
    ? `Check this first: ${(refs || report.summary).slice(0, MAX_LINE - 100)} may already be on master. If the work is done, stop and say so; otherwise build only what is missing.`
    : null;
  return {
    schema: DUPCHECK_GATE_SCHEMA, job: report.source.id, action, confidence, reason: action === 'launch' ? null : 'already_done',
    evidence, line, summary: action === 'skip' ? `Skipped: ${report.summary}` : report.summary,
  };
}

// --- the record ---

export interface DupcheckEvent { schema: typeof EVENT_SCHEMA; at: string; job: string; action: DupcheckAction | 'outcome'; confidence?: DupcheckConfidence; reason?: string; evidence?: string[]; tag?: string }
const file = (runsDir: string): string => join(runsDir, 'metrics', 'dupcheck.jsonl');

/** Append one decision. Needs a job id; a failed write never blocks a launch. */
export async function recordDupcheckGate(runsDir: string, gate: DupcheckGate, now = Date.now()): Promise<boolean> {
  if (!gate.job) return false;
  const row: DupcheckEvent = { schema: EVENT_SCHEMA, at: new Date(now).toISOString(), job: gate.job, action: gate.action, confidence: gate.confidence,
    ...(gate.reason ? { reason: gate.reason, evidence: gate.evidence.map(e => `${e.type}:${e.ref}`) } : {}) };
  try { await appendFile(file(runsDir), `${JSON.stringify(row)}\n`); return true; } catch { return false; }
}

/** Pure: the well-formed `queue.dupcheck-event.v1` rows of one JSONL text; torn and foreign lines drop. */
export function parseDupcheckEvents(text: string): DupcheckEvent[] {
  const out: DupcheckEvent[] = [];
  for (const l of text.split('\n')) {
    try { const r = JSON.parse(l) as DupcheckEvent; if (r.schema === EVENT_SCHEMA && typeof r.job === 'string') out.push(r); } catch { /* torn line */ }
  }
  return out;
}

async function readEvents(runsDir: string): Promise<DupcheckEvent[] | null> {
  let text: string;
  try { text = await readFile(file(runsDir), 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null; }
  return parseDupcheckEvents(text);
}

/** A launched or warned row that ended EMPTY already_done: write it once, so precision can be measured. Returns rows added. */
export async function recordDupcheckOutcomes(runsDir: string, jobs: readonly { id: string; tag: string }[], now = Date.now()): Promise<number> {
  const events = await readEvents(runsDir);
  if (!events) return 0;
  const launched = new Set(events.filter(e => e.action === 'launch' || e.action === 'warn').map(e => e.job));
  const done = new Set(events.filter(e => e.action === 'outcome').map(e => e.job));
  const fresh = jobs.filter(j => j.tag === 'already_done' && launched.has(j.id) && !done.has(j.id));
  if (!fresh.length) return 0;
  const at = new Date(now).toISOString();
  try { await appendFile(file(runsDir), fresh.map(j => `${JSON.stringify({ schema: EVENT_SCHEMA, at, job: j.id, action: 'outcome', tag: 'already_done' })}\n`).join('')); } catch { return 0; }
  return fresh.length;
}

export interface DupcheckStats {
  schema: typeof DUPCHECK_STATS_SCHEMA;
  /** Jobs the gate looked at. */
  checked: number;
  skips: number;
  warns: number;
  launches: number;
  /** Warned rows that still ended EMPTY already_done: the warning was right but the job ran anyway. */
  warned_ended_already_done: number;
  /** Plain launches that ended EMPTY already_done: duplicates the check missed. */
  launched_ended_already_done: number;
  /** Skipped rows that were launched later: the skip was wrong or the row was re-queued. */
  false_skips: number;
  false_skip_jobs: string[];
  /** (skips - false_skips) / skips; null with no skips. */
  skip_precision: number | null;
}

/** Pure: events are in ledger order. Each job counts once, by its first decision. */
export function summarizeDupcheck(events: readonly DupcheckEvent[]): DupcheckStats {
  const first = new Map<string, DupcheckAction>(), skipped = new Set<string>(), relaunched = new Set<string>(), outcome = new Set<string>();
  for (const e of events) {
    if (e.action === 'outcome') { outcome.add(e.job); continue; }
    if (!first.has(e.job)) first.set(e.job, e.action);
    if (e.action === 'skip') skipped.add(e.job);
    else if (skipped.has(e.job)) relaunched.add(e.job);
  }
  const count = (a: DupcheckAction): number => [...first.values()].filter(x => x === a).length;
  const ended = (a: DupcheckAction): number => [...first].filter(([job, x]) => x === a && outcome.has(job)).length;
  const skips = skipped.size;
  return {
    schema: DUPCHECK_STATS_SCHEMA, checked: first.size, skips, warns: count('warn'), launches: count('launch'),
    warned_ended_already_done: ended('warn'), launched_ended_already_done: ended('launch'),
    false_skips: relaunched.size, false_skip_jobs: [...relaunched].sort(), skip_precision: skips ? (skips - relaunched.size) / skips : null,
  };
}

/** null when the record cannot be read (shown as unknown, never as zero). */
export async function readDupcheckStats(runsDir: string): Promise<DupcheckStats | null> {
  const events = await readEvents(runsDir);
  return events ? summarizeDupcheck(events) : null;
}

export function dupcheckStatsLines(s: DupcheckStats): string[] {
  if (!s.checked) return ['No pre-launch checks recorded yet.'];
  const lines = [
    `${s.checked} jobs checked: ${s.skips} skipped as already done, ${s.warns} launched with a warning, ${s.launches} launched.`,
    `Ended empty as already_done anyway: ${s.warned_ended_already_done} warned, ${s.launched_ended_already_done} not flagged.`,
    s.skips ? `Skips relaunched later (wrong skips): ${s.false_skips} of ${s.skips}${s.false_skip_jobs.length ? `: ${s.false_skip_jobs.join(', ')}` : ''}.` : 'No skips yet.',
  ];
  return lines;
}
