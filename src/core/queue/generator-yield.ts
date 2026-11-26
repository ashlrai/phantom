import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isNodePoolLedgerRow, ledgerEventTs } from '../fleet/jobs-ledger-dialect.js';

export interface GenerationDecision {
  job: string; src: string; event: 'drafted' | 'rejected';
  reason?: 'duplicate' | 'already_completed' | 'already_queued_or_completed' | 'stopped_family' | 'missing_capability' | 'hourly_cap';
}
export interface GeneratorYieldRow {
  generator: string; jobs: number; prs: number; merged: number;
  drafted: number; rejected: number; launched: number; rejections: Record<string, number>;
  emptyRate: number | null; medianDiffLines: number | null; tokensPerMergedPr: number | null;
}
export interface GeneratorYieldReport {
  schema: 'queue.generator-yield.v1'; sinceHours: number; known: boolean; jobsKnown: boolean; generationKnown: boolean; malformedLines: number; generators: GeneratorYieldRow[];
}
type Job = { generator: string | null; explicit: boolean; empty: boolean | null; pr: boolean; merged: boolean; diff: number | null; tokens: number | null;
  launched: boolean };
const string = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;
const count = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
/** jobs.jsonl field dialects, the same sets dispatchd `_vc_pick` accepts:
 * ids job|job_id|jobId|id, events event|type|kind, phases
 * state|outcome|status plus producer aliases, timestamps
 * ts|timestamp|at|startedAt|time|mergedAt|closedAt|recordedAt|updatedAt, and
 * PR links pr|pr_url|prUrl|url|html_url. */
const JOB_ID_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const PHASE_KEYS = ['state', 'outcome', 'status', 'phase', 'result', 'conclusion'] as const;
const PR_KEYS = ['pr', 'pr_url', 'prUrl', 'url', 'html_url'] as const;
const pickString = (r: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = string(r[key]);
    if (value !== null) return value;
  }
  return null;
};
function terminalVerdict(row: Record<string, unknown>, event: string | undefined): 'MERGED' | 'CLOSED' | null {
  for (const key of PHASE_KEYS) {
    const phase = string(row[key])?.toUpperCase();
    if (phase === 'MERGED' || phase === 'CLOSED') return phase;
  }
  if (event === 'merged') return 'MERGED';
  if (event === 'closed') return 'CLOSED';
  return null;
}
function generator(id: string): string {
  if (/^FIXUP-/i.test(id)) return 'fixup';
  if (/^RQ-DRAIN-/i.test(id)) return 'drain';
  if (/A\d+Q8$/i.test(id)) return 'filler';
  if (/N9[^\s]*Q8$/i.test(id)) return 'leader';
  return 'unknown';
}
/** Events in the window are grouped by job ID; repeated events never count twice. */
export function generatorYield(raw: string, hours = 24, now = Date.now(), decisions = ''): GeneratorYieldReport {
  const jobs = new Map<string, Job>(); let malformedLines = 0;
  const drafts = new Map<string, Set<string>>();
  const generation = new Map<string, Map<string, { drafted: boolean; reasons: Set<string> }>>();
  const launchedBatches = new Map<string, number>();
  const memberBatches = new Map<string, Map<string, number>>();
  const rows: { id: string; at: number; event: string | undefined; terminal: ReturnType<typeof terminalVerdict>; row: Record<string, unknown> }[] = [];
  const since = now - hours * 3600000;
  for (const [text, isGenerationJournal] of [[raw, false], [decisions, true]] as const) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { malformedLines++; continue; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { malformedLines++; continue; }
      const r = value as Record<string, unknown>;
      if (isNodePoolLedgerRow(r)) continue;
      const event = pickString(r, EVENT_KEYS)?.toLowerCase();
      const isDecision = event === 'drafted' || event === 'rejected';
      if (isGenerationJournal !== isDecision) continue;
      const id = pickString(r, JOB_ID_KEYS);
      const terminal = isDecision ? null : terminalVerdict(r, event);
      // Reconciled outcomes can retain the original publish timestamp.
      const at = ledgerEventTs(r, terminal);
      if (!id || at === null) { malformedLines++; continue; }
      if (at < since || at > now) continue;
      rows.push({ id, at, event, terminal, row: r });
    }
  }
  // Late receipts can be appended out of order. Stable sorting preserves
  // ledger order when receipts share a timestamp.
  let emptyEvidenceAt: number | undefined;
  const seenEmptyEvidence = new Set<string>();
  for (const { id, at, event, terminal, row: r } of rows.sort((a, b) => a.at - b.at)) {
    const launch = event === 'launch' || event === 'launched';
    if (id.startsWith('RQ-BATCH-')) {
      if (launch) launchedBatches.set(id, at);
      continue;
    }
    if (event === 'drafted' || event === 'rejected') {
      const source = string(r.src) ?? 'unknown', group = generation.get(source) ?? new Map<string, { drafted: boolean; reasons: Set<string> }>();
      const decision = group.get(id) ?? { drafted: false, reasons: new Set<string>() };
      if (event === 'drafted') {
        decision.drafted = true;
        const sources = drafts.get(id) ?? new Set<string>();
        sources.add(source);
        drafts.set(id, sources);
      }
      else decision.reasons.add(string(r.reason) ?? 'unknown');
      group.set(id, decision); generation.set(source, group); continue;
    }
    const job = jobs.get(id) ?? { generator: null, explicit: false, empty: null, pr: false, merged: false, diff: null, tokens: null, launched: false };
    const src = string(r.src);
    if (src) { job.generator = src; job.explicit = true; }
    else if (!job.explicit) job.generator = generator(id);
    const phase = pickString(r, PHASE_KEYS);
    if (launch) job.launched = true;
    if (event === 'batch_claim') {
      const batch = pickString(r, ['batch', 'batch_id', 'batchId']);
      if (batch?.startsWith('RQ-BATCH-')) {
        const batches = memberBatches.get(id) ?? new Map<string, number>();
        if (!batches.has(batch)) batches.set(batch, at);
        memberBatches.set(id, batches);
      }
    }
    const empty = phase?.toLowerCase() === 'empty' ? true : typeof r.empty === 'boolean' ? r.empty : null;
    const dispatch = launch || event === 'batch_claim';
    if (dispatch || empty !== null) {
      if (at !== emptyEvidenceAt) {
        seenEmptyEvidence.clear();
        emptyEvidenceAt = at;
      }
      const receipt = JSON.stringify(r);
      if (!seenEmptyEvidence.has(receipt)) {
        seenEmptyEvidence.add(receipt);
        job.empty = empty;
      }
    }
    if (pickString(r, PR_KEYS) !== null) job.pr = true;
    if (terminal === 'MERGED') { job.merged = true; job.pr = true; }
    job.diff = count(r.diff_lines) ?? job.diff;
    job.tokens = count(r.tokens_total ?? r.tokens) ?? job.tokens;
    jobs.set(id, job);
  }
  const groups = new Map<string, Job[]>();
  for (const [id, job] of jobs) {
    for (const [batch, claimedAt] of memberBatches.get(id) ?? []) {
      const launchedAt = launchedBatches.get(batch);
      if (launchedAt !== undefined && launchedAt >= claimedAt) {
        job.launched = true;
        break;
      }
    }
    const sources = drafts.get(id);
    let name = job.generator ?? 'unknown';
    if (!job.explicit && sources) {
      name = sources.size === 1 ? [...sources][0]! : 'unknown';
    }
    const group = groups.get(name) ?? [];
    group.push(job);
    groups.set(name, group);
  }
  const generators = [...new Set([...groups.keys(), ...generation.keys()])].map(name => {
    const rows = groups.get(name) ?? [], decisions = [...(generation.get(name)?.values() ?? [])];
    const diffs = rows.map(r => r.diff).filter((n): n is number => n !== null).sort((a, b) => a - b);
    const measured = rows.filter(r => r.empty !== null);
    const merged = rows.filter(r => r.merged);
    const tokensKnown = rows.every(r => r.tokens !== null);
    const mid = Math.floor(diffs.length / 2);
    return { generator: name, jobs: rows.length, prs: rows.filter(r => r.pr).length, merged: merged.length,
      drafted: decisions.filter(r => r.drafted).length, rejected: decisions.filter(r => r.reasons.size).length, launched: rows.filter(r => r.launched).length,
      rejections: Object.fromEntries([...new Set(decisions.flatMap(r => [...r.reasons]))].sort().map(reason => [reason, decisions.filter(r => r.reasons.has(reason)).length])),
      emptyRate: measured.length ? measured.filter(r => r.empty).length / measured.length : null,
      medianDiffLines: diffs.length ? (diffs.length % 2 ? diffs[mid]! : (diffs[mid - 1]! + diffs[mid]!) / 2) : null,
      tokensPerMergedPr: merged.length && tokensKnown ? rows.reduce((sum, r) => sum + r.tokens!, 0) / merged.length : null };
  }).sort((a, b) => a.generator.localeCompare(b.generator));
  return { schema: 'queue.generator-yield.v1', sinceHours: hours, known: true, jobsKnown: true, generationKnown: true, malformedLines, generators };
}
export async function readGeneratorYield(runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), hours = 24, now = Date.now()): Promise<GeneratorYieldReport> {
  const [jobs, decisions] = await Promise.allSettled([
    readFile(join(runsDir, 'metrics', 'jobs.jsonl'), 'utf8'),
    readFile(join(runsDir, 'metrics', 'generation.jsonl'), 'utf8'),
  ]);
  const jobsKnown = jobs.status === 'fulfilled';
  const generationKnown = decisions.status === 'fulfilled';
  return {
    ...generatorYield(jobsKnown ? jobs.value : '', hours, now, generationKnown ? decisions.value : ''),
    known: jobsKnown || generationKnown,
    jobsKnown,
    generationKnown,
  };
}
