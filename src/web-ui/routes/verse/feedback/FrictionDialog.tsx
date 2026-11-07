import { useId, useState } from 'react';
import styles from './FrictionFeedback.module.css';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { apiPost } from '../../../data/client.js';
import { getMutationToken } from '../../../data/auth-store.js';

/**
 * The flag dialog and its submit, loaded when the rail's ⚑ is first pressed
 * (FrictionFeedback.tsx) — the button is first paint, the form is not.
 */
export default function FrictionDialog({ surface, description, setDescription, onClose }: {
  surface: string;
  /** Held by the button, so a cancelled flag is still there when reopened. */
  description: string;
  setDescription: (description: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const inputId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const close = () => { if (!saving) onClose(); };
  return <Dialog open onClose={close} titleId={titleId} title="Flag UI friction"
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
    </Dialog>;
}
