/** Read-only session-handoff checkpoint for the isolated fleet MCP server. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSessionHandoff } from '../core/agents/session-handoff.js';
import { handoffId } from '../core/agents/session-handoff-schema.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const NOTE = 'Read-only latest session-handoff checkpoint for a job, from this computer\'s journal: where the previous worker stopped (plan, files touched, decisions, evidence, next action). Grants no claim, resume or dispatch authority. Takes only a job id: no caller root, path or cwd is accepted, and the tool never writes.';

export function parseFleetSessionHandoffArgs(args: Record<string, unknown>): { job: string } | null {
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== 'job') return null;
  const job = handoffId.safeParse(args.job);
  return job.success ? { job: job.data } : null;
}

export function readFleetSessionHandoff(
  args: { job: string },
  deps: { runsDir?: string; read?: typeof readSessionHandoff; now?: () => Date } = {},
) {
  const asOf = (deps.now ?? (() => new Date()))().toISOString();
  const base = { v: 1 as const, authority: 'none' as const, asOf, job: args.job, note: NOTE };
  try {
    const r = (deps.read ?? readSessionHandoff)(deps.runsDir ?? join(homedir(), '.ashlr-runs'), args.job);
    // Drop repoState.root (absolute host path) and contextDigest (opaque harness state).
    const checkpoint = {
      revision: r.revision, at: r.at, signal: r.signal, attempt: r.attempt, repo: r.repo, lane: r.lane,
      model: r.model, minTier: r.minTier, needs: r.needs, goal: r.goal, plan: r.plan,
      filesTouched: r.filesTouched, decisions: r.decisions, evidence: r.evidence,
      nextAction: r.nextAction, repoState: { head: r.repoState.head },
    };
    return sanitizePublicJson({ ...base, status: 'ok' as const, checkpoint });
  } catch (error) {
    if (error instanceof Error && error.message === 'No checkpoint available.') {
      return sanitizePublicJson({ ...base, status: 'none' as const });
    }
    return sanitizePublicJson({ ...base, status: 'unavailable' as const, reason: 'session-handoff-reader-failed' });
  }
}
