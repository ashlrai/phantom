/**
 * Where queue autofill gets its work, best first:
 *   1. `idea`      ranked Ideas items that are not yet queued, running or shipped (phm ideas),
 *   2. `follow-up` "Not built:" / "Gaps:" lines in the logs of recently EMPTY jobs,
 *   3. `bet`       the existing bets-propose source.
 * Every prompt autofill writes starts with the same Step-0 line, which is what makes leader bets land as PRs.
 */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { emptyJobs } from './empty-job-ledger.js';
import { jobFamily } from './slot-yield.js';
import { ideaJobId, type BottleneckIdea } from './bottleneck-ideas.js';
import { titleHash } from './supply.js';

export const AUTOFILL_SOURCES = ['idea', 'follow-up', 'bet'] as const;
export type AutofillSource = typeof AUTOFILL_SOURCES[number];

export const STEP_ZERO = 'Step 0: search master, deliver only the delta; end with no change if it already exists.';
export const SHIP_PARTIAL = 'Ship partial, show unknown as unknown, list the gap in the PR body.';

export interface FollowUp { text: string; fromJob: string }
export interface AutofillCandidate { id: string; repo: string; goal: string; acceptance: string; why: string; source: AutofillSource; family: string }

/** The queue prompt: Step 0 first, then the ship-partial rule, then the task. */
export const stepZeroPrompt = (goal: string): string => `${STEP_ZERO} ${SHIP_PARTIAL} ${goal}`;
/** The task inside a prompt written by `stepZeroPrompt`; other text comes back as it is. */
export const stripStepZero = (scope: string): string => (scope.startsWith(`${STEP_ZERO} ${SHIP_PARTIAL} `) ? scope.slice(STEP_ZERO.length + SHIP_PARTIAL.length + 2) : scope);

/** Ideas that are still open, in rank order. Already queued, running or shipped ideas are returned as `skipped`. */
export function ideaCandidates(ideas: readonly BottleneckIdea[], repo: string): { open: AutofillCandidate[]; skipped: string[] } {
  const open: AutofillCandidate[] = [];
  const skipped: string[] = [];
  for (const idea of ideas) {
    if (idea.status !== 'proposed' || typeof idea.evidence.existingJobId === 'string') { skipped.push(idea.title); continue; }
    const id = `RQ-${ideaJobId(idea.id)}`;
    open.push({ id, repo, goal: idea.task, acceptance: `Acceptance: ${idea.title} is fixed, or the evidence no longer holds and the job ends with no change.`, why: `From the Ideas list (${idea.signal}); ${idea.payoff.text}.`, source: 'idea', family: jobFamily(id) });
  }
  return { open, skipped };
}

const oneLine = (s: string, n: number): string => scrubSecrets(s.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, n).trim();
const NOTE = /^[\s>*-]*(?:not built|gaps?)\b[^:\n]*:\s*(\S.*)$/i;

/** Pure: the follow-ups a finished job named, from a log tail. A heading line may be followed by "- " bullets. */
export function parseFollowUps(log: string, fromJob: string): FollowUp[] {
  const out: FollowUp[] = [];
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heading = /^[\s>*-]*(?:not built|gaps?)\b[^:\n]*:\s*$/i.test(lines[i]!);
    const inline = NOTE.exec(lines[i]!)?.[1];
    const parts = inline ? [inline] : [];
    if (heading) for (let j = i + 1; j < lines.length && /^\s*[-*]\s+\S/.test(lines[j]!); j++) parts.push(lines[j]!.replace(/^\s*[-*]\s+/, ''));
    for (const part of parts) {
      const text = oneLine(part, 160);
      if (text.length >= 12 && !/^(none|n\/a|nothing)\b/i.test(text)) out.push({ text, fromJob });
    }
  }
  return out;
}

async function tail(path: string, size: number): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) return '';
    const length = Math.min(stat.size, size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; } finally { await file?.close(); }
}

/** Follow-ups from the logs of jobs that ended empty in the last `hours`; none when the ledger or a log cannot be read. */
export async function readFollowUps(runsDir: string, now: number, hours = 72, max = 12): Promise<FollowUp[]> {
  const ledger = await tail(join(runsDir, 'metrics/jobs.jsonl'), 2 * 1024 * 1024);
  const seen = new Set<string>();
  const out: FollowUp[] = [];
  for (const job of emptyJobs(ledger, now, hours).slice(-40).reverse()) {
    for (const f of parseFollowUps(await tail(join(runsDir, `${job.id}.log`), 65536), job.id)) {
      const key = titleHash(f.text);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function followUpCandidates(followUps: readonly FollowUp[], repo: string): AutofillCandidate[] {
  return followUps.map(f => ({
    id: `RQ-FOLLOWUP-${titleHash(f.text).slice(0, 10).toUpperCase()}`, repo, goal: f.text,
    acceptance: 'Acceptance: the named gap is built, or it already exists and the job ends with no change.',
    why: `Named as not built by finished job ${f.fromJob}.`, source: 'follow-up', family: jobFamily(f.fromJob),
  }));
}
