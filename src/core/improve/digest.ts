/** Bounded, aggregate-only evidence for the scheduled improvement backlog. */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AutomationGh } from '../automations/github.js';
import { ghGet } from '../automations/github.js';
import type { CloudBacklogItem } from '../cloud/types.js';

const WINDOW = 7 * 24 * 60 * 60 * 1000;
const MAX_LEDGER_BYTES = 10 * 1024 * 1024;
async function readLedger(path: string): Promise<string | null> {
  try {
    const file = await open(path, 'r');
    try {
      const bytes = Buffer.alloc(MAX_LEDGER_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      return bytesRead > MAX_LEDGER_BYTES ? null : bytes.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
  } catch { return null; }
}
type Row = Record<string, unknown>;
const record = (x: unknown): x is Row => !!x && typeof x === 'object' && !Array.isArray(x);
const recent = (value: unknown, now: number) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) >= now - WINDOW && Date.parse(value) <= now;

/** No titles, job identifiers, or local paths leave this aggregate. Missing inputs stay null. */
export async function improvementDigest(repo: string, gh: AutomationGh, now: number, jobsPath = join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')): Promise<{ items: CloudBacklogItem[]; errors: string[] }> {
  const errors: string[] = [];
  const [pulls, runs, jobs] = await Promise.all([
    ghGet(gh, `repos/${repo}/pulls`, { state: 'closed', sort: 'updated', direction: 'desc', per_page: '100' }, null),
    ghGet(gh, `repos/${repo}/actions/runs`, { status: 'completed', per_page: '100' }, null),
    readLedger(jobsPath),
  ]);
  let merged: number | null = null, failures: number | null = null;
  if ('error' in pulls || !Array.isArray(pulls.body)) errors.push('merged PR evidence unavailable');
  else merged = pulls.body.filter((r: unknown) => record(r) && recent(r.merged_at, now)).length;
  if ('error' in runs || !record(runs.body) || !Array.isArray(runs.body.workflow_runs)) errors.push('CI evidence unavailable');
  else failures = runs.body.workflow_runs.filter((r: unknown) => record(r) && recent(r.created_at, now) && ['failure', 'timed_out', 'startup_failure'].includes(String(r.conclusion))).length;
  // Counts are observations, not capacity or utilization percentages. A partial
  // ledger never proves an idle lane; it can only show actual queued launches.
  let queued: number | null = null, launched: number | null = null;
  if (jobs === null) errors.push('queue evidence unavailable');
  else {
    queued = 0; launched = 0;
    for (const line of jobs.split(/\r?\n/)) {
      try {
        const row: unknown = JSON.parse(line);
        if (!record(row) || !recent(row.ts ?? row.timestamp ?? row.at, now)) continue;
        if ((row.event ?? row.type) === 'queued') queued++;
        if ((row.event ?? row.type) === 'launch') launched++;
      } catch { /* malformed rows are not evidence */ }
    }
  }
  const evidence = `Last 7 days; bounded GitHub samples (at most 100 each): merged PRs ${merged ?? 'unknown'}, failed CI runs ${failures ?? 'unknown'}; local queue events ${queued ?? 'unknown'}, launches ${launched ?? 'unknown'}. Counts are observations, not capacity or complete totals.`;
  const tasks: Array<[string, string, string, boolean]> = [
    ['ci', 'Reduce recurring CI failures', 'Inspect recent failed runs, reproduce a recurring cause and fix it without skipping checks.', failures !== null && failures >= 2],
    ['test-speed', 'Reduce test or CI critical-path time', 'Measure the test and CI critical path, remove a demonstrated bottleneck, and report before/after timings.', merged !== null && merged > 0],
    ['docs-drift', 'Repair documentation drift', 'Compare recently changed behavior with its documentation and fix a specific demonstrated mismatch.', merged !== null && merged > 0],
    ['dead-code', 'Remove verified dead code', 'Inspect recently changed code for unreachable or unused code; remove only code proven unused and cover the behavior.', merged !== null && merged > 0],
    ['orchestration', 'Improve queue orchestration', 'Measure queue and lane behavior, identify a demonstrated bottleneck and test a focused correction.', queued !== null && launched !== null && queued >= 3 && queued > launched],
  ];
  const items = tasks.filter(([, , , enabled]) => enabled).map(([kind, title, instruction], index): CloudBacklogItem => ({
    id: `digest-${kind}-${Math.floor(now / WINDOW)}`, priority: index === 0 && kind === 'ci' ? 1 : 2, area: kind, repo, title,
    prompt: `${instruction}\n\nEvidence: ${evidence}\nVerify the evidence against current sources before editing; if no actionable issue remains, report no-change. Implement one focused change with regression coverage. Open a draft PR and never auto-merge it; required CI must be green before any promotion.`,
  }));
  return { items, errors };
}
