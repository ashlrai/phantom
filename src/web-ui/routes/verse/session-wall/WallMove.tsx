/**
 * M on a card of the Conversations wall: the lanes the session's job could
 * move to, in a dialog over the wall. The lanes come from the fleet read (GET
 * /api/verse/fleet/runs), asked for only once the dialog opens. A held lane
 * and a lane with no free slot are listed with the reason and cannot be
 * chosen, the rule the conversation's own Move applies. Up and Down (or K and
 * J) step through the lanes that can be chosen, Enter moves, Esc leaves the
 * job where it is.
 */
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { moveLanes } from './wall-steer.js';
import styles from './wall-steer.module.css';

export function WallMove({ ask, onMove, onClose }: {
  /** The job M was pressed on and the lane it is on now; null keeps the dialog closed. */
  ask: { job: string; from: string } | null;
  onMove: (job: string, lane: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const open = ask !== null;
  const lanes = useQuery(opsRunsQuery, { enabled: open, freshMs: 10_000 });
  const retry = useRefetch(opsRunsQuery);
  const list = useRef<HTMLUListElement>(null);
  const rows = open && lanes.data ? moveLanes(lanes.data.lanes, ask.from) : null;
  const choosable = rows?.filter(row => row.blocked === null).length ?? 0;
  // The lanes can arrive after the dialog has taken the keyboard; the first lane that can be chosen takes it then.
  useEffect(() => { if (open && choosable > 0) list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [open, choosable]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const step = event.key === 'ArrowDown' || event.key === 'j' ? 1 : event.key === 'ArrowUp' || event.key === 'k' ? -1 : 0;
    if (step === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const to = all[all.indexOf(document.activeElement as HTMLButtonElement) + step];
    event.preventDefault();
    to?.focus();
  };
  const unknown = lanes.error ? 'Lanes unknown: the fleet read did not answer.' : lanes.data === null ? 'Lanes unknown: this Phantom server has no fleet read.' : null;
  return <Dialog open={open} onClose={onClose} titleId={titleId} title={`Move ${ask?.job ?? ''} to another lane`}
    description={open ? `It is on ${ask.from === 'unknown' ? 'a lane the session list does not name' : ask.from} now. Up and Down choose, Enter moves it, Esc leaves it there.` : undefined}>
    {unknown !== null ? <p className={styles.moveNote} role="alert">{unknown} {lanes.error != null && <button type="button" className={styles.dismiss} onClick={retry}>Try again</button>}</p>
      : rows === null ? <p className={styles.moveNote} role="status">Reading lanes…</p>
      : rows.length === 0 ? <p className={styles.moveNote} role="status">The fleet read names no other lane to move it to.</p>
      : <>
        <ul ref={list} className={styles.lanes} aria-label="Lanes" onKeyDown={onKeyDown}>
          {rows.map(row => <li key={row.lane}>
            <button type="button" className={styles.lane} disabled={row.blocked !== null} data-blocked={row.blocked ?? undefined} onClick={() => onMove(ask!.job, row.lane)}>
              <ProviderBadge of={row.lane} iconOnly size={14} />
              <strong>{row.lane}</strong>
              <span>{row.text}</span>
            </button>
          </li>)}
        </ul>
        {choosable === 0 && <p className={styles.moveNote} role="status">Every other lane is held or has no free slot, so there is nowhere to move it right now.</p>}
      </>}
    <div className={styles.moveActions}><button type="button" className={styles.cancel} onClick={onClose}>Cancel</button></div>
  </Dialog>;
}
