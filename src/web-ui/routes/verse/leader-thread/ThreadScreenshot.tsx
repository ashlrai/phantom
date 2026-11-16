/**
 * routes/verse/leader-thread/ThreadScreenshot.tsx — one `[screenshot:
 * …/inbox-attachments/<name>]` marker as a bounded thumbnail. The bytes come
 * back through an authenticated fetch carrying the same x-ashlr-token the
 * upload POST needed (core/verse/leader-attachment-read-api.ts), then show
 * from a blob URL — the same shape as the Browser pane's screenshot answers —
 * so no credential is ever put in an <img> URL. Click opens the full image in
 * a dialog. A marker that cannot load — no token held, a read-only server,
 * the file gone — falls back to its raw text plus "(image unavailable)".
 */
import { useEffect, useId, useState } from 'react';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { getMutationToken } from '../../../data/auth-store.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';
import leaderStyles from '../leader/leader.module.css';
import styles from './ThreadScreenshot.module.css';

export function ThreadScreenshot({ name, raw }: { name: string; raw: string }) {
  const titleId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setUrl(null);
    setFailed(false);
    const token = getMutationToken();
    // The phone gateway does not carry this route — desktop only, like the POST.
    if (token === null || isRemoteMobileMode()) { setFailed(true); return; }
    let alive = true;
    let objectUrl: string | null = null;
    void fetch(`/api/verse/leader/attachment/${name}`, {
      credentials: 'same-origin',
      headers: { 'x-ashlr-token': token },
    }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!alive) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [name]);

  if (url === null) {
    return <p className={leaderStyles.bubble}>{raw}{failed ? ' (image unavailable)' : ''}</p>;
  }
  return (
    <>
      <button type="button" className={styles.shotButton} onClick={() => setOpen(true)} title="Open full size">
        <img className={styles.shot} src={url} alt="Screenshot you sent" />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} titleId={titleId} title="Screenshot you sent" widthClassName={styles.shotDialog}>
        <img className={styles.shotFull} src={url} alt="" />
      </Dialog>
    </>
  );
}
