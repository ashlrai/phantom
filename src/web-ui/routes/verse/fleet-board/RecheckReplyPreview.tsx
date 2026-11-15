/**
 * routes/verse/fleet-board/RecheckReplyPreview.tsx — read-only preview of the
 * exact thread reply the server's formatter produces for the current verdict.
 * Plain text in a <pre>; Copy writes to the clipboard and sends nothing.
 */
import { useState } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { Button } from '../../../components/primitives/Button.js';
import { deriveReplyPreview, recheckReplyQuery } from './recheck-reply-model.js';
import styles from './fleet-board.module.css';

export function RecheckReplyPreview({ visible = true }: { visible?: boolean }) {
  const q = useQuery(recheckReplyQuery, { enabled: visible, freshMs: 0 });
  const [copied, setCopied] = useState('');
  const preview = deriveReplyPreview(q.status === 'error' && q.data === undefined ? 'error' : q.data);

  async function copy() {
    if (preview.state !== 'ready') return;
    try {
      await navigator.clipboard.writeText(preview.text);
      setCopied('Copied');
    } catch { setCopied('Copy failed'); }
  }

  return (
    <details>
      <summary>Thread reply</summary>
      <pre className={styles.replyText}>{preview.text}</pre>
      <Button size="sm" disabled={preview.state !== 'ready'} onClick={() => { void copy(); }}>Copy</Button>
      <p className={styles.replyCopied} aria-live="polite">{copied}</p>
    </details>
  );
}
