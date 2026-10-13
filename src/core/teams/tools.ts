/** MCP tool handlers for the team protocol (registered in mcp-native.ts). */
import { CONSEQUENTIAL_ACTIONS, validId, type TeamActor } from './protocol.js';
import { appendEvent } from './store.js';
import { acquireClaim, releaseClaim, requestHandoff, teamState, transitionHandoff } from './state.js';
import { addContext, retrieveContext, type ContextScope } from './context.js';

export const DEFAULT_TEAM = 'default';
const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** MCP callers are always agents; humans act through the CLI/UI. */
export function agentActor(args: Record<string, unknown>): TeamActor {
  const id = s(args.agentId);
  if (!validId(id)) throw new Error('agentId is required (e.g. "agent:claude-code/mason").');
  const actorId = id.startsWith('agent:') ? id : `agent:${id}`;
  return { kind: 'agent', id: actorId, ...(s(args.provider) ? { provider: s(args.provider) } : {}), ...(s(args.onBehalfOf) ? { onBehalfOf: s(args.onBehalfOf) } : {}) };
}
const team = (args: Record<string, unknown>): string => s(args.team) ?? DEFAULT_TEAM;

export async function teamRegister(args: Record<string, unknown>) {
  const actor = agentActor(args);
  const caps = Array.isArray(args.capabilities) ? args.capabilities.filter((c): c is string => typeof c === 'string') : [];
  const ev = appendEvent(team(args), actor, 'agent.registered', { capabilities: caps.slice(0, 32) });
  return { registered: actor.id, eventId: ev.id };
}
export async function teamPublish(args: Record<string, unknown>) {
  const actor = agentActor(args);
  if (s(args.status)) return { eventId: appendEvent(team(args), actor, 'presence.heartbeat', { status: s(args.status)!.slice(0, 200) }).id };
  const text = s(args.text);
  if (!text) throw new Error('text or status is required.');
  return { eventId: appendEvent(team(args), actor, 'message.posted', { channel: s(args.channel) ?? 'general', text: text.slice(0, 4000) }).id };
}
export async function teamView(args: Record<string, unknown>) {
  const st = teamState(team(args));
  const since = s(args.since);
  return { ...st, messages: since ? st.messages.filter((m) => m.id > since) : st.messages.slice(-20) };
}
export async function teamClaim(args: Record<string, unknown>) {
  const actor = agentActor(args);
  if (args.op === 'release') return releaseClaim(team(args), actor, s(args.claimId) ?? '');
  return acquireClaim(team(args), actor, { repo: s(args.repo) ?? '', branch: s(args.branch), path: s(args.path) }, s(args.reason) ?? '', typeof args.ttlMinutes === 'number' ? args.ttlMinutes * 60_000 : undefined);
}
export async function teamHandoff(args: Record<string, unknown>) {
  const actor = agentActor(args);
  const op = s(args.op) ?? 'request';
  if (op === 'request') return requestHandoff(team(args), actor, { to: s(args.to), title: s(args.title) ?? '', detail: s(args.detail), action: s(args.action), contextRefs: Array.isArray(args.contextRefs) ? args.contextRefs.filter((x): x is string => typeof x === 'string') : [] });
  if (op === 'accept' || op === 'complete' || op === 'decline') return transitionHandoff(team(args), actor, s(args.handoffId) ?? '', op, s(args.result));
  throw new Error('op must be request, accept, complete or decline.');
}
const scopeOf = (args: Record<string, unknown>): ContextScope => ({ owner: (s(args.owner) ?? 'company') as ContextScope['owner'], project: s(args.project), person: s(args.person) });
export async function teamContextAdd(args: Record<string, unknown>) {
  return addContext(team(args), agentActor(args), { title: s(args.title) ?? '', text: s(args.text) ?? '', source: s(args.source) ?? '', scope: scopeOf(args), tags: Array.isArray(args.tags) ? args.tags.filter((x): x is string => typeof x === 'string') : [] });
}
export async function teamContextGet(args: Record<string, unknown>) {
  return retrieveContext(team(args), { query: s(args.query) ?? '', scope: scopeOf(args), budgetTokens: typeof args.budgetTokens === 'number' ? args.budgetTokens : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined });
}

const ID = { type: 'string', description: 'Your stable agent id, e.g. "grok-bot/mason" or "codex/acct-2".' };
const TEAM = { type: 'string', description: 'Team id (default "default").' };
const SCOPE = {
  owner: { type: 'string', description: 'personal | company | client:<name> (Locus owner scope). Client context never crosses clients.' },
  project: { type: 'string' }, person: { type: 'string' },
};
export const TEAM_TOOL_SCHEMAS = {
  phm_team_register: { type: 'object', properties: { team: TEAM, agentId: ID, provider: { type: 'string' }, onBehalfOf: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string' } } }, required: ['agentId'], additionalProperties: false },
  phm_team_publish: { type: 'object', properties: { team: TEAM, agentId: ID, channel: { type: 'string' }, text: { type: 'string' }, status: { type: 'string', description: 'Presence/status heartbeat instead of a message.' } }, required: ['agentId'], additionalProperties: false },
  phm_team_view: { type: 'object', properties: { team: TEAM, since: { type: 'string', description: 'Only messages after this event id.' } }, additionalProperties: false },
  phm_team_claim: { type: 'object', properties: { team: TEAM, agentId: ID, op: { type: 'string', enum: ['acquire', 'release'] }, repo: { type: 'string', description: 'owner/name' }, branch: { type: 'string' }, path: { type: 'string' }, reason: { type: 'string' }, ttlMinutes: { type: 'number' }, claimId: { type: 'string' } }, required: ['agentId'], additionalProperties: false },
  phm_team_handoff: { type: 'object', properties: { team: TEAM, agentId: ID, op: { type: 'string', enum: ['request', 'accept', 'complete', 'decline'] }, to: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, action: { type: 'string', enum: [...CONSEQUENTIAL_ACTIONS], description: 'Set for consequential work; a human owner/admin must approve before anyone can accept.' }, contextRefs: { type: 'array', items: { type: 'string' } }, handoffId: { type: 'string' }, result: { type: 'string' } }, required: ['agentId'], additionalProperties: false },
  phm_team_context_add: { type: 'object', properties: { team: TEAM, agentId: ID, title: { type: 'string' }, text: { type: 'string' }, source: { type: 'string', description: 'Provenance: URL, path@sha, PR, or thread id.' }, tags: { type: 'array', items: { type: 'string' } }, ...SCOPE }, required: ['agentId', 'title', 'text', 'source', 'owner'], additionalProperties: false },
  phm_team_context_get: { type: 'object', properties: { team: TEAM, query: { type: 'string' }, budgetTokens: { type: 'number' }, limit: { type: 'number' }, ...SCOPE }, required: ['query', 'owner'], additionalProperties: false },
} as const;
