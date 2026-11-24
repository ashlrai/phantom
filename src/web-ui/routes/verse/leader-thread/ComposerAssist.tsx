/**
 * Keyboard help for the Leader reply box. Typing `@` opens a list of the agent
 * sessions running right now (lane, when each last spoke, the last thing it
 * said); ↑/↓ move, Enter or Tab writes `@RQ-<job>` so the message is aimed at
 * that job, Esc closes. In an empty box ↑ brings back what Mason already said.
 * The list is read only while it is open, from the same sessions list the
 * Sessions pane shows; nothing is sent until the message is.
 *
 * After a command that takes an argument (`/release `, `/stop `, `/app `…)
 * the same place lists what the command accepts (CommandArgAssist.tsx).
 */
import { useId, useMemo, useState, type ChangeEvent, type Dispatch, type KeyboardEvent, type ReactNode, type RefObject, type SetStateAction, type SyntheticEvent } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { insertMention, mentionQuery } from '../fleet/interject-target-model.js';
import { liveSessionsQuery, SESSIONS_POLL_MS } from '../fleet-sessions/sessions-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useCommandArgs } from './CommandArgAssist.js';
import { mentionOptions, recallStep, stepOption } from './composer-assist-model.js';
import { parseComposerDraft } from './composer-commands.js';
import styles from './composer-assist.module.css';

type Box = HTMLTextAreaElement;

export interface ComposerAssist {
  /** Spread on the reply textarea; replaces its own onChange. */
  inputProps: {
    onChange: (event: ChangeEvent<Box>) => void;
    onSelect: (event: SyntheticEvent<Box>) => void;
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
    'aria-autocomplete': 'list';
  };
  /** Call first from the textarea's onKeyDown; true means the key was taken. */
  onKeyDown: (event: KeyboardEvent<Box>) => boolean;
  /** The open session list or the recall line; null when neither applies. */
  panel: ReactNode;
}

export function useComposerAssist({ draft, setDraft, inputRef, enabled, sent }: {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<Box | null>;
  /** False while the pane is hidden or read-only: no list, no read. */
  enabled: boolean;
  /** What Mason already said in this conversation, oldest first. */
  sent: readonly string[];
}): ComposerAssist {
  const id = useId();
  const [caret, setCaret] = useState(0);
  const [closed, setClosed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [recallAt, setRecallAt] = useState<number | null>(null);

  const query = closed || !enabled ? null : mentionQuery(draft, caret);
  const open = query !== null;
  const read = useQuery(liveSessionsQuery, { enabled: open, freshMs: SESSIONS_POLL_MS });
  const refetch = useRefetch(liveSessionsQuery);
  usePollWhileVisible(refetch, SESSIONS_POLL_MS, { enabled: open });
  const options = useMemo(() => (query !== null && read.data ? mentionOptions(read.data, query) : null), [query, read.data]);
  const shown = options?.shown ?? [];
  const active = shown.length === 0 ? -1 : Math.min(selected, shown.length - 1);
  const recalling = !open && recallAt !== null && sent[recallAt] === draft;

  function place(text: string, at: number) {
    setDraft(text);
    setCaret(at);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(at, at); });
  }
  function choose(job: string) {
    const next = insertMention(draft, caret, job);
    setClosed(true);
    place(next.text, next.caret);
  }
  // The `@` list wins when both apply (`/thread @`); Esc closes whichever is open.
  const args = useCommandArgs({ id, draft, caret, enabled: enabled && !closed && !open, selected, setSelected,
    // After /hold's lane the minutes list opens in the same place, from its first row.
    onChoose: (text, more) => { setClosed(!more); setSelected(0); place(text, text.length); } });

  function onKeyDown(event: KeyboardEvent<Box>): boolean {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    const take = () => { event.preventDefault(); event.stopPropagation(); return true; };
    if (open) {
      // Esc closes the list and nothing else: the pane and the dock stay as they are.
      if (event.key === 'Escape') { setClosed(true); return take(); }
      if (!plain || active < 0) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { setSelected(stepOption(shown.length, active, event.key === 'ArrowDown' ? 1 : -1)); return take(); }
      // A command whose session is already typed in full (`/thread @RQ-A`) runs on Enter, with or without the list read.
      const typedInFull = selected === 0 && caret === draft.length && shown.some(option => option.id === query) && parseComposerDraft(draft).kind === 'command';
      if (event.key === 'Enter' && typedInFull) return false;
      if (event.key === 'Enter' || event.key === 'Tab') { choose(shown[active]!.id); return take(); }
      return false;
    }
    if (args.open) {
      if (event.key === 'Escape') { setClosed(true); return take(); }
      return plain && args.onKey(event.key) ? take() : false;
    }
    if (!enabled || !plain) return false;
    if (event.key === 'Escape' && recalling) { setRecallAt(null); place('', 0); return take(); }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    // The arrows keep moving the caret inside a message; recall only takes them at its edges.
    const box = event.currentTarget, atEnd = box.selectionStart === draft.length && box.selectionEnd === draft.length;
    const onEdge = atEnd || (event.key === 'ArrowUp' ? !draft.slice(0, box.selectionStart).includes('\n') : !draft.slice(box.selectionEnd).includes('\n'));
    const step = onEdge ? recallStep(sent, draft, recallAt, event.key === 'ArrowUp' ? -1 : 1) : null;
    if (step === null) return false;
    setRecallAt(step.at);
    place(step.text, step.text.length);
    return take();
  }

  const listId = `${id}-sessions`;
  let panel: ReactNode = null;
  if (open) {
    const hint = read.data === undefined && !read.error ? <p role="status" aria-busy="true">Reading sessions…</p>
      : !options ? <p role="status" data-tone="unknown">Sessions unavailable. You can still type a job id after @.</p>
        : shown.length > 0 ? null
          : <p role="status">{options.running === 0 ? 'No agents are working right now.' : `No running session matches “@${query}”.`}</p>;
    panel = <div className={styles.assist} data-leader-mentions="">
      {hint}
      {shown.length > 0 && <div id={listId} className={styles.list} role="listbox" aria-label="Running sessions">
        {shown.map((option, index) => <div key={option.id} id={`${id}-session-${index}`} className={styles.option} role="option" aria-selected={index === active}
          data-state={option.state} onMouseDown={event => event.preventDefault()} onClick={() => choose(option.id)}>
          <span className={styles.name}>{option.lane !== 'unknown' && <ProviderBadge of={option.lane} iconOnly size={14} />}<strong>@{option.id}</strong></span>
          <span className={styles.facts}>{option.kind === 'subagent' ? 'helper · ' : ''}{option.lane === 'unknown' ? 'lane unknown' : option.lane} · {option.when}</span>
          <span className={styles.said} data-unknown={option.said === null || undefined}>{option.said ?? 'Last message unknown'}</span>
        </div>)}
      </div>}
      {options && <p className={styles.foot}>
        {shown.length > 0 && <span><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> aim · <kbd>esc</kbd> close</span>}
        {options.more > 0 && <span>{options.more} more; keep typing to narrow</span>}
        {options.unnamed > 0 && <span data-tone="unknown">{options.unnamed} running without an RQ id cannot be aimed at</span>}
        {read.error ? <span data-tone="unknown">Refresh failed; this list may be stale</span> : null}
      </p>}
    </div>;
  } else if (args.open) {
    panel = args.panel;
  } else if (recalling) {
    panel = <p className={styles.recall} role="status">Earlier message {recallAt + 1} of {sent.length} · <kbd>↑</kbd> older · <kbd>↓</kbd> newer · <kbd>esc</kbd> clears</p>;
  }

  return {
    inputProps: {
      onChange: event => { setDraft(event.target.value); setCaret(event.target.selectionStart); setClosed(false); setSelected(0); setRecallAt(null); },
      onSelect: event => setCaret(event.currentTarget.selectionStart),
      'aria-controls': shown.length > 0 ? listId : args.listId,
      'aria-activedescendant': active >= 0 ? `${id}-session-${active}` : args.activeId,
      'aria-autocomplete': 'list',
    },
    onKeyDown,
    panel,
  };
}
