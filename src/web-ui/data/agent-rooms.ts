import { canonicalModelId } from '../../core/verse/context-math.js';
import type { AgentCard } from '../../core/verse/agents/types.js';

export interface AgentRoom {
  id: string;
  title: string;
  authorId: string;
  reviewerId: string;
}

/** Resolve current board evidence every time; saved membership is never model evidence. */
export function roomMembers(room: Pick<AgentRoom, 'authorId' | 'reviewerId'>, cards: readonly AgentCard[]) {
  const author = cards.find(card => card.id === room.authorId);
  const reviewer = cards.find(card => card.id === room.reviewerId);
  if (!author?.sessionId || !reviewer?.sessionId || author.status === 'archived' || reviewer.status === 'archived' || author.archived || reviewer.archived) {
    throw new Error('Choose two available agents with chats.');
  }
  if (author.sessionId === reviewer.sessionId) throw new Error('Author and reviewer must be different agents.');
  const model = (card: AgentCard) => canonicalModelId(card.model?.trim().toLowerCase() ?? '');
  if (!model(author) || !model(reviewer) || model(author) === 'default' || model(reviewer) === 'default') {
    throw new Error('Both agents must report an explicit model.');
  }
  if (model(author) === model(reviewer)) throw new Error('Author and reviewer must use different models.');
  return { author, reviewer };
}

export function createAgentRoom(title: string, authorId: string, reviewerId: string, cards: readonly AgentCard[]): AgentRoom {
  if (!title.trim() || title.trim().length > 120) throw new Error('Use a room name between 1 and 120 characters.');
  roomMembers({ authorId, reviewerId }, cards);
  return { id: crypto.randomUUID(), title: title.trim(), authorId, reviewerId };
}

export const AGENT_ROOMS_KEY = 'ashlr.agentWorkspace.rooms.v1';
export const MAX_AGENT_ROOMS = 30;

/** Only membership is saved locally. Messages stay in the existing authenticated session store. */
export function readAgentRooms(): AgentRoom[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(AGENT_ROOMS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    return parsed.filter((value): value is AgentRoom => {
      if (!value || typeof value !== 'object') return false;
      const room = value as Record<string, unknown>;
      if (!['id', 'title', 'authorId', 'reviewerId'].every(key => typeof room[key] === 'string' && (room[key] as string).trim().length > 0 && (room[key] as string).length <= 200)) return false;
      if (ids.has(room.id as string)) return false;
      ids.add(room.id as string);
      return true;
    }).slice(0, MAX_AGENT_ROOMS).map(({ id, title, authorId, reviewerId }) => ({ id, title, authorId, reviewerId }));
  } catch { return []; }
}

export function saveAgentRooms(rooms: readonly AgentRoom[]): void {
  localStorage.setItem(AGENT_ROOMS_KEY, JSON.stringify(rooms.slice(0, MAX_AGENT_ROOMS)));
}
