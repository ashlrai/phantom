/** Pure view model for GET /api/verse/agent-bus/messages (the `phm messages` read). */
import type { AgentMessage, AgentMessages, AgentRef } from '../../../../core/fleet/agent-messages.js';

export type { AgentMessage, AgentMessages, AgentRef };
export const MESSAGE_KINDS = ['ask', 'reply', 'handoff', 'status', 'blocker'] as const;
export const TALKING_WINDOW_MS = 15 * 60_000;

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string';
const nullable = (x: unknown) => x === null || text(x);
const ref = (x: unknown): x is AgentRef => record(x) && text(x.name) && nullable(x.lane);
const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;

/** Reject anything that is not the agent-messages.v1 shape; never guess. */
export function narrowAgentMessages(x: unknown): AgentMessages | null {
  if (!record(x) || x.schema !== 'agent-messages.v1' || !['available', 'missing', 'unavailable'].includes(String(x.source))
    || !count(x.matched) || !count(x.skipped) || !Array.isArray(x.messages)) return null;
  const ok = x.messages.every(m => record(m) && text(m.id) && text(m.ts) && Number.isFinite(Date.parse(m.ts))
    && ['P0', 'P1', 'P2', 'P3'].includes(String(m.priority))
    && ref(m.from) && ref(m.to) && MESSAGE_KINDS.includes(m.kind as never) && text(m.summary) && text(m.conversation)
    && nullable(m.job) && nullable(m.pr));
  return ok ? x as unknown as AgentMessages : null;
}

export interface Conversation { id: string; agents: AgentRef[]; messages: AgentMessage[]; lastTs: string; job: string | null }

/** Newest conversation first; each conversation reads oldest to newest. */
export function groupConversations(messages: readonly AgentMessage[]): Conversation[] {
  const groups = new Map<string, AgentMessage[]>();
  for (const m of messages) groups.set(m.conversation, [...groups.get(m.conversation) ?? [], m]);
  return [...groups.entries()].map(([id, rows]) => {
    const ordered = [...rows].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const agents = new Map<string, AgentRef>();
    for (const m of ordered) { agents.set(m.from.name, m.from); agents.set(m.to.name, m.to); }
    return { id, agents: [...agents.values()], messages: ordered, lastTs: ordered[ordered.length - 1]!.ts,
      job: [...ordered].reverse().find(m => m.job)?.job ?? null };
  }).sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs) || a.id.localeCompare(b.id));
}

export function agentNames(messages: readonly AgentMessage[]): string[] {
  return [...new Set(messages.flatMap(m => [m.from.name, m.to.name]))].sort((a, b) => a.localeCompare(b));
}

/** Same match as `phm messages --agent`: name or lane, either side. */
export function byAgent(messages: readonly AgentMessage[], agent: string): AgentMessage[] {
  if (!agent) return [...messages];
  const want = agent.toLowerCase();
  return messages.filter(m => [m.from.name, m.to.name, m.from.lane, m.to.lane].some(v => v?.toLowerCase() === want));
}

export interface TalkLine { conversation: string; a: AgentRef; b: AgentRef; messages: number; lastTs: string }
/** One line per conversation between two distinct agents in the last 15 minutes. */
export function talkingNow(messages: readonly AgentMessage[], now = Date.now()): TalkLine[] {
  const recent = messages.filter(m => { const at = Date.parse(m.ts); return at <= now && now - at <= TALKING_WINDOW_MS && m.from.name !== m.to.name; });
  return groupConversations(recent).map(c => {
    const first = c.messages[0]!;
    return { conversation: c.id, a: first.from, b: first.to, messages: c.messages.length, lastTs: c.lastTs };
  });
}

export const who = (agent: AgentRef) => `${agent.name} · ${agent.lane ?? 'lane unknown'}`;
