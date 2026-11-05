/** Why a resource has no usage reading, from row facts only. Never supplies a number. */
import type { CapacityRow } from '../usage/capacity-strip-model.js';

export interface MissingReadingReason {
  cause: string;
  /** The one action that clears it, or 'None needed'. */
  fix: string;
}

const TIMED_OUT = /^status-.*timed-out$/;

function claudeReadReason(code: NonNullable<CapacityRow['quotaReadReason']>): MissingReadingReason {
  if (TIMED_OUT.test(code)) return { cause: 'The usage check timed out.', fix: 'Check now' };
  if (code === 'usage-version-unsupported') return { cause: 'The usage reader is not available in this build of the CLI.', fix: 'Update the CLI' };
  if (code === 'usage-identity-unavailable' || code === 'usage-account-changed') return { cause: 'Phantom could not confirm which account the usage belongs to.', fix: 'Reconnect this account' };
  if (code === 'connection-monitor-stopped' || code === 'connection-reading-expired') return { cause: 'The last usage reading expired.', fix: 'Check now' };
  return { cause: 'The provider did not report usage windows Phantom could verify.', fix: 'Check now' };
}

export function missingReadingReason(row: CapacityRow, nowMs: number): MissingReadingReason {
  if (row.signedOut || row.connection?.connection === 'signed-out') return { cause: 'This account is signed out.', fix: 'Reconnect this account' };
  if (row.quotaReadReason) return claudeReadReason(row.quotaReadReason);
  if (row.engine === 'local' || row.engine === 'devin') return { cause: 'This provider does not report plan usage to Phantom.', fix: 'None needed' };
  const checked = row.checkedAt === null ? Number.NaN : Date.parse(row.checkedAt);
  if (!Number.isFinite(checked) || !Number.isFinite(nowMs) || checked > nowMs) return { cause: 'No usage check has run on this computer yet.', fix: 'Check now' };
  const failure = row.connection !== null && row.connection.connection !== 'connected' ? row.connection.reasons?.[0] : undefined;
  if (failure) return { cause: /[.!?]$/.test(failure) ? failure : `${failure}.`, fix: 'Check now' };
  if (row.engine === 'codex' && (row.creditState === undefined || row.creditState === 'unknown')) {
    return { cause: 'Credits are only read when the account is signed in on this computer.', fix: 'Check now' };
  }
  return { cause: 'The provider did not report a usable reading.', fix: 'Check now' };
}
