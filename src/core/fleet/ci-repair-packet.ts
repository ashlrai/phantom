import { stripVTControlCharacters } from 'node:util';
import type { CloudGh } from '../cloud/pr-actions.js';
import { collectCiFailureGroups } from './ci-failure-groups.js';
import { readCiEvidence, type CiEvidence } from './ci-evidence.js';
import { scrubSecrets } from '../util/scrub.js';
import type { GitRunner } from '../verse/git-ops.js';

// Clean complete values before bounding them, so truncation cannot reveal a partial secret.
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
}
function safe<T>(value: T): T {
  if (typeof value === 'string') return clean(value) as T;
  if (Array.isArray(value)) return value.map(safe) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v)])) as T;
  return value;
}

type Group = Awaited<ReturnType<typeof collectCiFailureGroups>>['groups'][number];
type Example = Group['evidence'][number];
type Item = { group: Pick<Group, 'workflowPath' | 'event' | 'jobName' | 'conclusion'>; runId: number; attempt: number; latestAttempt: number; headSha: string; runUrl: string; jobUrl: string; jobId: number | null; unavailable: string | null; evidence: CiEvidence | null };

function jobId(repo: string, example: Example): number | null {
  const prefix = `https://github.com/${repo}/actions/runs/${example.runId}/job/`;
  if (!example.jobUrl.startsWith(prefix)) return null;
  const suffix = example.jobUrl.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(suffix)) return null;
  const id = Number(suffix);
  return Number.isSafeInteger(id) ? id : null;
}

/** Groups are ranked upstream; evidence reads are capped and never target historical attempts. */
export async function collectCiRepairPacket(repo: string, hours: number, maxGroups: number, now: Date, deps: { gh?: CloudGh; runner?: GitRunner } = {}) {
  const grouped = await collectCiFailureGroups(repo, hours, now, deps.gh);
  const failures = grouped.groups.filter(g => ['failure', 'timed_out'].includes(g.conclusion));
  const current = failures.filter(g => g.evidence.some(e => e.attempt === e.latestAttempt && e.runStatus === 'completed'));
  const selected = current.slice(0, maxGroups);
  const items: Item[] = [];
  const byJob = new Map<number, Item>();
  let omittedEvidence = 0, duplicates = 0;
  for (const g of selected) {
    for (const e of g.evidence.filter(e => e.attempt === e.latestAttempt && e.runStatus === 'completed')) {
      const id = jobId(repo, e);
      const group = { workflowPath: g.workflowPath, event: g.event, jobName: g.jobName, conclusion: g.conclusion };
      const previous = id === null ? undefined : byJob.get(id);
      if (previous) {
        duplicates++;
        if (previous.runId !== e.runId || previous.attempt !== e.attempt || previous.headSha !== e.headSha || JSON.stringify(previous.group) !== JSON.stringify(group)) previous.unavailable = 'ambiguous_job_identity';
        continue;
      }
      if (items.length >= 10) { omittedEvidence++; continue; }
      const item: Item = { group, runId: e.runId, attempt: e.attempt, latestAttempt: e.latestAttempt, headSha: e.headSha,
        runUrl: `https://github.com/${repo}/actions/runs/${e.runId}`, jobUrl: id === null ? '' : e.jobUrl, jobId: id,
        unavailable: id === null ? 'invalid_job_url' : null, evidence: null };
      items.push(item);
      if (id !== null) byJob.set(id, item);
    }
  }
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++]!;
      if (item.unavailable || item.jobId === null) continue;
      const evidence = await readCiEvidence(repo, item.runId, item.jobId, deps.runner);
      if (evidence.headSha !== null && clean(item.headSha) !== item.headSha) item.unavailable = 'head_unverifiable';
      else if (evidence.headSha !== null && evidence.headSha.toLowerCase() !== item.headSha.toLowerCase()) item.unavailable = 'head_mismatch';
      else if (evidence.jobName !== null && (evidence.jobName !== clean(item.group.jobName).slice(0, 200) || evidence.conclusion !== clean(item.group.conclusion))) item.unavailable = 'job_mismatch';
      else if (evidence.source.status !== 'ok') item.unavailable = evidence.source.status;
      else if (evidence.source.outputTruncated) item.unavailable = 'evidence_output_truncated';
      if (item.unavailable !== 'head_mismatch' && item.unavailable !== 'head_unverifiable' && item.unavailable !== 'job_mismatch') item.evidence = evidence;
    }
  }
  await Promise.all([worker(), worker()]);
  const packet = {
    version: 1, repo, observedAt: now.toISOString(), coverage: grouped.coverage,
    historical: failures.filter(g => g.historicalAttemptCount > 0).map(g => ({ workflowPath: g.workflowPath, event: g.event, jobName: g.jobName, conclusion: g.conclusion, historicalAttemptCount: g.historicalAttemptCount })),
    selectedGroups: selected.map(g => ({ workflowPath: g.workflowPath, event: g.event, jobName: g.jobName, conclusion: g.conclusion, latestRunCount: g.latestRunCount, historicalAttemptCount: g.historicalAttemptCount })),
    items, omitted: { groups: current.length - selected.length, evidence: omittedEvidence, duplicateJobs: duplicates, nonCompletedGroups: failures.filter(g => g.latestRunCount > 0 && !current.includes(g)).length },
    complete: grouped.coverage.complete && items.every(item => item.unavailable === null),
    noFailuresObserved: grouped.coverage.complete && failures.length === 0,
  };
  return safe(packet);
}
