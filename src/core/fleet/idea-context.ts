/** Local planning evidence for the existing Ideas list; reading never acknowledges inbox entries. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import type { BottleneckIdea, IdeaListReport, SignalName } from './bottleneck-ideas.js';
import { DROP_JOB_LANES } from './drop-job-writer.js';
import { parseIdeas } from './ideas.js';
import { parseInbox } from './mason-inbox.js';
import { readSource } from './runs-parked-queue.js';

const clean = (text: string) => scrubSecrets(text).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const jobId = (row: Record<string, unknown>) => row.job ?? row.job_id ?? row.jobId ?? row.id;
const PHASE_KEYS = ['state', 'outcome', 'status', 'phase', 'result', 'conclusion'] as const;
const phaseOf = (row: Record<string, unknown>) => PHASE_KEYS.map(key => row[key]).find(value => typeof value === 'string');
const eventTime = (row: Record<string, unknown>) => {
  const at = row.ts ?? row.timestamp ?? row.at ?? row.time ?? row.mergedAt ?? row.merged_at ?? row.closedAt ?? row.recordedAt ?? row.updatedAt;
  return typeof at === 'number' ? at * (at < 1e12 ? 1000 : 1) : Date.parse(String(at ?? ''));
};
function events(text: string, now = Infinity): { rows: Record<string, unknown>[]; dropped: number } {
  const rows: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const line of text.split('\n').filter(line => line.trim())) {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid event');
      const record = row as Record<string, unknown>;
      if (![record.event, record.type, record.kind, record.state, record.outcome, record.status, record.phase, record.result, record.conclusion].some(value => typeof value === 'string')) throw new Error('missing event');
      const event = String(record.event ?? record.type ?? record.kind ?? '').toLowerCase();
      const at = eventTime(record);
      const timed = ['launch', 'enqueue', 'queued'].includes(event);
      const lifecycle = timed || ['finish', 'outcome', 'publish', 'merged'].includes(event) || PHASE_KEYS.some(key => typeof record[key] === 'string');
      const invalidTime = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'merged_at', 'closedAt', 'recordedAt', 'updatedAt'].some(key => {
        const value = eventTime({ at: record[key] });
        return record[key] !== undefined && (!Number.isFinite(value) || value > now);
      });
      if ((lifecycle && typeof jobId(record) !== 'string') || (timed && !Number.isFinite(at)) || invalidTime) throw new Error('invalid lifecycle');
      rows.push(record);
    } catch { dropped++; }
  }
  return { rows, dropped };
}
export function validJobEvents(text: string, now = Infinity): boolean { return events(text, now).dropped === 0; }

export async function enrichIdeas(report: IdeaListReport, root: string, dropId: (id: string) => string): Promise<IdeaListReport> {
  const paths: [SignalName, string][] = [['vision', 'leader/VISION.md'], ['queue', 'queue/router-queue.md'], ['mason-inbox', 'leader/MASON-INBOX.md'], ['job-events', 'metrics/jobs.jsonl']];
  const sources = await Promise.all(paths.map(async ([name, path]) => {
    const source = await readSource(join(root, path), 4 * 1024 * 1024, name === 'job-events');
    const ok = source.state === 'healthy' && (name !== 'job-events' || validJobEvents(source.text, Date.parse(report.generatedAt)));
    report.signals.push({ name, status: ok ? 'ok' : 'unknown', reason: ok ? null : `${path} ${source.state === 'healthy' ? 'contains malformed event lines' : source.state}` });
    return source.state === 'healthy' ? source.text : '';
  }));
  // Promise completion order is filesystem-dependent; the wire order is fixed.
  const signalOrder = ['empty-launches', 'guardian-fixups', 'disk-trend', 'idle-lanes', 'unspent-usage', ...paths.map(([name]) => name)];
  report.signals.sort((a, b) => signalOrder.indexOf(a.name) - signalOrder.indexOf(b.name));
  const [vision = '', queue = '', inbox = '', ledger = ''] = sources;
  const queued = new Set(parseIdeas('', queue).map(idea => idea.id));
  // Scores are a transparent leverage heuristic: explicit owner requests 85, VISION 70, queued work 60.
  for (const plan of parseIdeas(vision, queue)) {
    const fromQueue = queued.has(plan.id);
    const title = clean(plan.goal);
    report.ideas.push({ id: `plan:${plan.id.toLowerCase()}`, signal: fromQueue ? 'queue' : 'vision', title,
      evidence: { jobId: plan.id, repo: plan.repo, preferredLane: plan.lane }, payoff: { score: fromQueue ? 60 : 70, text: 'Advance an explicit fleet priority' },
      task: title, why: `${fromQueue ? 'Ready queue' : 'Leader VISION'} names ${plan.id}.`, lane: plan.lane,
      status: fromQueue ? 'queued' : 'proposed' });
  }
  for (const entry of parseInbox(inbox, 100)) {
    const task = clean(entry.text);
    if (!task || !/^\d{4}-\d{2}-\d{2}/.test(entry.at)) continue;
    report.ideas.push({ id: `mason-inbox:${hash(entry.id ?? `${entry.at}:${entry.source}:${entry.text}`)}`, signal: 'mason-inbox',
      title: task.slice(0, 180), task, evidence: { requestedAt: entry.at }, payoff: { score: 85, text: 'Deliver a request from Mason' },
      why: `Mason request in the leader inbox (${clean(entry.source)}, ${clean(entry.at)}).`, lane: 'claude', status: 'proposed' });
  }
  const lifecycle = new Map<string, BottleneckIdea['status']>();
  const launches = new Map<string, number>();
  for (const row of events(ledger, Date.parse(report.generatedAt)).rows.sort((a, b) => (eventTime(a) || 0) - (eventTime(b) || 0))) {
    if (typeof jobId(row) !== 'string') continue; // concurrency telemetry is not a job.
    const id = String(jobId(row));
    const phase = String(phaseOf(row) ?? '').toUpperCase();
    const event = String(row.event ?? row.type ?? row.kind ?? '').toLowerCase();
    const merged = phase === 'MERGED' || event === 'merged' || [row.merged_at, row.mergedAt].some(at => typeof at === 'string' && Number.isFinite(Date.parse(at)));
    if (merged) lifecycle.set(id, 'shipped');
    else if (lifecycle.get(id) !== 'shipped') {
      if (event === 'launch') { lifecycle.set(id, 'running'); launches.set(id, eventTime(row)); }
      else if (['queued', 'enqueue'].includes(event)) lifecycle.set(id, 'queued');
      // Finished/published is not evidence of a live run or of shipment.
      else if (['finish', 'outcome', 'publish'].includes(event) || ['PUBLISHED', 'CLOSED', 'FAILED'].includes(phase)) lifecycle.set(id, 'proposed');
    }
  }
  for (const [id, at] of launches) {
    const hours = (Date.parse(report.generatedAt) - at) / 3_600_000;
    if (lifecycle.get(id) !== 'running' || !Number.isFinite(hours) || hours < 6 || hours > 72 || !/^RQ-[A-Za-z0-9_-]+$/.test(id)) continue;
    const title = `Check ${id}, still open after ${Math.floor(hours)} hours`;
    report.ideas.push({ id: `stuck:${id.toLowerCase()}`, signal: 'job-events', title, task: `${title}. Verify whether it is still running, inspect its notes, and fix the cause if it is stuck.`,
      evidence: { stuckJobId: id, hoursSinceLaunch: Math.floor(hours) }, payoff: { score: Math.min(90, 50 + Math.floor(hours)), text: 'Recover capacity tied up in a long-running job' },
      why: 'The local job ledger records a launch with no later finish or merge.', lane: 'claude', status: 'proposed' });
  }
  await Promise.all(report.ideas.map(async idea => {
    const derived = `RQ-PHX-${dropId(idea.id)}`;
    const state = lifecycle.get(derived) ?? lifecycle.get(String(idea.evidence.jobId));
    if (state) idea.status = state;
    else {
      const pending = await Promise.all(['leader/drop/claude', 'queue/prompts'].map(dir => readSource(join(root, dir, `${derived}.md`), 8000, false)));
      if (pending.some(source => source.state === 'healthy')) { idea.status = 'queued'; idea.evidence.jobId = derived; }
    }
    if (lifecycle.has(derived)) idea.evidence.jobId = derived;
    if (state === 'proposed') {
      idea.evidence.existingJobId = String(idea.evidence.jobId);
      idea.why += ' The previous attempt ended without merge evidence; review it before proposing a follow-up.';
    }
    // Fit the current drop-writer contract; retain any requested lane in the evidence.
    if (!DROP_JOB_LANES.includes(idea.lane as typeof DROP_JOB_LANES[number])) idea.lane = 'claude';
  }));
  report.ideas.sort((a, b) => b.payoff.score - a.payoff.score || a.id.localeCompare(b.id));
  return report;
}
