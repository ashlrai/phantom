/** Resident sleep preference: saved config and installed launchd state are separate. */
import { useEffect, useState } from 'react';
import { Button, Switch } from '../../../components/primitives/index.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost, readFailureReason } from '../../../data/client.js';
import { useMutationHold } from '../../../data/hooks.js';
import { nativeFleetAvailable, runNativeFleetOp } from '../fleet/native-fleet.js';
import { Panel, SettingRow } from './SettingRow.js';
import { CoffeeAwakeScene } from './CoffeeAwakeScene.js';
import coffee from './CoffeeAwakeScene.module.css';
import ashCoffee from './assets/ash-coffee.webp';
import styles from './SettingsSection.module.css';

interface ResidentAwakeState {
  schema: 'ashlr.resident-awake.v1';
  supported: boolean;
  configured: boolean;
  installed: boolean | null;
  serviceInstalled: boolean | null;
  serviceRunning: boolean | null;
  restartRequired: boolean;
  saved: boolean;
}

function parseState(value: unknown): ResidentAwakeState {
  if (!value || typeof value !== 'object') throw new Error('Resident service status could not be verified.');
  const row = value as Record<string, unknown>;
  if (row['schema'] !== 'ashlr.resident-awake.v1' || typeof row['supported'] !== 'boolean' ||
      typeof row['configured'] !== 'boolean' ||
      (row['installed'] !== null && typeof row['installed'] !== 'boolean') ||
      (row['serviceInstalled'] !== null && typeof row['serviceInstalled'] !== 'boolean') ||
      (row['serviceRunning'] !== null && typeof row['serviceRunning'] !== 'boolean') || typeof row['restartRequired'] !== 'boolean' ||
      typeof row['saved'] !== 'boolean') {
    throw new Error('Resident service status could not be verified.');
  }
  return row as unknown as ResidentAwakeState;
}

const PATH = '/api/verse/resident-awake';

function stateNote(state: ResidentAwakeState): string {
  if (!state.supported) return 'Available for the macOS resident service.';
  if (state.serviceInstalled === null || (state.serviceInstalled && state.installed === null)) {
    return 'The installed service could not be verified. Check Fleet before changing it.';
  }
  if (!state.serviceInstalled) return 'Saved preference. Start the resident service to apply it.';
  if (state.restartRequired) return 'Saved preference. Restart the resident service to apply it.';
  if (state.serviceRunning === null) return 'Installed preference matches; launchd running state could not be verified here. Check Fleet.';
  if (!state.serviceRunning) return 'Installed preference matches, but the resident service is not running.';
  return state.installed
    ? 'The running service requests idle sleep prevention, plus system sleep prevention on AC power.'
    : 'The running service uses normal macOS sleep behavior.';
}

export function ResidentAwakePanel() {
  const hold = useMutationHold();
  const [state, setState] = useState<ResidentAwakeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pouring, setPouring] = useState(false);

  useEffect(() => {
    if (!pouring) return;
    // Reduced-motion has no animationend event. Keep replay finite there too.
    const timer = window.setTimeout(() => setPouring(false), 1400);
    return () => window.clearTimeout(timer);
  }, [pouring]);

  useEffect(() => {
    const controller = new AbortController();
    void apiGet<unknown>(PATH, controller.signal).then((value) => {
      setState(parseState(value));
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(readFailureReason(cause));
    });
    return () => controller.abort();
  }, []);

  async function refresh(): Promise<ResidentAwakeState> {
    const next = parseState(await apiGet<unknown>(PATH));
    setState(next);
    return next;
  }

  async function change(next: boolean): Promise<void> {
    const token = getMutationToken();
    if (!token) { setError('Unlock actions with the mutation token before changing the resident service.'); return; }
    setBusy(true); setError(null); setMessage(null);
    try {
      const saved = parseState(await apiPost<unknown>(PATH, { keepAwake: next }, token));
      touchMutationHold();
      setState(saved);
      setMessage('Resident preference saved and read back.');
    } catch (cause) {
      setError(readFailureReason(cause));
      try { await refresh(); } catch { /* retain last verified state */ }
    } finally {
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    if (!state || !nativeFleetAvailable('resident-start') || !nativeFleetAvailable('resident-restart')) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      // An unknown launchd state may still have a running manager. Use the
      // native confirmed restart path to stop it before updating its plist.
      const op = state.serviceInstalled === true && state.serviceRunning !== false
        ? 'resident-restart' : 'resident-start';
      const result = await runNativeFleetOp(op, { onProgress: (event) => setMessage(event.message) });
      if (result.phase !== 'done') { setMessage(null); setError(result.message); }
      const next = await refresh();
      // Animate only a confirmed operation with matching, running readback.
      // This is feedback for installation, not a claim about AC or the lid.
      if (result.phase === 'done' && next.supported && next.serviceInstalled === true &&
          next.serviceRunning === true && next.configured && next.installed === true && !next.restartRequired) {
        setPouring(true);
      }
      if (result.phase === 'done') setMessage('Resident service read back after the confirmed native operation.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The native resident operation did not finish.');
    } finally {
      setBusy(false);
    }
  }

  const canApply = state?.supported && (state.restartRequired || state.serviceInstalled === false ||
    (state.serviceInstalled === true && state.serviceRunning === false));
  const native = nativeFleetAvailable('resident-start') && nativeFleetAvailable('resident-restart');
  const active = state?.supported === true && state.serviceInstalled === true &&
    state.serviceRunning === true && state.installed === true;
  const caption = !state ? 'Reading resident service' : !state.supported ? 'macOS resident only' :
    state.serviceInstalled === false ? 'Saved; resident not installed' :
    state.serviceInstalled === null || state.installed === null || state.serviceRunning === null ? 'Service state unverified' :
    state.restartRequired ? 'Saved; service update needed' : state.serviceRunning === false ? 'Resident stopped' :
    active ? 'Sleep prevention installed' : 'Normal sleep behavior';
  const hint = state?.restartRequired ? 'The next start or restart applies your saved preference.' :
    active ? 'Coffee for the long run. Plug in for extended work.' :
    state?.serviceRunning === true ? 'Let macOS sleep normally, or keep the resident going.' :
    'Check the service before relying on sleep prevention.';
  return (
    <Panel title="Resident Mac">
      <div className={coffee.experience}>
        <CoffeeAwakeScene active={active} pouring={pouring && active} onPourEnd={() => setPouring(false)} />
        <div>
          <p className={coffee.caption}>{caption}</p>
          <p className={coffee.hint}>{hint}</p>
          {active ? <Button size="sm" variant="subtle" disabled={pouring || busy}
            onClick={() => setPouring(true)}>Replay coffee pour</Button> : null}
        </div>
      </div>
      <SettingRow
        label="Keep Mac awake while resident runs"
        description="Requests idle sleep prevention while the resident runs, plus system sleep prevention on AC power. Plug in for extended runs; this may use more battery. Closing the lid or choosing Sleep can still sleep the Mac."
      >
        <Switch aria-label="Keep Mac awake while resident runs" checked={state?.configured === true}
          disabled={!state?.supported || busy || !hold.hasHold}
          onChange={(next) => void change(next)} />
      </SettingRow>
      <SettingRow label="Installed service" description={state ? stateNote(state) : 'Reading the installed resident service…'}>
        {canApply && native ? <Button size="sm" variant="subtle" disabled={busy}
          onClick={() => void apply()}>{state.serviceRunning === true ? 'Review restart' : state.serviceRunning === false ? 'Review start' : 'Review service update'}</Button> : null}
      </SettingRow>
      <details className={coffee.details}>
        <summary>How sleep prevention works</summary>
        <div className={coffee.explainer}>
          <figure className={coffee.mascot} data-pouring={pouring && active}>
            <img src={ashCoffee} alt="Ash holding a cup of coffee" width="112" height="112" loading="lazy" decoding="async" />
          </figure>
          <div><p className={coffee.ashTitle}>Ash brought coffee.</p>
            <p>The switch saves your preference. A confirmed resident start or restart installs it. The coffee is a small animation, not a measurement of whether your Mac is awake.</p>
          </div>
        </div>
        {state ? <dl className={coffee.evidence}>
          <div><dt>Saved preference</dt><dd>{state.configured ? 'Keep awake' : 'Normal sleep'}</dd></div>
          <div><dt>Installed preference</dt><dd>{state.installed === null ? 'Unverified' : state.installed ? 'Keep awake' : 'Normal sleep'}</dd></div>
          <div><dt>Resident service</dt><dd>{state.serviceRunning === null ? 'Unverified' : state.serviceRunning ? 'Running' : 'Stopped'}</dd></div>
        </dl> : null}
        <p>When enabled, the resident requests idle sleep prevention, including on battery, and system sleep prevention on AC power. Plug in for extended runs; this may use more battery. This panel does not read your power source. Closing the lid, choosing Sleep or other macOS power constraints can still suspend work. The desktop app and phone gateway must also be running for remote access.</p>
      </details>
      {canApply && !native ? <p className={styles.panelNote}>Apply the saved preference from Fleet in the Phantom desktop app, or run <code>phm authority resident start</code> in your own Terminal.</p> : null}
      {!hold.hasHold && state?.supported ? <p className={styles.panelNote}>Unlock the mutation hold to change this preference.</p> : null}
      {message ? <p className={styles.panelNote} role="status">{message}</p> : null}
      {error ? <p className={styles.panelNote} role="alert">{error}</p> : null}
    </Panel>
  );
}
