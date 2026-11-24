import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../primitives/Button.js';
import { OWNER_SHARE_MAX_CHARS, prepareOwnerDraft } from './owner-interjection-draft.js';
import styles from './OwnerInterjectionDraft.module.css';

export interface OwnerInterjectionDraftProps { channel: string; thread: string }
/** Local preparation only. Parent supplies an explicitly selected scope, never inferred prose.
 * Mount separately after the agent-chat pane lands; no token, POST, history or persistence.
 */
export function OwnerInterjectionDraft(props: OwnerInterjectionDraftProps) {
  return <ScopedDraft key={JSON.stringify([props.channel, props.thread])} {...props} />;
}
function ScopedDraft({ channel, thread }: OwnerInterjectionDraftProps) {
  const id = useId(), epoch = useRef(0);
  const [text, setText] = useState('');
  const [copy, setCopy] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  useEffect(() => () => { epoch.current++; }, []);
  const draft = prepareOwnerDraft(channel, thread, text);
  const update = (value: string) => { epoch.current++; setText(value); setCopy('idle'); };
  const copyDraft = async () => {
    if (!draft.ok || copy === 'copying') return;
    const attempt = ++epoch.current;
    setCopy('copying');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(draft.json);
      if (epoch.current === attempt) setCopy('copied');
    } catch { if (epoch.current === attempt) setCopy('failed'); }
  };
  return <section className={styles.card} aria-labelledby={`${id}-heading`}>
    <div className={styles.heading}><h3 id={`${id}-heading`}>Prepare an owner note</h3><span className={styles.badge}>Draft only</span></div>
    <p className={styles.scope}>Channel <strong>{channel || 'Not selected'}</strong><span aria-hidden="true"> · </span>Thread <strong>{thread || 'Not selected'}</strong></p>
    <p id={`${id}-boundary`} className={styles.hint}>Not sent. Native owner-share availability is unverified. After the fleet confirms it is ready, send the JSON once through your verified iMessage account.</p>
    <label htmlFor={`${id}-text`} className={styles.label}>Your note</label>
    <textarea id={`${id}-text`} value={text} onChange={event => update(event.target.value)}
      maxLength={OWNER_SHARE_MAX_CHARS} rows={4} disabled={copy === 'copying'}
      aria-describedby={`${id}-boundary ${id}-status`} placeholder="What should this group know?" />
    {draft.ok && <details className={styles.preview}><summary>Review exact JSON</summary><pre>{draft.json}</pre></details>}
    <div className={styles.actions}>
      <Button type="button" variant="subtle" onClick={copyDraft} disabled={!draft.ok} busy={copy === 'copying'}>Copy draft JSON</Button>
      <Button type="button" onClick={() => update('')} disabled={!text || copy === 'copying'}>Clear draft</Button>
    </div>
    <p id={`${id}-status`} role="status" className={styles.hint}>
      {copy === 'copied' ? 'Copied, not sent. A native receipt is required to confirm sharing.' :
        copy === 'failed' ? 'Could not copy. Nothing was sent; review and copy the JSON manually.' :
          copy === 'copying' ? 'Copying locally…' : !draft.ok ? draft.reason : 'Only this selected text is included. No private history is attached.'}
    </p>
  </section>;
}
