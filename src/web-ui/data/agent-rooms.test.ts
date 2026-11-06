import { beforeEach, describe, expect, it } from 'vitest';
import { card } from '../routes/verse/rooms/rooms.test-support.js';
import { AGENT_ROOMS_KEY, createAgentRoom, readAgentRooms, roomMembers, saveAgentRooms } from './agent-rooms.js';

const author = card({ id: 'author', sessionId: 'a', model: 'gpt-5.5' });
const reviewer = card({ id: 'reviewer', sessionId: 'r', model: 'claude-sonnet-5' });
beforeEach(() => localStorage.clear());
describe('agent room membership', () => {
  it('refuses the same model even through a different engine or seat', () => {
    expect(() => createAgentRoom('Review', author.id, reviewer.id, [author, { ...reviewer, engine: 'local', model: ' GPT-5.5 ' }])).toThrow('different models');
  });
  it('refuses known aliases of the same model', () => {
    expect(() => createAgentRoom('Review', author.id, reviewer.id, [{ ...author, model: 'claude-opus-5.5' }, { ...reviewer, model: 'claude-opus-5-5' }])).toThrow('different models');
  });
  it.each([null, '', ' ', 'default'])('refuses unknown model %s', model => {
    expect(() => createAgentRoom('Review', author.id, reviewer.id, [author, { ...reviewer, model }])).toThrow('explicit model');
  });
  it('refuses missing, archived and duplicate sessions', () => {
    for (const cards of [[author], [author, { ...reviewer, status: 'archived' as const }], [author, { ...reviewer, sessionId: author.sessionId }]]) {
      expect(() => createAgentRoom('Review', author.id, reviewer.id, cards)).toThrow();
    }
  });
  it.each(['', '   ', 'x'.repeat(121)])('refuses invalid room title %#', title => {
    expect(() => createAgentRoom(title, author.id, reviewer.id, [author, reviewer])).toThrow('room name');
  });
  it('revalidates saved membership against current models', () => {
    const room = createAgentRoom(' Review ', author.id, reviewer.id, [author, reviewer]);
    saveAgentRooms([room]);
    expect(readAgentRooms()).toEqual([{ ...room, title: 'Review' }]);
    expect(() => roomMembers(room, [author, { ...reviewer, model: author.model }])).toThrow('different models');
  });
  it('handles malformed storage and drops invalid entries and extra fields', () => {
    localStorage.setItem(AGENT_ROOMS_KEY, '{');
    expect(readAgentRooms()).toEqual([]);
    const room = createAgentRoom('Review', author.id, reviewer.id, [author, reviewer]);
    localStorage.setItem(AGENT_ROOMS_KEY, JSON.stringify([null, {}, { ...room, messages: ['private'] }, room]));
    expect(readAgentRooms()).toEqual([room]);
  });
});
