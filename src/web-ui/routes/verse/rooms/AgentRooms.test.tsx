import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { readAgentRooms, saveAgentRooms } from '../../../data/agent-rooms.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { ev, session } from '../fixtures.test-support.js';
import { applyVerseEvent, resetVerseStore, seedVerseSession } from '../verse-store.js';
import { AgentRooms, RoomConversation } from './AgentRooms.js';
import { card } from './rooms.test-support.js';
vi.mock('../session-stream.js', () => ({ openVerseSession: () => () => {} }));
const author = card({ id: 'author', sessionId: 'a', title: 'Implement feature', model: 'gpt-5.5' });
const reviewer = card({ id: 'reviewer', sessionId: 'r', title: 'Review feature', model: 'claude-sonnet-5' });
const room = { id: 'room', title: 'Feature', authorId: author.id, reviewerId: reviewer.id };
beforeEach(() => { localStorage.clear(); evictAll(); resetVerseStore(); });
afterEach(() => { evictAll(); resetVerseStore(); vi.unstubAllGlobals(); });

describe('Agent rooms', () => {
  it('creates and persists a room through the form', async () => {
    installFetch(call => {
      if (call.path === '/api/verse/agents') return json({ cards: [author, reviewer] });
      throw new Error(`Unexpected request ${call.path}`);
    });
    render(<AgentRooms />);
    await within(screen.getByLabelText('Reviewer')).findByRole('option', { name: 'Review feature · claude-sonnet-5' });
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Feature' } });
    fireEvent.change(screen.getByLabelText('Author'), { target: { value: author.id } });
    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: reviewer.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(screen.getByRole('heading', { name: 'Feature' })).toBeInTheDocument();
    expect(readAgentRooms()).toHaveLength(1);
  });
  it('restores saved rooms and removes membership without deleting agents', async () => {
    saveAgentRooms([room]);
    installFetch(() => json({ cards: [author, reviewer] }));
    render(<AgentRooms />);
    await within(screen.getByLabelText('Reviewer')).findByRole('option', { name: 'Review feature · claude-sonnet-5' });
    fireEvent.click(screen.getByRole('button', { name: 'Feature' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove room' }));
    expect(readAgentRooms()).toEqual([]);
    expect(screen.getByText(/No rooms yet/)).toBeInTheDocument();
  });
  it('refuses same-model membership in the UI without saving a room', async () => {
    installFetch(() => json({ cards: [author, { ...reviewer, model: author.model }] }));
    render(<AgentRooms />);
    await within(screen.getByLabelText('Reviewer')).findByRole('option', { name: 'Review feature · gpt-5.5' });
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Feature' } });
    fireEvent.change(screen.getByLabelText('Author'), { target: { value: author.id } });
    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: reviewer.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(screen.getByRole('alert')).toHaveTextContent('different models');
    expect(readAgentRooms()).toEqual([]);
  });
  it('reports storage failure without showing an unsaved room', async () => {
    installFetch(() => json({ cards: [author, reviewer] }));
    render(<AgentRooms />);
    await within(screen.getByLabelText('Reviewer')).findByRole('option', { name: 'Review feature · claude-sonnet-5' });
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Feature' } });
    fireEvent.change(screen.getByLabelText('Author'), { target: { value: author.id } });
    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: reviewer.id } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save rooms');
    expect(screen.queryByRole('heading', { name: 'Feature' })).not.toBeInTheDocument();
    expect(readAgentRooms()).toEqual([]);
  });
  it('renders both real transcripts and streams updates with role attribution', () => {
    seedVerseSession('a', session({ id: 'a' }), [ev(1, 'user-message', { turnId: 't', text: 'Build the feature' }), ev(2, 'assistant-message', { turnId: 't', text: 'Implementation ready' })]);
    seedVerseSession('r', session({ id: 'r' }), [ev(1, 'assistant-message', { turnId: 't', text: 'Review complete' })]);
    const view = render(<RoomConversation room={room} cards={[author, reviewer]} />);
    const authorMessages = within(screen.getByRole('region', { name: 'Author messages' }));
    expect(authorMessages.getByText('Build the feature')).toBeInTheDocument();
    expect(authorMessages.getByText('Implementation ready')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Reviewer messages' })).getByText('Review complete')).toBeInTheDocument();
    act(() => applyVerseEvent('a', ev(3, 'assistant-message', { turnId: 'next', text: 'Follow-up ready' })));
    expect(authorMessages.getByText('Follow-up ready')).toBeInTheDocument();
    view.rerender(<RoomConversation room={room} cards={[author, { ...reviewer, model: author.model }]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('different models');
    expect(screen.queryByText('Implementation ready')).not.toBeInTheDocument();
  });
});
