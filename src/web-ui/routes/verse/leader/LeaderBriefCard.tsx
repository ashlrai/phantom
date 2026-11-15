/**
 * routes/verse/leader/LeaderBriefCard.tsx — the "Phantom status" brief at the
 * top of the Leader conversation: where things stand without asking. Read
 * only. The text comes from the Leader's own daily brief and is UNTRUSTED:
 * it is drawn as plain text lines, never as markdown or HTML.
 */
import { useId, useState } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { useNow } from '../autonomy/use-ticker.js';
import { CopyPill } from '../apps/CopyPill.js';
import { triageAge } from '../fleet-inbox/gmail-triage-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './leader.module.css';

export const LEADER_BRIEF_PATH = '/api/verse/comms/owner-thread/status';
export const LEADER_BRIEF_COLLAPSED_KEY = 'verse.leaderBrief.collapsed';
export const LEADER_BRIEF_POLL_MS = 5 * 60_000;
const SCHEMA = 'comms.owner-status.v1';
const COMMAND = 'ashlr fleet brief-send';

const leaderBriefQuery: QueryDef<unknown> = { key: 'verse-leader-brief', fetch: s => apiGet(LEADER_BRIEF_PATH, s) };

interface Brief { at: string; text: string | null }

/** The brief from the payload; null when the payload is not ours. Defensive, never repairing. */
function readBrief(data: unknown): Brief | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.schema !== SCHEMA || typeof d.at !== 'string' || typeof d.text !== 'string' || d.unavailable === true) return null;
  return { at: d.at, text: d.text };
}

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(LEADER_BRIEF_COLLAPSED_KEY) === '1'; } catch { return false; }
}

export function LeaderBriefCard() {
  const bodyId = useId();
  const query = useQuery(leaderBriefQuery, { freshMs: 60_000 });
  const refetch = useRefetch(leaderBriefQuery);
  const refresh = useRefresh(leaderBriefQuery);
  usePollWhileVisible(refetch, LEADER_BRIEF_POLL_MS);
  const now = useNow(30_000);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  // Nothing to say before the first read lands.
  if (!query || (query.status !== 'error' && query.data === undefined)) return null;
  const brief = readBrief(query.data);
  const text = brief?.text ?? null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { window.localStorage.setItem(LEADER_BRIEF_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* the choice just does not persist */ }
  };

  return (
    <section className={styles.brief} aria-label="Phantom status">
      <div className={styles.briefHead}>
        <button type="button" className={styles.briefToggle} aria-expanded={!collapsed} aria-controls={bodyId} onClick={toggle}>
          <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span> Phantom status{brief ? ` · ${triageAge(brief.at, now)}` : ''}
        </button>
        <button type="button" className={styles.briefRefresh} onClick={refresh} disabled={query.status === 'refreshing'}>Refresh</button>
      </div>
      {collapsed ? null : (
        <div id={bodyId} className={styles.briefBody}>
          {text === null
            ? <p className={styles.briefLine}>Status read unavailable. Run <CopyPill text={COMMAND} what="the brief command" />.</p>
            : text.split('\n').map((line, i) => <p key={i} className={styles.briefLine}>{line}</p>)}
        </div>
      )}
    </section>
  );
}
