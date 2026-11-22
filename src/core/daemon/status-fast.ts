/** Dispatcher observation only: no liveness probes, inbox, network or git. */
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { daemonStatePath, daemonStateRecoveryMarkerPath, loadDaemonStateStrict } from './state.js';

export interface FastDaemonStatus { lastTickAt: string | null }
export function readFastDaemonStatus(): FastDaemonStatus {
  const unknown: FastDaemonStatus = { lastTickAt: null };
  const path = daemonStatePath(), cache = path + '.tick-cache.json';
  try {
    // Recovery must invalidate even an otherwise unchanged cached observation.
    try { lstatSync(daemonStateRecoveryMarkerPath()); return unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unknown; }
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 1024 * 1024) return unknown;
    const key = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    try {
      const saved = lstatSync(cache);
      if (saved.isFile() && saved.size < 1024) {
        const value = JSON.parse(readFileSync(cache, 'utf8'));
        if (value.key === key && (value.lastTickAt === null ||
          typeof value.lastTickAt === 'string' && Number.isFinite(Date.parse(value.lastTickAt)))) return { lastTickAt: value.lastTickAt };
      }
    } catch { /* missing or invalid cache: validate the source */ }
    const result = loadDaemonStateStrict({ preserveOwnerIdentity: true });
    if (!result.ok) return unknown;
    const lastTickAt = result.state.lastTickAt;
    const status = { lastTickAt: lastTickAt && Number.isFinite(Date.parse(lastTickAt)) ? lastTickAt : null };
    // Cache failures never change the observation. Atomic, private, exclusive temp file.
    try {
      const temp = cache + '.' + randomUUID();
      writeFileSync(temp, JSON.stringify({ key, ...status }), { mode: 0o600, flag: 'wx' });
      try { renameSync(temp, cache); } finally { try { unlinkSync(temp); } catch { /* renamed */ } }
    } catch { /* read-only state directory */ }
    return status;
  } catch { return unknown; }
}
