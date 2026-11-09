/**
 * routes/verse/library/LibraryPane.tsx: one read-only place to see what
 * Phantom remembers: per-project shared memory, past chats and the way in to
 * the agent conversation. It reuses the context queries and adds no route;
 * nothing here writes. Every string from the server renders as plain text.
 */
import { useEffect, useMemo, useState } from 'react';
import type { VerseSearchResponse } from '../../../../core/verse/types.js';
import { ApiError } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import { Card, CardNote } from '../command/Surface.js';
import { openChat } from '../command/nav.js';
import { verseProjectMemoryQuery, searchSessions } from '../context/context-queries.js';
import { openDockPane } from '../dock/dock-store.js';
import { verseSessionsQuery } from '../verse-queries.js';
import { memorySummary, recentProjects, searchQueryValid, type RecentProject } from './library-model.js';
import styles from './library.module.css';

export const LIBRARY_SEARCH_DEBOUNCE_MS = 300;
export const LIBRARY_SEARCH_LIMIT = 20;

function errorSentence(err: unknown): string {
  if (err instanceof ApiError) return err.detail || err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function MemoryCard({ project, visible }: { project: RecentProject; visible: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const def = useMemo(() => verseProjectMemoryQuery(project.path), [project.path]);
  const memory = useQuery(def, { enabled: visible });
  const summary = memory.data ? memorySummary(memory.data) : null;
  const chats = `${project.chats} ${project.chats === 1 ? 'chat' : 'chats'}`;
  return (
    <Card title={project.name} caption={`${project.path} · ${chats}`}>
      {memory.error && !summary ? (
        <CardNote tone="danger">Could not read this project's memory: {errorSentence(memory.error)}</CardNote>
      ) : !summary ? (
        <CardNote>Loading…</CardNote>
      ) : summary.empty ? (
        <CardNote>Empty. Nothing has been remembered for this project yet.</CardNote>
      ) : (
        <>
          <ul className={styles.preview}>
            {summary.preview.map((line, index) => <li key={index}>{line}</li>)}
          </ul>
          <span className={styles.meta}>{summary.lines} {summary.lines === 1 ? 'line' : 'lines'}</span>
          {summary.sanitized ? <CardNote>Some text was redacted.</CardNote> : null}
          <div><button type="button" className={styles.button} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Close memory preview' : 'Open memory preview'}
          </button></div>
          {expanded && memory.data ? <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} aria-label={`${project.name} memory preview`}>
            {memory.data.content.split(/\r?\n/).slice(0, 200).join('\n')}
          </pre> : null}
        </>
      )}
    </Card>
  );
}

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; response: VerseSearchResponse }
  | { status: 'error'; message: string };

function PastChats() {
  const [q, setQ] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });

  useEffect(() => {
    if (!searchQueryValid(q)) {
      setState({ status: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    const timer = setTimeout(() => {
      searchSessions(q.trim(), LIBRARY_SEARCH_LIMIT, controller.signal)
        .then((response) => { if (!controller.signal.aborted) setState({ status: 'ready', response }); })
        .catch((err: unknown) => { if (!controller.signal.aborted) setState({ status: 'error', message: errorSentence(err) }); });
    }, LIBRARY_SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q]);

  return (
    <section className={styles.section} aria-label="Past chats">
      <h2>Past chats</h2>
      <input type="search" className={styles.input} value={q} placeholder="Search what was said in past chats"
        aria-label="Search past chats" autoComplete="off" spellCheck={false} onChange={(event) => setQ(event.target.value)} />
      {state.status === 'idle' ? (
        <p className={styles.meta}>Type at least 2 characters. Nothing is sent to a model.</p>
      ) : state.status === 'loading' ? (
        <p className={styles.meta}>Searching…</p>
      ) : state.status === 'error' ? (
        <CardNote tone="danger">{state.message}</CardNote>
      ) : state.response.hits.length === 0 ? (
        <p className={styles.meta}>No past chats match.</p>
      ) : (
        <ul className={styles.hits}>
          {state.response.hits.map((hit) => (
            <li key={`${hit.sessionId}:${hit.seq}`}>
              <button type="button" className={styles.hit} onClick={() => openChat(hit.sessionId)}>
                <strong>{hit.title || 'Untitled chat'}</strong>
                <span className={styles.meta}>{hit.projectPath}</span>
                <span className={styles.snippet}>{hit.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function LibraryPane({ visible = true }: { visible?: boolean }) {
  const sessions = useQuery(verseSessionsQuery, { enabled: visible });
  const projects = useMemo(() => recentProjects(sessions.data ?? []), [sessions.data]);
  return (
    <div className={styles.root}>
      <section className={styles.section} aria-label="Memory">
        <h2>Memory</h2>
        {sessions.error && !sessions.data ? (
          <CardNote tone="danger">Could not list projects: {errorSentence(sessions.error)}</CardNote>
        ) : projects.length === 0 ? (
          <CardNote>{sessions.data ? 'No projects yet. Start a chat to give Phantom something to remember.' : 'Loading…'}</CardNote>
        ) : (
          <div className={styles.cards}>
            {projects.map((project) => <MemoryCard key={project.path} project={project} visible={visible} />)}
          </div>
        )}
      </section>
      <PastChats />
      <section className={styles.section} aria-label="Agent conversation">
        <h2>Agent conversation</h2>
        <p className={styles.meta}>Agents talk to each other and to the Leader on the bus.</p>
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => openDockPane('fleet-bus')}>Open the bus</button>
          <button type="button" className={styles.button} onClick={() => openDockPane('leader-thread')}>Open the Leader thread</button>
        </div>
      </section>
    </div>
  );
}
