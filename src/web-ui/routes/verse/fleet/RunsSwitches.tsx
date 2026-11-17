import { useEffect, useRef, useState } from 'react';
import { Switch } from '../../../components/primitives/Switch.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { getRunsSwitches, postRunsSwitch, type RunsSwitchesResponse } from './runs-switches-queries.js';
import { sinceText, switchLabel, switchSummary } from './runs-switches-model.js';
import styles from './runs-switches.module.css';

export function RunsSwitches({ readOnly = false }: { readOnly?: boolean }) {
  const [data, setData] = useState<RunsSwitchesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const sequence = useRef(0);
  const reading = useRef<number | null>(null);
  const active = useRef(true);
  const writes = useRef(new Set<string>());
  const reconcile = useRef(false);

  function read(force = false): void {
    if (writes.current.size || (reading.current !== null && !force)) return;
    const current = ++sequence.current;
    reading.current = current;
    void getRunsSwitches().then(result => {
      if (active.current && current === sequence.current) { setData(result); setError(null); }
    }).catch((reason: unknown) => {
      if (!active.current || current !== sequence.current) return;
      if (reason instanceof ApiError && reason.status === 404) setMissing(true);
      else setError(readFailureReason(reason));
    }).finally(() => { if (reading.current === current) reading.current = null; });
  }

  useEffect(() => {
    active.current = true;
    const currentSequence = sequence;
    read();
    return () => { active.current = false; currentSequence.current++; reading.current = null; };
  }, []);
  usePollWhileVisible(read, 10_000, { enabled: !missing });

  async function change(id: string, checked: boolean): Promise<void> {
    if (id === 'HOLD' || writes.current.has(id)) return;
    writes.current.add(id);
    if (writes.current.size > 1) reconcile.current = true;
    setPending([...writes.current]);
    const current = ++sequence.current;
    setError(null);
    try {
      const result = await postRunsSwitch(id, !checked);
      if (active.current && current === sequence.current) setData(result);
    } catch (reason) {
      if (active.current) setError(reason instanceof VerseControlLockedError ? reason.message : readFailureReason(reason));
    } finally {
      writes.current.delete(id);
      if (active.current) {
        setPending([...writes.current]);
        // Concurrent writes can settle out of order; read once they all finish.
        if (reconcile.current && writes.current.size === 0) { reconcile.current = false; read(true); }
      }
    }
  }

  return (
    <div className={styles.strip} role="group" aria-label="Fleet switches">
      <div className={styles.heading}><strong>Switches</strong>{!missing && data && data.sourceState !== 'missing' ? <span>{data.sourceState === 'degraded' && !data.switches.length ? 'Status incomplete' : switchSummary(data.switches)}</span> : null}</div>
      {missing ? <p>Switches are not in this build yet.</p> : data?.sourceState === 'missing' ? <p>No fleet runs directory on this Mac.</p> : data ? (
        <ul className={styles.rows}>
          {data.switches.map(row => {
            const since = row.id !== 'HOLD' && row.on ? sinceText(row.since, Date.now()) : null;
            const description = `${row.effect}${since ? ` · ${since}` : ''}`;
            return (
              <Tooltip key={row.id} placement="top" content={description}>
                <li className={styles.row}>
                  <Switch label={switchLabel(row.id)} checked={row.id === 'HOLD' ? row.on : !row.on} onChange={checked => void change(row.id, checked)} disabled={readOnly || row.id === 'HOLD' || pending.includes(row.id)} aria-describedby={`switch-description-${row.id}`} />
                  <span className={styles.description} id={`switch-description-${row.id}`}>{description}</span>
                </li>
              </Tooltip>
            );
          })}
        </ul>
      ) : !error ? <p>Reading switches…</p> : null}
      {data?.sourceState === 'degraded' && !missing ? <p role="status">Switches may be incomplete; the source is degraded.</p> : null}
      {error && !missing ? <p role="status">{error}</p> : null}
    </div>
  );
}
