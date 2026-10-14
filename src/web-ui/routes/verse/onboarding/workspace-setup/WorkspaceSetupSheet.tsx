import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../../../../components/primitives/Button.js';
import { Sheet } from '../../../../components/primitives/Sheet.js';
import { useVerseUi } from '../../useVerseUi.js';
import { getVerseSessionHead, subscribeVerseSession } from '../../verse-store.js';
import { insertIntoComposer } from '../../chat/composer-bridge.js';
import { ImportContextPane } from './ImportContextPane.js';
import { SETUP_PRODUCTS, workspaceSetupBrief } from './setup-model.js';
import styles from './workspace-setup.module.css';

export function WorkspaceSetupSheet({ onClose }: { onClose: () => void }) {
  const titleId = useId(); const ui = useVerseUi();
  const subscribe = useCallback((listener: () => void) => ui.activeSessionId ? subscribeVerseSession(ui.activeSessionId, listener) : () => {}, [ui.activeSessionId]);
  const head = useSyncExternalStore(subscribe, () => getVerseSessionHead(ui.activeSessionId), () => getVerseSessionHead(ui.activeSessionId));
  const [contextOpened, setContextOpened] = useState(false);
  const [tab, setTab] = useState<'tools' | 'context'>('tools');
  const [notice, setNotice] = useState<string | null>(null); const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const addBrief = () => setNotice(ui.activeSessionId && ui.section === 'chat' && insertIntoComposer(ui.activeSessionId, workspaceSetupBrief())
    ? 'Setup brief added to the message draft. Review it before sending.' : 'Open a chat to add the setup brief to its message, or copy it below.');
  const copyBrief = async () => {
    try { await navigator.clipboard.writeText(workspaceSetupBrief()); if (live.current) setNotice('Agent setup brief copied.'); }
    catch { if (live.current) setNotice('The clipboard is unavailable. Open the setup brief below and copy it manually.'); }
  };
  return <Sheet open onClose={onClose} width={680} titleId={titleId} title="Set up my workspace"
    description="Your developer tools and selected context, in one place.">
    <div className={styles.body}>
      <div className={styles.tabs} aria-label="Workspace setup sections">
        <Button aria-pressed={tab === 'tools'} onClick={() => setTab('tools')}>Developer tools</Button>
        <Button aria-pressed={tab === 'context'} onClick={() => { setContextOpened(true); setTab('context'); }}>Bring your context</Button>
      </div>
      {tab === 'tools' ? <>
        <p className={styles.intro}>Give your agents a clear place to start.</p>
        <p className={styles.quiet}>Phantom is your workbench. Its three companion tools are installed and configured separately. These guides do not inspect or activate them.</p>
        <div className={styles.products}>
          {SETUP_PRODUCTS.map(product => <section key={product.id} className={styles.card} data-host={product.id === 'phantom' || undefined} aria-labelledby={`${titleId}-${product.id}`}>
            <h3 id={`${titleId}-${product.id}`}>{product.name}</h3><p className={styles.role}>{product.role}</p>
            <p className={styles.quiet}>{product.detail}</p><p className={styles.quiet}>{product.id === 'phantom' ? 'Current workbench surface' : 'Installation and runtime readiness not checked'}</p>
            <div className={styles.links}><a href={product.docs} target="_blank" rel="noopener noreferrer">Documentation</a>
              {product.release ? <a href={product.release} target="_blank" rel="noopener noreferrer">Reviewed release</a> : null}</div>
          </section>)}
        </div>
        <div className={styles.actions}><Button variant="primary" onClick={() => void copyBrief()}>Copy agent setup brief</Button>
          <Button onClick={addBrief}>Add brief to message</Button></div>
        <p className={styles.quiet}>The brief asks an agent to inspect the existing setup, verify artifacts and show what remains. Adding it creates a draft; you decide when to send it.</p>
        <details><summary>Read the setup brief</summary><pre className={styles.quiet} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{workspaceSetupBrief()}</pre></details>
        {notice ? <p className={styles.status} role="status">{notice}</p> : null}
      </> : null}
      {contextOpened ? <div hidden={tab !== 'context'}><ImportContextPane key={`${ui.activeSessionId ?? 'none'}:${head.session?.projectPath ?? ''}`}
        sessionId={ui.section === 'chat' ? ui.activeSessionId : null} projectPath={head.session?.projectPath ?? null} /></div> : null}
    </div>
  </Sheet>;
}
