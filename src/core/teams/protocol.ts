/**
 * Phantom Teams protocol v1 (docs/architecture/teams.md).
 *
 * One append-only, event-sourced log per team. Humans and agents (Claude Code,
 * Codex, Grok Bot, Meta Muse, OpenAI dots, Devin, local models) are all
 * "actors" that publish typed events; everything else (presence, claims,
 * handoffs, approvals) is a pure fold over the log, so a self-hosted sync
 * service only has to replicate lines, never merge state.
 *
 * Secrets never enter the log: payload text is scrubbed and rejected if it
 * contained anything credential-shaped. Use phantom-secrets `phm_` references.
 */

export const TEAM_PROTOCOL_VERSION = 1 as const;

export type ActorKind = 'human' | 'agent';
export type TeamRole = 'owner' | 'admin' | 'member' | 'agent';
/** Locus-style ownership boundary; context never crosses client boundaries. */
export type OwnerScope = 'personal' | 'company' | `client:${string}`;

export interface TeamActor {
  kind: ActorKind;
  /** Stable id, e.g. `human:mason` or `agent:grok-bot/mason`. */
  id: string;
  /** Agent runtime/provider, e.g. claude-code, codex, grok-bot, meta-muse, openai-dot, devin, local. */
  provider?: string;
  /** For agents: the human accountable for them. */
  onBehalfOf?: string;
}

export const TEAM_EVENT_TYPES = [
  'member.joined',
  'agent.registered',
  'presence.heartbeat',
  'message.posted',
  'handoff.requested',
  'handoff.accepted',
  'handoff.completed',
  'handoff.declined',
  'claim.acquired',
  'claim.released',
  'approval.requested',
  'approval.decided',
  'context.added',
] as const;
export type TeamEventType = typeof TEAM_EVENT_TYPES[number];

export interface TeamEvent<P = Record<string, unknown>> {
  v: typeof TEAM_PROTOCOL_VERSION;
  /** Sortable unique id: `<ms base36>-<random>`. */
  id: string;
  ts: string;
  team: string;
  actor: TeamActor;
  type: TeamEventType;
  payload: P;
}

/** Actions that must be approved by a human owner/admin before acceptance. */
export const CONSEQUENTIAL_ACTIONS = ['push-main', 'deploy', 'release', 'merge', 'rotate-secret', 'external-message', 'delete', 'spend'] as const;
export type ConsequentialAction = typeof CONSEQUENTIAL_ACTIONS[number];

export interface ClaimTarget { repo: string; branch?: string; path?: string }

/** Two claims collide when they share a repo and neither narrows away from the other. */
export function claimsOverlap(a: ClaimTarget, b: ClaimTarget): boolean {
  if (a.repo.toLowerCase() !== b.repo.toLowerCase()) return false;
  if (a.branch && b.branch && a.branch !== b.branch) return false;
  if (a.path && b.path) {
    const norm = (p: string) => p.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    const pa = norm(a.path); const pb = norm(b.path);
    return pa === pb || pa.startsWith(pb + '/') || pb.startsWith(pa + '/') || pa === '' || pb === '';
  }
  return true;
}

const ID_RE = /^[a-z0-9][a-z0-9._:/@-]{0,127}$/i;
export function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

export function validOwnerScope(value: unknown): value is OwnerScope {
  return value === 'personal' || value === 'company' || (typeof value === 'string' && /^client:[a-z0-9][a-z0-9._-]{0,63}$/i.test(value));
}
