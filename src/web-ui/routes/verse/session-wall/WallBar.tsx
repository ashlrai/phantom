/**
 * The bar above the Conversations wall: a find box and three ways to narrow.
 *
 * Find looks through the sessions already on screen (id, lane, model, repo,
 * summary, newest messages) and asks the server nothing. Lane, repo and
 * "Running only" are sent to the read itself
 * (GET /api/verse/fleet/control/session-threads?lane=&repo=&live=1), because
 * the read returns at most 40 sessions: narrowing there is how a session past
 * that limit gets onto the screen. The line under the controls says what the
 * screen holds: how many sessions match, what the server narrowed to, and how
 * many it left out.
 *
 * "/" puts the cursor here (SessionWall.tsx). In the box, Down or Enter moves
 * to the first card, Esc clears the words, and Esc on an empty box goes back
 * to the cards.
 */
import type { KeyboardEvent } from 'react';
import { Input } from '../../../components/primitives/Input.js';
import { Select } from '../../../components/primitives/Select.js';
import { findEntries, isScoped, NO_SCOPE, sameScope, scopeWords, type SessionWallRead, type WallScope } from './session-wall-model.js';
import styles from './session-wall.module.css';

export interface WallBarProps {
  find: string;
  onFind: (find: string) => void;
  scope: WallScope;
  onScope: (scope: WallScope) => void;
  /** Lanes and repos seen in the reads so far. */
  lanes: readonly string[];
  repos: readonly string[];
  /** The read on screen; null while there is none for this scope. */
  read: SessionWallRead | null;
  /** Hand the keyboard to the cards. */
  onLeave: () => void;
}

export interface BarNote { text: string; tone: 'plain' | 'warn' }

/** What the line under the controls says; null when there is nothing to add to the headline. */
export function barNote(read: SessionWallRead | null, scope: WallScope, find: string): BarNote | null {
  if (!read) return null;
  const parts: string[] = [];
  const on = read.entries.length;
  if (find.trim() !== '' && on > 0) parts.push(`${findEntries(read.entries, find).length} of ${on} on screen match`);
  // A read that names another scope than the one asked for is every session, or someone else's narrowing: say so rather than label it wrongly.
  if (isScoped(scope) && read.scope !== null && !sameScope(read.scope, scope)) {
    return { text: [...parts, `The server did not narrow to ${scopeWords(scope)}; this is ${isScoped(read.scope) ? scopeWords(read.scope) : 'every session'}`].join(' · '), tone: 'warn' };
  }
  if (isScoped(scope)) parts.push(`Showing ${scopeWords(scope)}${read.scope === null ? ', as asked; the read did not confirm it' : ''}`);
  const unshown = read.total === null ? 0 : read.total - on;
  if (unshown > 0) parts.push(isScoped(scope) ? `${unshown} more not on screen` : `${unshown} more not on screen: narrow by lane, repo or running to reach them`);
  return parts.length > 0 ? { text: parts.join(' · '), tone: 'plain' } : null;
}

export function WallBar({ find, onFind, scope, onScope, lanes, repos, read, onLeave }: WallBarProps) {
  const note = barNote(read, scope, find);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); onLeave(); return; }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // Esc here belongs to the box, not to whatever closes on Esc around the pane.
    event.stopPropagation();
    if (find !== '') onFind('');
    else onLeave();
  };
  return <div className={styles.bar} role="search" aria-label="Find and narrow conversations">
    <Input type="search" size="sm" className={styles.find} aria-label="Find in the conversations on screen" placeholder="Find: id, lane, repo, words   /"
      value={find} onChange={event => onFind(event.target.value)} onKeyDown={onKeyDown} autoComplete="off" spellCheck={false} />
    <Select size="sm" className={styles.pick} aria-label="Lane" value={scope.lane ?? ''} onChange={event => onScope({ ...scope, lane: event.target.value || null })}>
      <option value="">Any lane</option>
      {lanes.map(lane => <option key={lane} value={lane}>{lane}</option>)}
    </Select>
    <Select size="sm" className={styles.pick} aria-label="Repo" value={scope.repo ?? ''} onChange={event => onScope({ ...scope, repo: event.target.value || null })}>
      <option value="">Any repo</option>
      {repos.map(repo => <option key={repo} value={repo}>{repo}</option>)}
    </Select>
    <button type="button" className={styles.filter} aria-pressed={scope.live} onClick={() => onScope({ ...scope, live: !scope.live })}>Running only</button>
    {isScoped(scope) && <button type="button" className={styles.link} onClick={() => onScope(NO_SCOPE)}>Every session</button>}
    {note && <p className={styles.barNote} role="status" data-tone={note.tone}>{note.text}</p>}
  </div>;
}
