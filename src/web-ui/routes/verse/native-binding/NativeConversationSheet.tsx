import { useEffect, useId, useRef, useState } from 'react';
import type { VerseNativeSessionBinding } from '../../../../core/verse/native-session-binding-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { ProviderLogo } from '../../../components/primitives/ProviderLogo.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { ENGINE_LABEL } from '../verse-model.js';
import { nativeBindingApi, nativeBindingReadError, type NativeBindingApi } from './native-binding-client.js';
import styles from './NativeConversationSheet.module.css';

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  api?: NativeBindingApi;
}
type ReadState = { sessionId: string; request: number; binding?: VerseNativeSessionBinding; error?: string };
type CopyState = { sessionId: string; outcome: 'copied' | 'failed' | 'copying' };

const ID_NOTE = {
  'not-created': 'No native conversation ID has been saved for this chat yet.',
  unsupported: 'This agent does not provide a supported native conversation binding.',
  invalid: 'The saved conversation ID is unavailable.',
  recorded: '',
} as const;

export function NativeConversationSheet({ sessionId, open, onClose, api = nativeBindingApi }: Props) {
  const titleId = useId();
  const [request, setRequest] = useState(0);
  const [read, setRead] = useState<ReadState | null>(null);
  const [copy, setCopy] = useState<CopyState | null>(null);
  const current = useRef({ sessionId, open });
  current.current = { sessionId, open };

  useEffect(() => () => { current.current.open = false; }, []);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    api.read(sessionId, abort.signal).then(
      binding => { if (!abort.signal.aborted) setRead({ sessionId, request, binding }); },
      error => { if (!abort.signal.aborted) setRead({ sessionId, request, error: nativeBindingReadError(error) }); },
    );
    return () => abort.abort();
  }, [api, open, request, sessionId]);

  // A changed selection hides the previous chat before effects clean up its read.
  const result = read?.sessionId === sessionId && read.request === request ? read : null;
  const binding = result?.binding ?? null;
  const copyState = copy?.sessionId === sessionId ? copy.outcome : null;
  const copyId = async () => {
    if (binding?.nativeIdState !== 'recorded' || !binding.nativeSessionId) return;
    setCopy({ sessionId, outcome: 'copying' });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(binding.nativeSessionId);
      if (current.current.open && current.current.sessionId === sessionId) setCopy({ sessionId, outcome: 'copied' });
    } catch {
      if (current.current.open && current.current.sessionId === sessionId) setCopy({ sessionId, outcome: 'failed' });
    }
  };

  return (
    <Sheet open={open} onClose={onClose} titleId={titleId} title="Native conversation"
      description="Conversation details saved by Phantom for this chat."
      footer={<p className={styles.quiet}>These details do not establish a live connection to an agent or desktop app.</p>}>
      <div className={styles.body} aria-busy={result === null || undefined}>
        {result === null ? <p className={styles.quiet} role="status">Loading saved conversation…</p> : null}
        {result?.error ? <div className={styles.error}><p role="alert">{result.error}</p>
          <Button size="sm" onClick={() => setRequest(value => value + 1)}>Try again</Button></div> : null}
        {binding ? <>
          <div className={styles.engine}><ProviderLogo engine={binding.engine} size={20} />
            <div><h3 className={styles.heading}>{ENGINE_LABEL[binding.engine]}</h3><p className={styles.quiet}>Saved Phantom metadata</p></div></div>
          <section className={styles.group} aria-labelledby={`${titleId}-conversation`}>
            <h3 className={styles.heading} id={`${titleId}-conversation`}>Conversation ID</h3>
            {binding.nativeIdState === 'recorded' && binding.nativeSessionId ? <>
              <code className={styles.id}>{binding.nativeSessionId}</code>
              <div className={styles.copyRow}><Button size="sm" busy={copyState === 'copying'} onClick={() => void copyId()}>Copy conversation ID</Button>
                {copyState === 'copied' ? <span className={styles.quiet} role="status">Copied</span> : null}</div>
              {copyState === 'failed' ? <p className={styles.errorText} role="alert">Couldn’t copy. Select the conversation ID and copy it manually.</p> : null}
            </> : <p className={styles.quiet}>{ID_NOTE[binding.nativeIdState]}</p>}
          </section>
          <dl className={styles.facts}>
            <div><dt>Saved status</dt><dd>{binding.savedStatus === 'running' ? 'Running when last saved' : binding.savedStatus === 'error' ? 'Error when last saved' : 'Idle when last saved'}</dd></div>
            <div><dt>Last saved</dt><dd><time dateTime={binding.savedUpdatedAt}>{new Date(binding.savedUpdatedAt).toLocaleString()}</time></dd></div>
            <div><dt>Live session ownership</dt><dd>Unverified</dd></div>
            <div><dt>Desktop app connection</dt><dd>Unverified</dd></div>
          </dl>
        </> : null}
      </div>
    </Sheet>
  );
}
