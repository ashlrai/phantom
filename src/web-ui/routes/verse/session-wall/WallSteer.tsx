/**
 * Steering a session's job from its card on the Conversations wall, without
 * opening the conversation. P pauses the job, or resumes it while a pause
 * stands. S stops it, after asking. M moves it to a lane chosen from a list
 * (WallMove.tsx). Each is the call the conversation's own buttons make
 * (`phm job <action>`, POST /api/verse/fleet/runs/control), so the same
 * refusals apply, and each needs the mutation token: with none held, the
 * unlock dialog opens and the request goes once it is given. The receipt is
 * said in a line above the cards, and the card says the request from the
 * moment the server records it (`landed`), before the wall's next read carries
 * it. The line leaves when that read shows the request; a refusal stays until
 * it is dismissed or another key is pressed.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { jobControlText } from '../../../../core/fleet/job-control-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { ConfirmDialog } from '../../inbox/ConfirmDialog.js';
import { postJobControl } from '../fleet-job-log/job-control-action.js';
import { stopFailureText } from '../fleet-job-log/job-stop-action.js';
import type { SessionWallRead, WallEntry } from './session-wall-model.js';
import { landedHolds, landedOf, steerAsk, steerBusyText, steerJob, steerNothingText, steerShown, type Landed, type SteerAsk, type SteerKey } from './wall-steer.js';
import { WallMove } from './WallMove.js';
import styles from './wall-steer.module.css';

interface Said { tone: 'done' | 'waiting' | 'refused'; text: string; /** The request the next read should show; null when nothing landed. */ landed: SteerAsk | null }

const HINT: Partial<Record<SteerAsk['action'], string>> = { pause: ' P on its card resumes it.', resume: ' P on its card pauses it again.' };

export interface WallSteering {
  /** What a key on the focused card calls, with that card's entry. */
  steer: (entry: WallEntry, key?: SteerKey) => void;
  /** Drawn above the cards: the receipt, and the dialogs S, M and a missing token open. */
  line: ReactNode;
  /** Requests the server recorded that the read does not show yet (wall-steer.ts `withLanded`). */
  landed: readonly Landed[];
}

/** `read` is the wall as the server last gave it; `onDone` reads it again. */
export function useWallSteer(read: SessionWallRead | null, onDone: () => void): WallSteering {
  const [said, setSaid] = useState<Said | null>(null);
  const [busy, setBusy] = useState<SteerAsk | null>(null);
  const [locked, setLocked] = useState<SteerAsk | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ job: string; from: string } | null>(null);
  const [landed, setLanded] = useState<readonly Landed[]>([]);
  const inFlight = useRef(false);

  const send = useCallback(async (ask: SteerAsk) => {
    if (inFlight.current) return;
    if (!hasMutationHold()) { setLocked(ask); return; }
    inFlight.current = true;
    setBusy(ask);
    setSaid(null);
    try {
      const receipt = await postJobControl(ask.job, ask.action, ask.lane);
      const mine = landedOf(ask, receipt);
      const recorded = receipt.status === 'applied' || receipt.status === 'requested';
      setSaid({ tone: receipt.status === 'applied' ? 'done' : recorded ? 'waiting' : 'refused', text: `${jobControlText(receipt)}${mine ? HINT[ask.action] ?? '' : ''}`, landed: mine?.ask ?? null });
      // The newest request for a job replaces what the card said for the one before it.
      if (mine) setLanded(list => [...list.filter(one => one.ask.job !== ask.job), mine]);
      if (recorded) onDone();
    } catch (error) {
      setSaid({ tone: 'refused', text: stopFailureText(error), landed: null });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [onDone]);

  // The read now says it (or is newer than the receipt and does not), so the card goes by the read and the line has nothing left to add.
  useEffect(() => {
    if (!read) return;
    if (said?.landed && steerShown(read.entries, said.landed)) setSaid(null);
    setLanded(list => { const kept = list.filter(one => landedHolds(one, read)); return kept.length === list.length ? list : kept; });
  }, [read, said]);

  const steer = useCallback((entry: WallEntry, key: SteerKey = 'p') => {
    const job = steerJob(entry);
    if (job === null) { setSaid({ tone: 'refused', text: steerNothingText(entry.session.id, key), landed: null }); return; }
    if (key === 's') { setSaid(null); setStopping(job); return; }
    if (key === 'm') { setSaid(null); setMoving({ job, from: entry.session.lane }); return; }
    const ask = steerAsk(entry);
    if (ask) void send(ask);
  }, [send]);

  const line = <>
    {busy !== null ? <p className={styles.said} role="status" data-tone="waiting">{steerBusyText(busy)}</p>
      : said && <p className={styles.said} role="status" data-tone={said.tone}>
        <span>{said.text}</span>
        <button type="button" className={styles.dismiss} onClick={() => setSaid(null)}>Dismiss</button>
      </p>}
    <ConfirmDialog open={stopping !== null} onClose={() => setStopping(null)} title={`Stop ${stopping ?? ''}?`}
      body="This stops the job’s running processes." confirmLabel="Yes, stop" destructive
      onConfirm={() => { const job = stopping; setStopping(null); if (job) void send({ job, action: 'stop' }); }} />
    <WallMove ask={moving} onClose={() => setMoving(null)} onMove={(job, lane) => { setMoving(null); void send({ job, action: 'move', lane }); }} />
    <MutationTokenDialog open={locked !== null} onClose={() => setLocked(null)} onUnlocked={() => { const ask = locked; setLocked(null); if (ask) void send(ask); }}
      reason={locked?.action === 'stop' || locked?.action === 'move' ? 'Stopping or moving a session requires the mutation token.' : 'Pausing or resuming a session requires the mutation token.'}
      tokenHelp="the mutation token ashlr verse printed" />
  </>;
  return { steer, line, landed };
}
