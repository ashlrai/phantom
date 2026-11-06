import { lazy, Suspense, useId, useState } from 'react';
import styles from './FrictionFeedback.module.css';
import { apiPost } from '../../../data/client.js';
import { getMutationToken } from '../../../data/auth-store.js';

const Dialog = lazy(() => import('../../../components/primitives/Dialog.js').then((module) => ({ default: module.Dialog })));

export function FrictionFeedback({ surface, className }: { surface: string; className?: string }) {
  const titleId = useId();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const close = () => { if (!saving) setOpen(false); };
  return <>
    <button type="button" className={className} aria-label="Flag UI friction" title="Flag UI friction"
      onClick={() => { setSaved(false); setError(''); setOpen(true); }}>⚑</button>
    <Suspense fallback={null}>{open && <Dialog open={open} onClose={close} titleId={titleId} title="Flag UI friction"
      description="Describe what got in your way. This saves a local improvement request for the router.">
      {saved ? <><p role="status">Flag saved to the local router queue.</p><button type="button" onClick={close}>Done</button></> :
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          if (saving || !description.trim()) return;
          setSaving(true); setError('');
          try {
            const token = getMutationToken();
            if (!token) throw new Error('Authorize console mutations before flagging friction.');
            await apiPost('/api/verse/feedback', { description: description.trim(), surface }, token);
            setDescription(''); setSaved(true);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not save the flag. Try again.');
          } finally { setSaving(false); }
        }}>
          <label htmlFor={inputId}>What felt frustrating?</label>
          <textarea id={inputId} value={description} maxLength={2000} required disabled={saving}
            onChange={(event) => setDescription(event.target.value)} />
          <p>Surface: {surface}. Include only details you want stored in the request.</p>
          {error && <p role="alert">{error}</p>}
          <button type="button" disabled={saving} onClick={close}>Cancel</button>
          <button type="submit" disabled={saving || !description.trim()}>{saving ? 'Saving…' : 'Save flag'}</button>
        </form>}
    </Dialog>}</Suspense>
  </>;
}
