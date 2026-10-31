import { useEffect, useState } from 'react';
import { DESKTOP_UPDATE_REASONS } from '../../../app/desktop-update-reasons.js';
import { setDesktopPreference } from '../../../app/desktop-state.js';
import { refreshDesktopUpdates, useDesktopUpdates, type DesktopUpdateState } from '../../../app/desktop-updates.js';
import { formatMetric } from '../../../components/charts/format-metric.js';
import styles from './PowerStatus.module.css';
const labels: Record<DesktopUpdateState['phase'], string> = {
  uncommissioned: 'Updates unavailable', disabled: 'Automatic updates off', checking: 'Checking updates',
  idle: 'No update found', available: 'Update available', downloading: 'Downloading update', staged: 'Update prepared',
  'waiting-for-idle': 'Update waits for idle', 'waiting-for-app-quit': 'Update ready on quit',
  'adoption-held': 'Update needs attention', installing: 'Installing update', installed: 'Update installed',
  current: 'Up to date', failed: 'Update check failed',
};
const notes: Partial<Record<DesktopUpdateState['phase'], string>> = {
  uncommissioned: 'Signed updates are not available for this build.',
  disabled: 'Automatic downloads and installation are off.',
  'waiting-for-idle': 'Finish local work and stop the fleet before updating.',
  'waiting-for-app-quit': 'Quit Phantom normally to install the verified update.',
  'adoption-held': 'Phantom could not confirm the conditions for automatic installation. Your current installation stays in place.',
  installed: 'The installed app and CLI were verified. Fleet restart is managed separately.',
  failed: 'The update could not be verified or prepared. Your current installation stays in place.',
};
/** Native facts only; changing the switch waits for the native acknowledgement. */
export function UpdateStatus() {
  const state = useDesktopUpdates();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { refreshDesktopUpdates(); }, []);
  useEffect(() => { setPending(false); setError(null); }, [state?.enabled]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => { setPending(false); setError('The desktop app did not confirm the setting.'); }, 4000);
    return () => { window.clearTimeout(timer); };
  }, [pending]);
  if (!state) return null;
  const label = labels[state.phase];
  const downloading = state.phase === 'downloading';
  return <details className={styles.status}>
    <summary aria-label={`Desktop updates: ${label}`}>{label}</summary>
    <div className={styles.panel}>
      <strong>Phantom updates</strong>
      <p role="status">{state.version ? `Version ${state.version} · ` : ''}{label}</p>
      {downloading && <>
        <progress className={styles.progress} aria-label="Update download" value={state.bytesTotal === null ? undefined : state.bytesReceived} max={state.bytesTotal ?? undefined} />
        <p>{formatMetric(state.bytesReceived / 1024 / 1024)} MB{state.bytesTotal !== null ? ` of ${formatMetric(state.bytesTotal / 1024 / 1024)} MB · ${formatMetric(state.bytesReceived / state.bytesTotal * 100)}%` : ' downloaded'}</p>
      </>}
      <label><input type="checkbox" aria-label="Automatic updates" checked={state.enabled} disabled={pending} onChange={(event) => {
        if (setDesktopPreference('automaticUpdates', event.target.checked)) { setPending(true); setError(null); }
        else setError('The desktop app could not change this setting.');
      }} />Automatic updates</label>
      {pending && <p role="status">Saving setting…</p>}
      {error && <p role="alert">{error}</p>}
      {state.reason && Object.hasOwn(DESKTOP_UPDATE_REASONS, state.reason) ? <p>{DESKTOP_UPDATE_REASONS[state.reason]}</p> : notes[state.phase] && <p>{notes[state.phase]}</p>}
      <p>Signed app and CLI updates install when local work is idle and you quit normally. Accounts and settings are preserved. Updates that change authority require approval.</p>
      <button type="button" className={styles.refresh} onClick={() => { if (!refreshDesktopUpdates()) setError('Update status is unavailable.'); }}>Refresh status</button>
    </div>
  </details>;
}
