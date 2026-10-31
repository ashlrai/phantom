import { useRef, useState, type FormEvent } from 'react';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { parseInboxAt } from '../fleet/interject-ack-model.js';
import { loadHistory, pushHistory } from '../fleet/interject-history.js';
import { getMobileFleetClient } from './fleet-client.js';
import { inboxTailQuery } from './inbox-tail-query.js';
import { mobileAckLine, mobileTime } from './interject-ack-model.js';
import { MicButton } from './MicButton.js';
import { canShowActions, useMobile } from './mobile-context.js';
import { showMobileToast } from './mobile-toast.js';
import { Button } from './ui.js';
import { Row, Section, ui } from './ui-parts.js';

const POSTED_AT_KEY = 'phantom.mobile.interject.postedAt';
function readHistory(): string[] {
  try { return loadHistory(window.localStorage); } catch { return []; }
}
function loadPostedAt(): number | null {
  try {
    const value = sessionStorage.getItem(POSTED_AT_KEY);
    return value !== null && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  } catch { return null; }
}
function savePostedAt(at: number | null): void {
  try {
    if (at === null) sessionStorage.removeItem(POSTED_AT_KEY);
    else sessionStorage.setItem(POSTED_AT_KEY, String(at));
  } catch { /* Storage may be unavailable. */ }
}

export function MobileInterject() {
  const { permissions, reachability } = useMobile();
  const query = useQuery(inboxTailQuery);
  const refetch = useRefetch(inboxTailQuery);
  const refresh = useRefresh(inboxTailQuery);
  const [text, setText] = useState('');
  const [history, setHistory] = useState(readHistory);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [missingWrite, setMissingWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [postedAt, setPostedAt] = useState<number | null>(loadPostedAt);
  const [, setClockTick] = useState(0);
  const missing = missingWrite || (query.error instanceof ApiError && query.error.status === 404);
  const reachable = reachability !== 'offline' && reachability !== 'unreachable';
  const displayedText = interim ? `${text}${text && !text.endsWith(' ') ? ' ' : ''}${interim}`.slice(0, 6000) : text;
  usePollWhileVisible(() => { setClockTick(tick => tick + 1); refetch(); }, 20_000, { enabled: !missing });
  const ack = mobileAckLine(postedAt, query.data?.snapshot, Date.now());

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !reachable || !text.trim()) return;
    setBusy(true);
    setError(null);
    setPostedAt(null);
    savePostedAt(null);
    try {
      const result = await getMobileFleetClient().interject(text.trim());
      try { pushHistory(window.localStorage, text.trim()); } catch { /* Storage may be unavailable. */ }
      setHistory(readHistory());
      const now = Date.now();
      const parsedAt = parseInboxAt(result.at, now) ?? Date.parse(result.at);
      const at = Number.isFinite(parsedAt) ? parsedAt : now;
      setPostedAt(at);
      savePostedAt(at);
      setText('');
      showMobileToast(`Landed ${mobileTime(new Date(at).toISOString())}`, 'success');
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissingWrite(true);
      else setError(err instanceof ApiError ? err.detail ?? err.message : err instanceof Error ? err.message : 'The message could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Tell the leaders">
      {missing ? <Row title="This build has no fleet inbox yet." /> : <>
        {canShowActions(permissions) ? (
          <form className={`${ui.stack} ${ui.row}`} onSubmit={(event) => void send(event)}>
            <label className="visually-hidden" htmlFor="mobile-interject">Message to the leaders</label>
            {!displayedText && history.length > 0 ? (
              <div className={ui.chips} role="group" aria-label="Recent messages" style={{ flexWrap: 'nowrap', overflowX: 'auto', minWidth: 0 }}>
                <span style={{ flex: 'none', alignSelf: 'center' }} aria-hidden="true">↑ Recent</span>
                {history.slice(-5).reverse().map((message, index) => (
                  <button key={index} type="button" className={ui.chip} style={{ flex: 'none', whiteSpace: 'nowrap' }} disabled={busy}
                    onClick={() => { setText(message); textareaRef.current?.focus(); }}>
                    ↑ {message.slice(0, 40)}
                  </button>
                ))}
              </div>
            ) : null}
            <div className={ui.composerRow}>
              <textarea ref={textareaRef} id="mobile-interject" className={ui.textarea} maxLength={6000} value={displayedText} disabled={busy}
                placeholder="A prompt, a thought, a correction. The next leader pass reads it."
                onChange={(event) => { setInterim(''); setText(event.target.value); }} />
              <MicButton size="inline" disabled={busy || !reachable} onInterim={setInterim}
                onFinal={(phrase) => {
                  setText((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${phrase}`.slice(0, 6000));
                  setInterim('');
                }} />
            </div>
            {!reachable ? <p className={ui.rowSub}>Can't reach your Mac — your note stays here until it reconnects</p> : null}
            {error ? <p className={ui.error} role="alert">{error}</p> : null}
            <Button type="submit" variant="primary" disabled={busy || !reachable || !text.trim()}>{busy ? 'Sending…' : 'Send'}</Button>
            {ack ? <p className={`${ui.rowSub} ${ui[`tone-${ack.tone === 'ok' ? 'success' : ack.tone}`]}`} role="status">{ack.text}</p> : null}
          </form>
        ) : null}
        {query.error ? <Row title="Couldn’t read the inbox" subtitle={readFailureReason(query.error)} /> : null}
        {query.data?.inbox.slice(0, 3).map((entry, index) => (
          <Row key={`${entry.at}-${index}`} title={entry.text.slice(0, 80)} subtitle={`${entry.source} · ${mobileTime(entry.at)}`} />
        ))}
        {query.status === 'success' && query.data?.inbox.length === 0 ? <Row title="No inbox entries yet" /> : null}
      </>}
    </Section>
  );
}
