import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Switch } from '../../../components/primitives/Switch.js';
import { Tag } from '../../../components/primitives/Tag.js';
import { Button } from '../../../components/primitives/Button.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { getMutationToken, subscribeAuth } from '../../../data/auth-store.js';
import { ApiError } from '../../../data/client.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { refreshFleetControlReads } from './fleet-control-queries.js';
import { fetchSwitches, postSwitch } from './switches-queries.js';
import { summary, switchLabel, switchEffect, sinceText, type SwitchesState, type FleetSwitch } from './switches-model.js';
import styles from './switches-row.module.css';

export function SwitchesRow() {
  const id = useId();
  const visible = useSectionVisible();
  const token = useSyncExternalStore(subscribeAuth, getMutationToken, () => null);
  const [state, setState] = useState<SwitchesState | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<FleetSwitch | null>(null);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const read = useRef<AbortController | null>(null);
  const absent = useRef(false);
  async function load() {
    if (busy.current || read.current || absent.current) return;
    const controller = new AbortController();
    read.current = controller;
    try {
      const result = await fetchSwitches(controller.signal);
      if (!controller.signal.aborted) { setState(result); setError(''); }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError && err.status === 404) { absent.current = true; setMissing(true); }
      else setError(err instanceof Error ? err.message : 'The switch state could not be read.');
    } finally { if (read.current === controller) read.current = null; }
  }
  useEffect(() => {
    if (visible) { absent.current = false; setMissing(false); void load(); }
    return () => { read.current?.abort(); read.current = null; };
  }, [visible]);
  usePollWhileVisible(() => { void load(); }, 10_000, { refreshOnShow: false });
  async function change(row: FleetSwitch, on: boolean) {
    if (busy.current || !getMutationToken()) return;
    busy.current = true;
    read.current?.abort(); read.current = null;
    setSending(true); setPending(null); setError('');
    try { setState(await postSwitch(row.id, on)); refreshFleetControlReads(); }
    catch (err) { setError(err instanceof ApiError ? err.detail ?? err.message : err instanceof Error ? err.message : 'The switch could not be changed.'); }
    finally { busy.current = false; setSending(false); }
  }
  if (missing) return <span>Switches are not in this build yet.</span>;
  return <div className={styles.root} aria-busy={sending}>
    <span role="status">{state ? summary(state.switches, state.sourceState) : 'Reading switches…'}</span>
    {sending ? <RefreshIndicator label="Updating switches…" /> : null}
    {state?.switches.map((row, index) => <div className={styles.row} key={row.id}>
      <Switch checked={row.on} label={switchLabel(row.id)} aria-label={switchLabel(row.id)} aria-describedby={`${id}-${index}`}
        disabled={sending || !token} onChange={on => { if (on) setPending(row); else void change(row, false); }} />
      {row.on ? <><Tag size="sm" className={styles.danger}>on</Tag><span>{sinceText(row.since, Date.now())}</span></> : null}
      <span id={`${id}-${index}`} className={styles.effect}>{switchEffect(row)}</span>
    </div>)}
    {!token ? <span>{new VerseMutationLockedError().message}</span> : null}
    {error ? <span role="alert">{error}</span> : null}
    {pending ? <div className={styles.row}>
      <span>Turn on {switchLabel(pending.id)}? {switchEffect(pending)}.</span>
      <Button size="sm" variant="danger" disabled={sending || !token} onClick={() => void change(pending, true)}>Turn on {switchLabel(pending.id)}</Button>
      <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
    </div> : null}
  </div>;
}
