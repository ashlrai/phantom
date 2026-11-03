import type { stopJob } from '../fleet/job-stop.js';
import { ReassignError, type ReassignCode, type reassignQueuedJobs } from '../fleet/runs-reassign.js';
import { STRAY_ID_PATTERN } from '../fleet/stray-slots.js';

const validId = (id: string): boolean => STRAY_ID_PATTERN.test(id) && !id.includes('..');
const displayToken = (value: string): boolean => /^[a-z0-9-]{1,80}$/.test(value);

export function parseStopCommand(text: string): { id: string } | null {
  const match = /^\s*\/stop(?:@\w+)?\s+(\S+)\s*$/i.exec(text);
  const id = match?.[1];
  return id && validId(id) ? { id } : null;
}

export function parseReassignCommand(text: string): { id: string; lane: string; tier?: string } | null {
  const match = /^\s*\/reassign(?:@\w+)?\s+(\S+)\s+(\S+)(?:\s+(\S+))?\s*$/i.exec(text);
  const id = match?.[1];
  const lane = match?.[2];
  const tier = match?.[3];
  return id && validId(id) && lane
    ? { id, lane, ...(tier === undefined ? {} : { tier }) } : null;
}

export type JobCommandReply =
  | { status: 'usage'; command: 'stop' | 'reassign' }
  | { status: 'stopped'; id: string; processes: number }
  | { status: 'not-running'; id: string }
  | { status: 'moved'; id: string; lane: string; tier: string }
  | { status: 'refused'; reason: ReassignCode }
  | { status: 'failed'; command: 'stop' | 'reassign' };

const REFUSALS: Record<ReassignCode, string> = {
  'job-not-found': 'queued job not found', 'job-launched': 'job already launched',
  'job-parked': 'job is parked', 'lane-unknown': 'lane is unknown',
  'lane-same': 'job already has that lane and tier', 'lane-down': 'lane is down',
  'lane-held': 'lane is held', 'tier-unknown': 'tier is unknown', 'queue-missing': 'queue is unavailable',
};

/** Only fixed failure text is exposed; filesystem errors may contain secrets. */
export function renderJobCommandReply(result: JobCommandReply): string {
  switch (result.status) {
    case 'usage': return result.command === 'stop' ? 'Usage: /stop <JOB-ID>' : 'Usage: /reassign <JOB-ID> <lane> [tier]';
    case 'stopped': return `Stopped ${result.id} (${result.processes} processes).`;
    case 'not-running': return `${result.id} not running.`;
    case 'moved': return `Moved ${result.id} to ${result.lane}/${result.tier}.`;
    case 'refused': return `Reassign refused: ${REFUSALS[result.reason]}.`;
    case 'failed': return result.command === 'stop' ? 'Stop failed: job stop unavailable.' : 'Reassign failed: job reassign unavailable.';
  }
}

export interface TelegramJobCommandDeps {
  stopJob: typeof stopJob;
  reassignQueuedJobs: typeof reassignQueuedJobs;
}

export async function runTelegramJobCommand(text: string, deps: TelegramJobCommandDeps): Promise<JobCommandReply> {
  const command = /^\s*\/stop(?:@\w+)?(?:\s|$)/i.test(text) ? 'stop' : 'reassign';
  try {
    if (command === 'stop') {
      const request = parseStopCommand(text);
      if (!request) return { status: 'usage', command };
      const result = await deps.stopJob(request.id, { by: 'telegram' });
      if (result.outcome === 'stopped') return { status: 'stopped', id: request.id, processes: result.pids.length };
      if (result.outcome === 'not-running') return { status: 'not-running', id: request.id };
    } else {
      const request = parseReassignCommand(text);
      if (!request) return { status: 'usage', command };
      const result = await deps.reassignQueuedJobs({ job: request.id, lane: request.lane, tier: request.tier, apply: true, force: false }, { changedBy: 'telegram' });
      const move = result.applied && result.moved.find(row => row.id === request.id && row.toLane === request.lane);
      // Membership validation belongs to runs-reassign. Bound only what can be displayed.
      if (move && displayToken(move.toLane) && displayToken(move.toTier)) {
        return { status: 'moved', id: request.id, lane: move.toLane, tier: move.toTier };
      }
    }
  } catch (error) {
    if (command === 'reassign' && error instanceof ReassignError && Object.hasOwn(REFUSALS, error.code)) {
      return { status: 'refused', reason: error.code };
    }
  }
  return { status: 'failed', command };
}
