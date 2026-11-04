/**
 * routes/verse/fleet/SessionGuidanceBox.tsx — the per-session guidance
 * composer. One row of the Working card expands into this: a strategy line
 * naming HOW the message reaches the running agent (stream inject, resume,
 * or requeue with guidance), the text box itself, and the ack state of the
 * last message (queued, delivered at turn N, or requeued).
 */
import { useId, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { ApiError } from '../../../data/client.js';
import { getMutationToken } from '../../../data/auth-store.js';
import { strategyForLane, GUIDANCE_TEXT_MAX_BYTES } from '../../../../core/fleet/session-guidance.js';
import { ackLabel, type GuidanceSessionSummary } from './session-guidance-model.js';
import { postSessionGuidance } from './session-guidance-queries.js';
import styles from './session-guidance.module.css';

export function SessionGuidanceBox({ job, lane, summary }: { job: string; lane: string; summary: GuidanceSessionSummary | null }) {
  const id = useId();
  const strategy = strategyForLane(lane);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');
  const token = getMutationToken();
  const canSend = !sending && token !== null && draft.trim().length > 0;

  async function send() {
    const text = draft.trim();
    if (!canSend || !text) return;
    setSending(true);
    setNote('');
    try {
      const result = await postSessionGuidance(job, text);
      setDraft('');
      setNote(result.truncated ? 'Queued (trimmed to 4 KB)' : 'Queued');
    } catch (error) {
      setNote(error instanceof ApiError ? error.detail ?? error.message
        : error instanceof Error ? error.message : 'The message could not be sent.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.box}>
      <p className={styles.strategy}>
        Delivers by <strong>{strategy.label}</strong>: {strategy.mechanism}
      </p>
      <label className={styles.label} htmlFor={id}>
        Guidance for {job}
      </label>
      <textarea
        id={id}
        className={styles.textarea}
        rows={2}
        value={draft}
        maxLength={GUIDANCE_TEXT_MAX_BYTES}
        disabled={sending}
        placeholder="e.g. Prefer the existing helper; do not touch the CLI flags."
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className={styles.row}>
        <span className={styles.meta}>
          {token === null ? 'Unlock controls to send guidance.' : '⌘↵ or Ctrl↵ sends · 4 KB per message'}
        </span>
        {summary?.latest ? (
          <span className={styles.ack} data-state={summary.latest.state}>
            {ackLabel(summary.latest)}
          </span>
        ) : null}
        {note ? <span className={styles.note} role="status">{note}</span> : null}
        <Button type="button" size="sm" variant="primary" disabled={!canSend} busy={sending} onClick={() => void send()}>
          {sending ? 'Sending…' : 'Send guidance'}
        </Button>
      </div>
    </div>
  );
}
