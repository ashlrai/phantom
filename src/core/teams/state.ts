/**
 * Pure fold over the team log + the guarded operations (claims, handoffs,
 * approvals) that need a consistent read-then-append under the team lock.
 */
import { assertLocalHuman } from './identity.js';
import {
  CONSEQUENTIAL_ACTIONS, claimsOverlap, validId,
  type ClaimTarget, type ConsequentialAction, type TeamActor, type TeamEvent, type TeamRole,
} from './protocol.js';
import { appendUnlocked, readEvents, withTeamLock } from './store.js';

export const PRESENCE_WINDOW_MS = 5 * 60_000;
export const DEFAULT_CLAIM_TTL_MS = 2 * 60 * 60_000;

export interface Member { id: string; kind: TeamActor['kind']; role: TeamRole; provider?: string; onBehalfOf?: string; capabilities: string[]; lastSeen: string; online: boolean; status?: string }
export interface Claim { id: string; target: ClaimTarget; holder: string; reason: string; acquiredAt: string; expiresAt: string }
export type HandoffState = 'awaiting-approval' | 'open' | 'accepted' | 'completed' | 'declined';
export interface Handoff { id: string; from: string; to: string | null; title: string; detail: string; action: ConsequentialAction | null; contextRefs: string[]; state: HandoffState; approvalId: string | null; assignee: string | null; result: string | null; updatedAt: string }
export interface Approval { id: string; handoffId: string; action: ConsequentialAction; requestedBy: string; state: 'pending' | 'approved' | 'denied'; decidedBy: string | null }
export interface TeamState { team: string; members: Member[]; claims: Claim[]; handoffs: Handoff[]; approvals: Approval[]; messages: { id: string; from: string; channel: string; text: string; ts: string }[]; eventCount: number }

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

export function foldTeam(team: string, events: TeamEvent[], now = Date.now()): TeamState {
  const members = new Map<string, Member>();
  const claims = new Map<string, Claim>();
  const handoffs = new Map<string, Handoff>();
  const approvals = new Map<string, Approval>();
  const messages: TeamState['messages'] = [];
  let foundingHumanJoined = false;
  const touch = (a: TeamActor, ts: string) => {
    const m = members.get(a.id);
    if (m) { m.lastSeen = ts; return m; }
    const created: Member = { id: a.id, kind: a.kind, role: a.kind === 'agent' ? 'agent' : 'member', provider: a.provider, onBehalfOf: a.onBehalfOf, capabilities: [], lastSeen: ts, online: false };
    members.set(a.id, created);
    return created;
  };
  for (const ev of events) {
    const p = ev.payload;
    const m = touch(ev.actor, ev.ts);
    switch (ev.type) {
      case 'member.joined': {
        const target = str(p.memberId, ev.actor.id);
        const role = p.role as TeamRole | undefined;
        // Presence, claims and declared caller aliases cannot found ownership.
        // The CLI derives the joining human locally; raw logs retain their
        // documented same-OS-user trust boundary.
        if (ev.actor.kind === 'human' && m.kind === 'human' && target === ev.actor.id && !foundingHumanJoined) {
          if (![...members.values()].some(member => member.kind === 'human' && ['owner', 'admin'].includes(member.role))) m.role = 'owner';
          foundingHumanJoined = true;
        }
        const existing = members.get(target);
        const humanRole = role && ['owner', 'admin', 'member'].includes(role);
        const humanRoleGrant = ev.actor.kind === 'human' && m.kind === 'human' && ['owner', 'admin'].includes(m.role);
        if (existing?.kind === 'human' && humanRole && (ev.actor.id === target ? existing.role === role : humanRoleGrant)) existing.role = role;
        else if (!existing && target.startsWith('human:') && humanRole && humanRoleGrant) members.set(target, { id: target, kind: 'human', role, capabilities: [], lastSeen: ev.ts, online: false });
        break;
      }
      case 'agent.registered':
        m.capabilities = Array.isArray(p.capabilities) ? (p.capabilities as unknown[]).filter((c): c is string => typeof c === 'string').slice(0, 32) : [];
        break;
      case 'presence.heartbeat': m.status = str(p.status) || undefined; break;
      case 'message.posted': messages.push({ id: ev.id, from: ev.actor.id, channel: str(p.channel, 'general'), text: str(p.text), ts: ev.ts }); break;
      case 'claim.acquired': claims.set(ev.id, { id: ev.id, target: p.target as ClaimTarget, holder: ev.actor.id, reason: str(p.reason), acquiredAt: ev.ts, expiresAt: str(p.expiresAt) }); break;
      case 'claim.released': { const c = claims.get(str(p.claimId)); if (c && (c.holder === ev.actor.id || ['owner', 'admin'].includes(m.role))) claims.delete(c.id); break; }
      case 'handoff.requested': {
        const action = (CONSEQUENTIAL_ACTIONS as readonly string[]).includes(str(p.action)) ? p.action as ConsequentialAction : null;
        handoffs.set(ev.id, { id: ev.id, from: ev.actor.id, to: str(p.to) || null, title: str(p.title), detail: str(p.detail), action, contextRefs: Array.isArray(p.contextRefs) ? (p.contextRefs as string[]).slice(0, 20) : [], state: action ? 'awaiting-approval' : 'open', approvalId: null, assignee: null, result: null, updatedAt: ev.ts });
        break;
      }
      case 'approval.requested': {
        const h = handoffs.get(str(p.handoffId));
        if (h?.action) { approvals.set(ev.id, { id: ev.id, handoffId: h.id, action: h.action, requestedBy: ev.actor.id, state: 'pending', decidedBy: null }); h.approvalId = ev.id; }
        break;
      }
      case 'approval.decided': {
        const a = approvals.get(str(p.approvalId));
        // Only humans with owner/admin role can decide; agents never self-approve.
        if (a && a.state === 'pending' && ev.actor.kind === 'human' && m.kind === 'human' && ['owner', 'admin'].includes(m.role)) {
          a.state = p.decision === 'approve' ? 'approved' : 'denied'; a.decidedBy = ev.actor.id;
          const h = handoffs.get(a.handoffId);
          if (h) { h.state = a.state === 'approved' ? 'open' : 'declined'; h.updatedAt = ev.ts; }
        }
        break;
      }
      case 'handoff.accepted': { const h = handoffs.get(str(p.handoffId)); if (h?.state === 'open' && (!h.to || h.to === ev.actor.id)) { h.state = 'accepted'; h.assignee = ev.actor.id; h.updatedAt = ev.ts; } break; }
      case 'handoff.completed': { const h = handoffs.get(str(p.handoffId)); if (h?.state === 'accepted' && h.assignee === ev.actor.id) { h.state = 'completed'; h.result = str(p.result); h.updatedAt = ev.ts; } break; }
      case 'handoff.declined': { const h = handoffs.get(str(p.handoffId)); if (h && h.state !== 'completed' && (h.to === ev.actor.id || h.from === ev.actor.id)) { h.state = 'declined'; h.updatedAt = ev.ts; } break; }
      case 'context.added': break;
    }
  }
  for (const mem of members.values()) mem.online = now - Date.parse(mem.lastSeen) < PRESENCE_WINDOW_MS;
  for (const c of claims.values()) if (Date.parse(c.expiresAt) <= now) claims.delete(c.id);
  return { team, members: [...members.values()], claims: [...claims.values()], handoffs: [...handoffs.values()], approvals: [...approvals.values()], messages: messages.slice(-50), eventCount: events.length };
}

export function teamState(team: string): TeamState { return foldTeam(team, readEvents(team)); }

export function acquireClaim(team: string, actor: TeamActor, target: ClaimTarget, reason: string, ttlMs = DEFAULT_CLAIM_TTL_MS) {
  if (!target || typeof target.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(target.repo)) throw new Error('target.repo must be owner/name.');
  const ttl = Math.min(Math.max(ttlMs, 60_000), 24 * 60 * 60_000);
  return withTeamLock(team, () => {
    const state = teamState(team);
    const conflicts = state.claims.filter((c) => c.holder !== actor.id && claimsOverlap(c.target, target));
    if (conflicts.length) return { ok: false as const, conflicts };
    const ev = appendUnlocked(team, actor, 'claim.acquired', { target: { repo: target.repo, ...(target.branch ? { branch: target.branch } : {}), ...(target.path ? { path: target.path } : {}) }, reason, expiresAt: new Date(Date.now() + ttl).toISOString() });
    return { ok: true as const, claimId: ev.id, expiresAt: ev.payload.expiresAt };
  });
}

export function releaseClaim(team: string, actor: TeamActor, claimId: string) {
  return withTeamLock(team, () => {
    const c = teamState(team).claims.find((x) => x.id === claimId);
    if (!c) throw new Error('No active claim with that id.');
    if (c.holder !== actor.id) throw new Error('Only the holder can release this claim.');
    appendUnlocked(team, actor, 'claim.released', { claimId });
    return { released: claimId };
  });
}

export function requestHandoff(team: string, actor: TeamActor, input: { to?: string; title: string; detail?: string; action?: string; contextRefs?: string[] }) {
  if (!input.title?.trim()) throw new Error('title is required.');
  if (input.to && !validId(input.to)) throw new Error('Invalid recipient id.');
  return withTeamLock(team, () => {
    const ev = appendUnlocked(team, actor, 'handoff.requested', { to: input.to ?? '', title: input.title.slice(0, 200), detail: (input.detail ?? '').slice(0, 4000), action: input.action ?? '', contextRefs: (input.contextRefs ?? []).slice(0, 20) });
    const h = teamState(team).handoffs.find((x) => x.id === ev.id)!;
    if (h.action) {
      const ap = appendUnlocked(team, actor, 'approval.requested', { handoffId: h.id });
      return { handoffId: h.id, state: 'awaiting-approval', approvalId: ap.id, note: `"${h.action}" needs a human owner/admin: phm team approve ${ap.id}` };
    }
    return { handoffId: h.id, state: h.state };
  });
}

export function transitionHandoff(team: string, actor: TeamActor, handoffId: string, op: 'accept' | 'complete' | 'decline', result?: string) {
  return withTeamLock(team, () => {
    const type = op === 'accept' ? 'handoff.accepted' : op === 'complete' ? 'handoff.completed' : 'handoff.declined';
    const before = teamState(team).handoffs.find((h) => h.id === handoffId);
    if (!before) throw new Error('Unknown handoff.');
    appendUnlocked(team, actor, type, { handoffId, ...(result ? { result: result.slice(0, 4000) } : {}) });
    const after = teamState(team).handoffs.find((h) => h.id === handoffId)!;
    if (after.state === before.state) throw new Error(`Cannot ${op} a handoff in state "${before.state}"${before.state === 'awaiting-approval' ? ' (needs human approval)' : ''}.`);
    return { handoffId, state: after.state };
  });
}

export function decideApproval(team: string, actor: TeamActor, approvalId: string, decision: 'approve' | 'deny') {
  if (actor.kind !== 'human') throw new Error('Only humans can decide approvals.');
  actor = assertLocalHuman(actor);
  return withTeamLock(team, () => {
    appendUnlocked(team, actor, 'approval.decided', { approvalId, decision });
    const a = teamState(team).approvals.find((x) => x.id === approvalId);
    if (!a || a.decidedBy !== actor.id) throw new Error('Approval not applied (unknown id, already decided, or you are not an owner/admin).');
    return { approvalId, state: a.state };
  });
}
