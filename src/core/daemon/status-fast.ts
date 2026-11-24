/** Read only the last observed tick, without normal status probes. */
import { lstatSync } from 'node:fs';
import { daemonStatePath, loadDaemonStateStrict } from './state.js';

export interface FastDaemonStatus { lastTickAt: string | null }

export function readFastDaemonStatus(): FastDaemonStatus {
  const unknown: FastDaemonStatus = { lastTickAt: null };
  try {
    const info = lstatSync(daemonStatePath());
    if (!info.isFile() || info.size > 1024 * 1024) return unknown;
    // Always use the strict reader: a cache hit would bypass its custody checks.
    const result = loadDaemonStateStrict({ preserveOwnerIdentity: true });
    if (!result.ok) return unknown;
    const tick = result.state.lastTickAt;
    return { lastTickAt: tick && Number.isFinite(Date.parse(tick)) ? tick : null };
  } catch {
    return unknown;
  }
}
