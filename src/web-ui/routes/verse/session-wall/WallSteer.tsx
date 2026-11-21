/**
 * P on a card of the Conversations wall pauses that session's job, or resumes
 * it while a pause stands, without opening the conversation. It is the call
 * the conversation's own Pause and Resume buttons make (`phm job pause`,
 * POST /api/verse/fleet/runs/control), so the same refusals apply, and it
 * needs the mutation token: with none held, the unlock dialog opens and the
 * request goes once it is given. The receipt is said in a line above the
 * cards. That line leaves when the next read shows the request on the card
 * itself; a refusal stays until it is dismissed or P is pressed again. Stop
 * and Move stay in the conversation, where Stop asks first.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { jobControlText } from '../../../../core/fleet/job-control-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { postJobControl } from '../fleet-job-log/job-control-action.js';
import { stopFailureText } from '../fleet-job-log/job-stop-action.js';
import type { WallEntry } from './session-wall-model.js';
import { steerAsk, steerShown, type SteerAsk } from './wall-steer.js';
import styles from './wall-steer.module.css';

interface Said { tone: 'done' | 'waiting' | 'refused'; text: string; /** The request the next read should show; null when nothing landed. */ landed: SteerAsk | null }

/** `steer` is what P calls with the focused card's entry; `line` is drawn above the cards. `onDone` reads the wall again. */
export function useWallSteer(entries: readonly WallEntry[] | null, onDone: () => void): { steer: (entry: WallEntry) => void; line: ReactNode } {
  const [said, setSaid] = useState<Said | null>(null);
  const [busy, setBusy] = useState<SteerAsk | null>(null);
  const [locked, setLocked] = useState<SteerAsk | null>(null);
  const inFlight = useRef(false);

  const send = useCallback(async (ask: SteerAsk) => {
    if (inFlight.current) return;
    if (!hasMutationHold()) { setLocked(ask); return; }
    inFlight.current = true;
    setBusy(ask);
    setSaid(null);
    try {
      const receipt = await postJobControl(ask.job, ask.action);
      const landed = receipt.status === 'applied' || receipt.status === 'requested';
      const hint = landed && !receipt.dryRun ? (ask.action === 'pause' ? ' P on its card resumes it.' : ' P on its card pauses it again.') : '';
      setSaid({ tone: receipt.status === 'applied' ? 'done' : landed ? 'waiting' : 'refused', text: `${jobControlText(receipt)}${hint}`, landed: landed && !receipt.dryRun ? ask : null });
      if (landed) onDone();
    } catch (error) {
      setSaid({ tone: 'refused', text: stopFailureText(error), landed: null });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [onDone]);

  // The card now says it, so the line has nothing left to add.
  useEffect(() => { if (said?.landed && entries && steerShown(entries, said.landed)) setSaid(null); }, [entries, said]);

  const steer = useCallback((entry: WallEntry) => {
    const ask = steerAsk(entry);
    if (ask === null) { setSaid({ tone: 'refused', text: `${entry.session.id} has no running job to pause or resume.`, landed: null }); return; }
    void send(ask);
  }, [send]);

  const line = <>
    {busy !== null ? <p className={styles.said} role="status" data-tone="waiting">{busy.action === 'pause' ? 'Pausing' : 'Resuming'} {busy.job}…</p>
      : said && <p className={styles.said} role="status" data-tone={said.tone}>
        <span>{said.text}</span>
        <button type="button" className={styles.dismiss} onClick={() => setSaid(null)}>Dismiss</button>
      </p>}
    <MutationTokenDialog open={locked !== null} onClose={() => setLocked(null)} onUnlocked={() => { const ask = locked; setLocked(null); if (ask) void send(ask); }}
      reason="Pausing or resuming a session requires the mutation token." tokenHelp="the mutation token ashlr verse printed" />
  </>;
  return { steer, line };
}
