import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emptyJobs } from './empty-job-ledger.js';

export const EMPTY_CLASSES = ['duplicate', 'already-done', 'blocked-by-env', 'missing-input', 'scope-too-cautious', 'other'] as const;
export type EmptyClass = typeof EMPTY_CLASSES[number];
export interface EmptyJobResult { id: string; lane: string; class: EmptyClass; reason: string }
export interface EmptyCause { class: EmptyClass; label: string; count: number; exampleJob: string }
export interface EmptyJobsReport { schema: 'jobs.empty.v1'; hours: number; total: number; counts: Record<EmptyClass, number>; jobs: EmptyJobResult[]; topCauses: EmptyCause[] }

const labels: Record<EmptyClass, string> = { duplicate: 'Duplicate of an earlier job', 'already-done': 'Work already done', 'blocked-by-env': 'Tool or environment problem', 'missing-input': 'Missing input', 'scope-too-cautious': 'Scope or approval', other: 'Unknown reason' };

// Return fixed descriptions: notes and logs may contain private information.
const rules: ReadonlyArray<readonly [EmptyClass, string, RegExp]> = [
  ['duplicate', 'The job duplicated an earlier job.', /\bduplicate(?:d)? (?:of )?(?:an? |the )?(?:earlier |previous |existing )?(?:job|task|request)\b|\b(?:job|task|request) (?:is |was )?(?:a )?duplicate\b/i],
  ['already-done', 'Work was already completed or covered.', /already (?:done|implemented|completed|fixed|merged|covered|shipped|exists)|(?:existing|open) (?:pr|pull request).*cover/i],
  ['blocked-by-env', 'A tool or environment problem blocked the work.', /\bEPERM\b|\bEACCES\b|permission denied|command not found|(?:tool|dependency|binary|executable).{0,30}(?:missing|unavailable|not found)|timed?\s*out|timeout|network (?:unavailable|error)|rate limit/i],
  ['missing-input', 'Required input was unavailable.', /missing (?:input|context|information|file|credentials?|data)|(?:need|needs|requires?|awaiting|waiting for) (?:user |owner |human )?(?:input|clarification|information|credentials?|access|approval)|(?:no|without) (?:access|input|context)/i],
  ['scope-too-cautious', 'The job stopped over scope or approval.', /(?:out(?:side)? of|beyond) (?:the )?scope|scope (?:extension|is unclear|was unclear)|(?:approval|permission|confirmation) (?:is )?(?:required|needed)|(?:cannot|can't|unable to) (?:proceed|continue) without/i],
];
export function classifyEmpty(notes: string | null, log: string | null): Pick<EmptyJobResult, 'class' | 'reason'> {
  for (const text of [notes, log]) {
    if (!text) continue;
    for (const [kind, reason, pattern] of rules) if (pattern.test(text)) return { class: kind, reason };
  }
  return { class: 'other', reason: notes || log ? 'No known reason found.' : 'Notes and log were unavailable.' };
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

export async function readEmptyJobs(hours = 24, root = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs'), worktrees = process.env.ASHLR_WT_DIR?.trim() || join(homedir(), 'Projects/ashlrai/wt'), now = Date.now()): Promise<EmptyJobsReport | null> {
  let ledger: string;
  try { ledger = await readFile(join(root, 'metrics/jobs.jsonl'), 'utf8'); } catch { return null; }
  const selected = emptyJobs(ledger, now, hours);
  const jobs: EmptyJobResult[] = [];
  for (let offset = 0; offset < selected.length; offset += 16) {
    const batch = selected.slice(offset, offset + 16);
    jobs.push(...await Promise.all(batch.map(async job => {
      const [notes, log] = await Promise.all([tail(join(worktrees, job.id, 'BRIDGE_NOTES.md'), 65536), tail(join(root, `${job.id}.log`), 65536)]);
      return { ...job, ...classifyEmpty(notes, log) };
    })));
  }
  const counts: Record<EmptyClass, number> = { duplicate: 0, 'already-done': 0, 'blocked-by-env': 0, 'missing-input': 0, 'scope-too-cautious': 0, other: 0 };
  for (const job of jobs) counts[job.class]++;
  const topCauses = EMPTY_CLASSES.filter(kind => counts[kind] > 0)
    .map(kind => ({ class: kind, label: labels[kind], count: counts[kind], exampleJob: jobs.find(job => job.class === kind)!.id }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 5);
  return { schema: 'jobs.empty.v1', hours, total: jobs.length, counts, jobs, topCauses };
}
