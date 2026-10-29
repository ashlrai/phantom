import { useState } from 'react';
import type { AgentCard } from '../../../../core/verse/agents/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Input } from '../../../components/primitives/Input.js';
import { Select } from '../../../components/primitives/Select.js';
import { createAgentRoom, MAX_AGENT_ROOMS, readAgentRooms, roomMembers, saveAgentRooms, type AgentRoom } from '../../../data/agent-rooms.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { agentsBoardQuery, AGENTS_POLL_MS } from '../agents/agents-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { Transcript } from '../Transcript.js';
import { useVerseSession } from '../useVerseSession.js';
import { useVerseTranscript } from '../useVerseTranscript.js';
import { openVerseSession } from '../verse-ui-store.js';
import styles from './AgentRooms.module.css';

function MemberTranscript({ card, role }: { card: AgentCard; role: string }) {
  const [retry, setRetry] = useState(0);
  const view = useVerseSession(card.sessionId, retry);
  const transcript = useVerseTranscript(card.sessionId);
  return <section className={styles.member} aria-label={`${role} messages`}>
    <h3>{role}: {card.title}</h3>
    <p>{card.model} · {card.status}</p>
    <Button size="sm" onClick={() => { if (card.sessionId) openVerseSession(card.sessionId); }}>Open {role.toLowerCase()} chat</Button>
    <Transcript transcript={transcript} loaded={view.loaded} loadError={view.loadError} onRetry={() => setRetry(value => value + 1)} sessionId={card.sessionId} engine={card.engine ?? undefined} emptyHint="No messages yet. Open this agent’s chat to send a task." />
  </section>;
}

export function RoomConversation({ room, cards }: { room: AgentRoom; cards: readonly AgentCard[] }) {
  let members;
  try { members = roomMembers(room, cards); }
  catch (error) { return <p role="alert">Room unavailable: {(error as Error).message}</p>; }
  return <div className={styles.conversation}>
    <MemberTranscript key={`author:${members.author.sessionId}`} card={members.author} role="Author" />
    <MemberTranscript key={`reviewer:${members.reviewer.sessionId}`} card={members.reviewer} role="Reviewer" />
  </div>;
}

export function AgentRooms() {
  const board = useQuery(agentsBoardQuery);
  const refetch = useRefetch(agentsBoardQuery);
  usePollWhileVisible(refetch, AGENTS_POLL_MS);
  const [rooms, setRooms] = useState(readAgentRooms);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [authorId, setAuthorId] = useState('');
  const [reviewerId, setReviewerId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cards = board.data?.cards ?? [];
  const room = rooms.find(value => value.id === selected);
  const choices = cards.filter(card => card.sessionId && card.status !== 'archived');
  function update(next: AgentRoom[]) {
    try { saveAgentRooms(next); setRooms(next); setError(null); return true; }
    catch { setError('Could not save rooms in this browser. Check local storage access and try again.'); return false; }
  }
  return <div className={styles.surface}>
    <h1>Agent rooms</h1>
    <p>Pair an author with a reviewer on a different model. Follow their live chats together. Room membership is saved in this browser.</p>
    {board.error ? <div role="alert">Could not load agents. <Button onClick={() => void refetch()}>Retry</Button></div> : null}
    {!board.data && !board.error ? <p role="status">Loading agents…</p> : null}
    <form className={styles.form} onSubmit={event => {
      event.preventDefault();
      try {
        if (rooms.length >= MAX_AGENT_ROOMS) throw new Error('Room limit reached. Remove a room to create another.');
        if (!board.data || board.error) throw new Error('Wait for agents to load before creating a room.');
        const made = createAgentRoom(title, authorId, reviewerId, cards);
        if (update([...rooms, made])) { setSelected(made.id); setTitle(''); }
      } catch (reason) { setError((reason as Error).message); }
    }}>
      <Input label="Room name" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} />
      {(['Author', 'Reviewer'] as const).map(role => <Select key={role} label={role} value={role === 'Author' ? authorId : reviewerId} onChange={event => (role === 'Author' ? setAuthorId : setReviewerId)(event.target.value)}>
        <option value="">Choose an agent</option>
        {choices.map(card => <option key={card.id} value={card.id}>{card.title} · {card.model ?? 'Unknown model'}</option>)}
      </Select>)}
      <Button type="submit" disabled={!board.data || Boolean(board.error) || rooms.length >= MAX_AGENT_ROOMS}>Create room</Button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {rooms.length >= MAX_AGENT_ROOMS ? <p>Room limit reached. Remove a room to create another.</p> : null}
    <nav className={styles.list} aria-label="Rooms">{rooms.map(value => <Button key={value.id} aria-pressed={selected === value.id} onClick={() => setSelected(value.id)}>{value.title}</Button>)}</nav>
    {!rooms.length ? <p>No rooms yet. Choose two existing agents to bring their work together.</p> : null}
    {room ? <section aria-label={room.title}>
      <h2>{room.title}</h2>
      <Button size="sm" onClick={() => { if (update(rooms.filter(value => value.id !== room.id))) setSelected(null); }}>Remove room</Button>
      {board.data && !board.error ? <RoomConversation room={room} cards={cards} /> : null}
    </section> : null}
  </div>;
}
