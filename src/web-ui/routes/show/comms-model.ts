/**
 * routes/show/comms-model.ts — pure projection from the fleet-activity
 * recent-actions feed (GET /api/fleet-activity, capped 20 newest-first)
 * into conversation threads for Show mode's AGENT COMMS panel.
 *
 * Grouping key, in order: runId → proposalId → trajectoryId → actor. The
 * first three are the real "sessions" the fleet talks inside; the actor
 * bucket keeps unattributed daemon/fleet chatter readable instead of
 * dropping it. Thread titles resolve a run's goal off /api/runs data when
 * the run is still inside its 200-row window; otherwise the raw id shows
 * honestly rather than a fabricated name.
 *
 * Messages render oldest→newest inside each thread (threads themselves
 * stay newest-first). Everything shown is a field the action actually
 * carried — actor, kind, outcome, summary, backend, model — no inferred
 * intent.
 */
import type { AgentWorkspaceRecentAction, RunState } from '../../data/api-types.js';

export const ACTION_KIND_LABEL: Record<AgentWorkspaceRecentAction['kind'], string> = {
  tick: 'Tick',
  selection: 'Selected work',
  route: 'Routed',
  dispatch: 'Dispatched',
  proposal: 'Filed proposal',
  verification: 'Verified',
  judge: 'Judged',
  merge: 'Merged',
  guard: 'Guardrail',
  maintenance: 'Maintenance',
  'context-rollup': 'Context rollup',
  reflection: 'Reflection',
};

export type CommsTone = 'good' | 'bad' | 'live' | 'muted';

/** Outcome → tone, mapped to the design system's status semantics. */
export function outcomeTone(outcome: AgentWorkspaceRecentAction['outcome']): CommsTone {
  switch (outcome) {
    case 'ok':
    case 'verified':
    case 'merged':
    case 'proposal-created':
      return 'good';
    case 'failed':
    case 'rejected':
    case 'blocked':
      return 'bad';
    case 'started':
      return 'live';
    default:
      return 'muted';
  }
}

export interface CommsMessage {
  ts: string;
  actor: string;
  kindLabel: string;
  outcome: string;
  tone: CommsTone;
  summary: string;
  repo: string | null;
  backend: string | null;
  model: string | null;
}

export interface CommsThread {
  key: string;
  title: string;
  /** Deep link into the session this thread belongs to, when one exists. */
  href: string | null;
  /** Chronological (oldest→newest), already display-capped. */
  messages: CommsMessage[];
  /** Messages in this thread beyond the display cap. */
  hiddenCount: number;
  latestTs: string;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function actorTitle(actor: string | undefined): string {
  if (!actor) return 'Fleet';
  return actor.charAt(0).toUpperCase() + actor.slice(1);
}

function toMessage(action: AgentWorkspaceRecentAction): CommsMessage {
  return {
    ts: action.ts,
    actor: action.actor ?? 'unknown',
    kindLabel: ACTION_KIND_LABEL[action.kind] ?? action.kind ?? 'Event',
    outcome: action.outcome ?? 'unknown',
    tone: outcomeTone(action.outcome),
    summary: action.proseDigest ?? action.summary ?? action.action,
    repo: action.repo ?? null,
    backend: action.backend ?? null,
    model: action.model ?? null,
  };
}

export function buildCommsThreads(
  actions: AgentWorkspaceRecentAction[] | undefined,
  runs: RunState[] | undefined,
  maxThreads = 5,
  perThread = 3,
): CommsThread[] {
  const runGoals = new Map((runs ?? []).map((run) => [run.id, run.goal] as const));
  const groups = new Map<string, { title: string; href: string | null; messages: CommsMessage[]; latestTs: string }>();

  for (const action of actions ?? []) {
    let key: string;
    let title: string;
    let href: string | null;
    if (action.runId) {
      key = `run:${action.runId}`;
      title = runGoals.get(action.runId) ?? `Run ${shortId(action.runId)}`;
      href = `/work/runs/${encodeURIComponent(action.runId)}`;
    } else if (action.proposalId) {
      key = `proposal:${action.proposalId}`;
      title = `Proposal ${shortId(action.proposalId)}`;
      href = `/inbox/${encodeURIComponent(action.proposalId)}`;
    } else if (action.trajectoryId) {
      key = `trajectory:${action.trajectoryId}`;
      title = `Trajectory ${shortId(action.trajectoryId)}`;
      href = null;
    } else {
      key = `actor:${action.actor ?? 'unknown'}`;
      title = actorTitle(action.actor);
      href = null;
    }
    let group = groups.get(key);
    if (!group) {
      group = { title, href, messages: [], latestTs: action.ts };
      groups.set(key, group);
    }
    group.messages.push(toMessage(action));
  }

  // Input is newest-first; insertion order already ranks threads by their
  // latest message. Flip each thread to chronological for reading.
  return [...groups.entries()].slice(0, maxThreads).map(([key, group]) => {
    const chronological = [...group.messages].reverse();
    return {
      key,
      title: group.title,
      href: group.href,
      messages: chronological.slice(-perThread),
      hiddenCount: Math.max(0, chronological.length - perThread),
      latestTs: group.latestTs,
    };
  });
}
