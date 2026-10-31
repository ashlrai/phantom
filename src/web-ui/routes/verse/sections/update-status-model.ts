import { describeDesktopUpdateReason } from '../../../app/desktop-update-reasons.js';
import type { DesktopUpdateState } from '../../../app/desktop-updates.js';
import type { ServerObservation } from './update-status-queries.js';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export function describeUpdateStatus({ native, server, appVersion, desktopVersion, now, nativeBridge = native !== null }: {
  native: DesktopUpdateState | null; server: ServerObservation; appVersion: string;
  desktopVersion: string | null; now: number; nativeBridge?: boolean;
}): { headline: string; detail: string | null; tone: Tone; canRefresh: boolean } {
  const facts = server && !('kind' in server) ? server : null;
  const parts = [`Phantom ${appVersion}`];
  if (desktopVersion && desktopVersion !== appVersion) parts.push(`desktop ${desktopVersion}`);
  if (facts?.headSha) parts.push(facts.headSha.slice(0, 7));
  if (facts?.uptimeSeconds != null) parts.push(`up ${duration(facts.uptimeSeconds)}`);
  if (facts) parts.push(`fetched ${facts.lastFetchAt ? `${duration(Math.max(0, (now - Date.parse(facts.lastFetchAt)) / 1000))} ago` : 'never'}`);
  let headline = 'Update status unavailable';
  let tone: Tone = 'neutral';
  const version = native?.version ?? 'update';
  const readyVersion = native?.version ? ` ${native.version}` : '';
  switch (native?.phase) {
    case 'installing': headline = `Installing ${version}…`; tone = 'success'; break;
    case 'installed': headline = `Installed ${version}; restarts when idle`; tone = 'success'; break;
    case 'staged': case 'waiting-for-idle': case 'waiting-for-app-quit':
      headline = `Update${readyVersion} ready · installs when idle`; tone = 'info'; break;
    case 'adoption-held': headline = `Update held: ${describeDesktopUpdateReason(native.reason)}`; tone = 'warning'; break;
    case 'downloading': headline = `Downloading ${version}${native.bytesTotal ? ` · ${Math.floor(native.bytesReceived / native.bytesTotal * 100)}%` : ''}`; tone = 'info'; break;
    case 'failed': headline = `Update failed: ${describeDesktopUpdateReason(native.reason)}`; tone = 'danger'; break;
    case 'disabled': case 'uncommissioned': headline = 'Automatic updates off'; break;
    default:
      if (native?.phase === 'available' && native.version) { headline = `Update ${native.version} available · downloads when idle`; tone = 'info'; }
      else if (facts?.sourceState === 'unavailable') headline = 'Not running from a git checkout';
      else if (facts?.behind != null && facts.behind > 0 && facts.canFastForward) { headline = `${commits(facts.behind)} behind master · ready to fast-forward`; tone = 'info'; }
      else if (facts?.behind != null && facts.behind > 0 && facts.dirty) { headline = `${facts.behind} behind · local changes block the update`; tone = 'warning'; }
      else if (facts?.behind != null && facts.behind > 0) { headline = `${facts.behind} behind · fast-forward unavailable`; tone = 'warning'; }
      else if (facts?.behind === 0) { headline = 'Up to date with master'; tone = 'success'; }
      else if (server && 'kind' in server) headline = 'Update status is not in this build yet';
  }
  return { headline, detail: parts.join(' · '), tone, canRefresh: nativeBridge };
}

function commits(count: number): string { return `${count} commit${count === 1 ? '' : 's'}`; }

function duration(seconds: number): string {
  const n = Math.floor(seconds);
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m`;
  if (n < 86400) return `${Math.floor(n / 3600)}h`;
  return `${Math.floor(n / 86400)}d`;
}
