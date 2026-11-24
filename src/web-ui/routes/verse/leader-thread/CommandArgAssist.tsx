/**
 * The list that fills in a typed command's argument in the Leader reply box:
 * the held lanes after `/release `, the lane and then the minutes after
 * `/hold `, the running jobs after `/stop `, the Mac
 * apps after `/app `, the panes after `/open ` (command-arg-model.ts has the
 * full set). ↑/↓ move, Tab writes the highlighted row, Esc closes. Enter
 * writes it too while nothing is typed yet or after the arrows moved, and
 * otherwise runs the command as typed, so a full argument is never replaced.
 *
 * Each list is read only while it is open, through the query the matching
 * pane uses (one cache entry each), and choosing a row only writes text:
 * nothing runs until the command is sent.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { readFailureReason } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import { macAppsQuery } from '../fleet-host/MacAppsCard.js';
import { liveSessionsQuery, SESSIONS_POLL_MS } from '../fleet-sessions/sessions-model.js';
import { laneTargetsQuery } from '../ops/lane-targets-queries.js';
import { usePanes } from '../panes/pane-registry.js';
import { appOptions, argListName, argQuery, enterFills, insertArg, laneOptions, minuteOptions, moreFollows, paneOptions, sessionOptions, type ArgOptions, type ArgSource } from './command-arg-model.js';
import { stepOption } from './composer-assist-model.js';
import styles from './composer-assist.module.css';

const LANES_FRESH_MS = 10_000, APPS_FRESH_MS = 30_000;

const WORDS: Readonly<Record<Exclude<ArgSource, 'panes' | 'minutes'>, { reading: string; gone: string; typed: string }>> = {
  lanes: { reading: 'Reading lanes…', gone: 'Lanes unavailable.', typed: 'a lane name' },
  sessions: { reading: 'Reading sessions…', gone: 'Sessions unavailable.', typed: 'an id' },
  apps: { reading: 'Reading apps…', gone: 'Apps unavailable.', typed: 'an app name' },
};

export interface CommandArgAssist {
  /** True while the draft is a command waiting for an argument this can list. */
  open: boolean;
  /** One plain key press from the reply box; true means it was taken. */
  onKey: (key: string) => boolean;
  /** Ids for the reply box's aria-controls and aria-activedescendant; undefined when there is no row. */
  listId: string | undefined;
  activeId: string | undefined;
  panel: ReactNode;
}

export function useCommandArgs({ id, draft, caret, enabled, selected, setSelected, onChoose }: {
  /** Prefix for the list's element ids. */
  id: string;
  draft: string;
  caret: number;
  /** False while the pane is hidden, the box is read-only, the list was closed, or another list is open. */
  enabled: boolean;
  /** The highlighted row; the reply box resets it on every edit. */
  selected: number;
  setSelected: (index: number) => void;
  /** Receives the draft with the argument filled in; `more` when the next argument has a list of its own. */
  onChoose: (text: string, more: boolean) => void;
}): CommandArgAssist {
  // The draft the arrows last moved in: an edit makes it stale, so Enter runs the command again.
  const [movedIn, setMovedIn] = useState<string | null>(null);
  const at = enabled ? argQuery(draft, caret) : null;
  const source = at?.source ?? null;
  const lanes = useQuery(laneTargetsQuery, { enabled: source === 'lanes', freshMs: LANES_FRESH_MS });
  const sessions = useQuery(liveSessionsQuery, { enabled: source === 'sessions', freshMs: SESSIONS_POLL_MS });
  const apps = useQuery(macAppsQuery, { enabled: source === 'apps', freshMs: APPS_FRESH_MS });
  const panes = usePanes();
  const read = source === 'lanes' ? lanes : source === 'sessions' ? sessions : source === 'apps' ? apps : null;

  const name = at?.name ?? null, query = at?.query ?? '';
  const options = useMemo((): ArgOptions | null => {
    // The end times are as of the last key press, which is when the row is read.
    if (source === 'minutes') return minuteOptions(query, Date.now());
    if (name === 'release' || name === 'hold' || name === 'lane') return lanes.data ? laneOptions(lanes.data, name, query) : null;
    if (name === 'app') return apps.data ? appOptions(apps.data, query) : null;
    if (name === 'open') return paneOptions(panes, query);
    return name !== null && sessions.data ? sessionOptions(sessions.data, name, query) : null;
  }, [name, source, query, lanes.data, sessions.data, apps.data, panes]);

  const shown = options?.shown ?? [];
  const active = shown.length === 0 ? -1 : Math.min(selected, shown.length - 1);
  const choose = (value: string) => { if (at) onChoose(insertArg(draft, at, value), moreFollows(at)); };

  function onKey(key: string): boolean {
    if (!at || active < 0) return false;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      setSelected(stepOption(shown.length, active, key === 'ArrowDown' ? 1 : -1));
      setMovedIn(draft);
      return true;
    }
    if (key === 'Tab' || (key === 'Enter' && enterFills(at, movedIn === draft))) { choose(shown[active]!.value); return true; }
    return false;
  }

  const listId = `${id}-args`;
  let panel: ReactNode = null;
  if (at) {
    const words = source === null || source === 'panes' || source === 'minutes' ? null : WORDS[source];
    const hint = options ? (options.empty === null ? null : <p role="status">{options.empty}</p>)
      : !words ? null
        : read?.data === undefined && !read?.error ? <p role="status" aria-busy="true">{words.reading}</p>
          : <p role="status" data-tone="unknown">{words.gone} {read?.error ? readFailureReason(read.error) : 'This server does not list them.'} You can still type {words.typed}.</p>;
    panel = <div className={styles.assist} data-leader-command-args={at.name}>
      {hint}
      {shown.length > 0 && <div id={listId} className={styles.list} role="listbox" aria-label={argListName(at)}>
        {shown.map((option, index) => <div key={option.value} id={`${id}-arg-${index}`} className={styles.option} role="option" aria-selected={index === active}
          data-tone={option.tone} onMouseDown={event => event.preventDefault()} onClick={() => choose(option.value)}>
          <span className={styles.name}>{option.lane !== null && <ProviderBadge of={option.lane} iconOnly size={14} />}<strong>{option.label}</strong></span>
          <span className={styles.facts}>{option.facts}</span>
          <span className={styles.said}>{option.note}</span>
        </div>)}
      </div>}
      {options && (shown.length > 0 || options.caveat !== null) && <p className={styles.foot}>
        {shown.length > 0 && <span><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>tab</kbd> fill in · <kbd>esc</kbd> close</span>}
        {options.more > 0 && <span>{options.more} more; keep typing to narrow</span>}
        {options.caveat !== null && <span data-tone="unknown">{options.caveat}</span>}
        {read?.error ? <span data-tone="unknown">Refresh failed; this list may be stale</span> : null}
      </p>}
    </div>;
  }

  return {
    open: at !== null,
    onKey,
    listId: shown.length > 0 ? listId : undefined,
    activeId: active >= 0 ? `${id}-arg-${active}` : undefined,
    panel,
  };
}
