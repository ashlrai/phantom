/** Resident sleep preference: saved config and installed launchd state are separate. */
import { useEffect, useState } from 'react';
import { Button, Switch } from '../../../components/primitives/index.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost, readFailureReason } from '../../../data/client.js';
import { useMutationHold } from '../../../data/hooks.js';
import { nativeFleetAvailable, runNativeFleetOp } from '../fleet/native-fleet.js';
import { Panel, SettingRow } from './SettingRow.js';
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
    ? 'The running service requests idle and system sleep prevention while plugged in.'
    : 'The running service uses normal macOS sleep behavior.';
}

export function ResidentAwakePanel() {
  const hold = useMutationHold();
  const [state, setState] = useState<ResidentAwakeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void apiGet<unknown>(PATH, controller.signal).then((value) => {
      setState(parseState(value));
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(readFailureReason(cause));
    });
    return () => controller.abort();
  }, []);

  async function refresh(): Promise<void> {
    setState(parseState(await apiGet<unknown>(PATH)));
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
      if (result.phase !== 'done') setError(result.message);
      await refresh();
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
  return (
    <Panel title="Resident Mac">
      <SettingRow
        label="Keep Mac awake while resident runs"
        description="Requests macOS idle and system sleep prevention while the launchd service runs on AC power. Closing the lid or choosing Sleep can still sleep the Mac. This does not keep the desktop app or phone gateway online by itself."
      >
        <Switch aria-label="Keep Mac awake while resident runs" checked={state?.configured === true}
          disabled={!state?.supported || busy || !hold.hasHold}
          onChange={(next) => void change(next)} />
      </SettingRow>
      <SettingRow label="Installed service" description={state ? stateNote(state) : 'Reading the installed resident service…'}>
        {canApply && native ? <Button size="sm" variant="subtle" disabled={busy}
          onClick={() => void apply()}>{state.serviceRunning === true ? 'Review restart' : state.serviceRunning === false ? 'Review start' : 'Review service update'}</Button> : null}
      </SettingRow>
      {canApply && !native ? <p className={styles.panelNote}>Apply the saved preference from Fleet in the Phantom desktop app, or run <code>phm authority resident start</code> in your own Terminal.</p> : null}
      {!hold.hasHold && state?.supported ? <p className={styles.panelNote}>Unlock the mutation hold to change this preference.</p> : null}
      {message ? <p className={styles.panelNote} role="status">{message}</p> : null}
      {error ? <p className={styles.panelNote} role="alert">{error}</p> : null}
    </Panel>
  );
}
