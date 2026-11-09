/**
 * routes/verse/comms-confirm/CommsConfirmCard.tsx — the Needs-you item
 * "Confirm Comms limits" (RQ-PHX-COMMSCONFIRMDESK09).
 *
 * Shows, in plain words, exactly what `confirmedByMason` unlocks: who the team
 * transports may message without a per-message approval, on which channels, and
 * every other comms.toml setting. One button POSTs the digest of what is on
 * screen; the server refuses it if the limits changed since this read.
 *
 * Renders only while comms.toml exists and is unconfirmed, plus the confirmed
 * state right after a click here. The POST needs the mutation hold, so it only
 * works from the unlocked desktop app (core/web/comms-confirm-route.ts).
 */
import { useEffect, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { useMutationHold } from '../../../data/hooks.js';
import type { CommsLimitsView } from '../../../../core/comms/comms-confirm.js';
import styles from './CommsConfirmCard.module.css';

export const COMMS_CONFIRM_PATH = '/api/verse/comms/confirm';

export function CommsConfirmCard() {
  const { hasHold, token, touch } = useMutationHold();
  const [view, setView] = useState<CommsLimitsView | null>(null);
  const [posting, setPosting] = useState(false);
  const [justConfirmed, setJustConfirmed] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    apiGet<CommsLimitsView>(COMMS_CONFIRM_PATH, abort.signal)
      .then((read) => { if (!abort.signal.aborted) setView(read); })
      .catch(() => { /* an older server or no read session: show nothing */ });
    return () => abort.abort();
  }, []);

  if (!view || view.state === 'unknown' || !view.limits) return null;
  if (view.state === 'confirmed' && !justConfirmed) return null;

  async function confirm() {
    if (!hasHold || !token || posting || !view?.digest) return;
    setPosting(true);
    setError('');
    try {
      const next = await apiPost<CommsLimitsView>(COMMS_CONFIRM_PATH, { limitsDigest: view.digest }, token);
      touch();
      setView(next);
      setJustConfirmed(true);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.detail ?? reason.message : 'The confirmation failed.');
    } finally { setPosting(false); }
  }

  const { team, channels, settings } = view.limits;
  return (
    <section className={styles.card} aria-label="Confirm Comms limits">
      <h3 className={styles.title}>Confirm Comms limits</h3>
      <p className={styles.body}>
        Until you confirm, the Comms agent only drafts. Confirming lets it message the people below without asking each time. Everyone else stays drafts-only.
      </p>
      <dl className={styles.facts}>
        <dt>May message unprompted</dt>
        <dd>
          {team.length === 0 ? 'Nobody: no team identities are allowlisted in agent-network.toml.' : (
            <ul className={styles.list}>{team.map((id) => <li key={`${id.channel}:${id.id}`}>{id.channel}: {id.id}</li>)}</ul>
          )}
        </dd>
        <dt>Channels</dt>
        <dd>{channels.length ? channels.join(', ') : 'None'}</dd>
        <dt>Other comms.toml settings</dt>
        <dd>
          {settings.length === 0 ? 'None, so comms.toml sets no daily cap.' : (
            <ul className={styles.list}>{settings.map((s) => <li key={s.key}><code>{s.key} = {s.value}</code></li>)}</ul>
          )}
        </dd>
      </dl>
      {view.state === 'confirmed' ? (
        <p className={styles.done} role="status">Confirmed{view.confirmedAt ? ` at ${new Date(view.confirmedAt).toLocaleString()}` : ''}. The Comms agent picks this up on its next check.</p>
      ) : (
        <div className={styles.actions}>
          <Button size="sm" disabled={!hasHold || posting} title={!hasHold ? 'Unlock to confirm' : undefined} onClick={() => void confirm()}>
            {posting ? 'Confirming…' : 'Confirm these limits'}
          </Button>
          {!hasHold && <span>Unlock to confirm</span>}
          {error && <span role="alert">{error}</span>}
        </div>
      )}
    </section>
  );
}
