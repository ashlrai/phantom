/**
 * One drain tick plans assignments and can append the decision log.
 * It does not spawn a CLI, open a pull request, or merge.
 */

import type { JobShape } from '../../../decide/job-shape.js';
import { classifyJob } from '../../../decide/job-shape.js';
import type { TierFloor } from '../../../resources/pool-spend.js';
import type { IssueJob } from '../worker-plan.js';
import { appendRouterDecision } from './log.js';
import { schedule, type ScheduleInput, type ScheduleResult } from './solve.js';
import { emitSchedule, type SchedulerTelemetry } from './telemetry.js';
import { isJobKind, type JobKind, type SchedulerJob, type SchedulerRole } from './types.js';

const HEAVY: ReadonlySet<JobKind> = new Set(['coding', 'investigation', 'test-fixing', 'research']);

export interface DrainTickInput extends Omit<ScheduleInput, 'jobs'> {
  jobs?: readonly SchedulerJob[];
  issues?: readonly IssueJob[];
  classify?: (text: string) => Promise<JobShape>;
  decisionLogPath?: string;
  telemetry?: SchedulerTelemetry;
}

export interface DrainTickResult extends ScheduleResult {
  spawned: false;
  merged: false;
}

function kindFromText(issue: IssueJob): JobKind {
  for (const label of issue.labels) {
    const match = /^kind:(.+)$/.exec(label);
    if (match?.[1] && isJobKind(match[1])) return match[1];
  }
  const text = `${issue.title}\n${issue.body}`;
  if (/\bmerge\b/i.test(text)) return 'merge-decision';
  if (/\breview\b/i.test(text)) return 'review';
  if (/\b(investigate|investigation)\b/i.test(text)) return 'investigation';
  if (/\b(test|failing tests|ci)\b/i.test(text)) return 'test-fixing';
  if (/\bresearch\b/i.test(text)) return 'research';
  if (/\borchestrat/i.test(text)) return 'orchestration';
  return 'coding';
}

function tierFromShape(shape: JobShape, kind: JobKind): TierFloor {
  if (kind === 'merge-decision' || shape.complexity === 'high' || shape.risk === 'high') return 'frontier';
  if (shape.complexity === 'low' && shape.risk === 'low') return 'cheap';
  return 'workhorse';
}

function roleFromKind(kind: JobKind): SchedulerRole {
  switch (kind) {
    case 'orchestration':
      return 'orchestration';
    case 'review':
      return 'review';
    case 'merge-decision':
      return 'merge';
    case 'coding':
    case 'investigation':
    case 'test-fixing':
    case 'research':
      return 'produce';
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

/** Box agents enqueue heavy work. Jev still classifies complexity and risk. */
export async function jobsFromIssues(issues: readonly IssueJob[], classify: (text: string) => Promise<JobShape> = classifyJob): Promise<SchedulerJob[]> {
  const jobs: SchedulerJob[] = [];
  for (const issue of issues) {
    const kind = kindFromText(issue);
    const shape = await classify(`${issue.title}\n${issue.body}`);
    if (!HEAVY.has(kind) && kind !== 'orchestration' && kind !== 'review' && kind !== 'merge-decision') continue;
    jobs.push({
      id: `issue-${issue.number}`,
      jobType: kind,
      role: roleFromKind(kind),
      minTier: tierFromShape(shape, kind),
    });
  }
  return jobs;
}

export async function runDrainTick(input: DrainTickInput): Promise<DrainTickResult> {
  const jobs = input.jobs ?? await jobsFromIssues(input.issues ?? [], input.classify ?? classifyJob);
  const scheduleInput: ScheduleInput = { ...input, jobs };
  const result = await schedule(scheduleInput);
  if (input.decisionLogPath) {
    for (const row of result.decisions) appendRouterDecision(input.decisionLogPath, row);
  }
  if (input.telemetry) emitSchedule(input.telemetry, result, input.nowMs);
  return { ...result, spawned: false, merged: false };
}
