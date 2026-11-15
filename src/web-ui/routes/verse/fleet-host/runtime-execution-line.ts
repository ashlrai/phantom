export interface ExecutionLine {
  text: string;
  tone: 'ok' | 'warn' | 'unknown';
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0;

export function executionLine(snapshotBody: unknown, error?: unknown): ExecutionLine | undefined {
  if (error !== undefined && error !== null) return { text: 'Execution unknown: snapshot unavailable', tone: 'unknown' };
  if (!object(snapshotBody) || !object(snapshotBody.snapshot) || !('execution' in snapshotBody.snapshot)) return undefined;
  const execution = object(snapshotBody.snapshot.execution) ? snapshotBody.snapshot.execution : {};
  const { state, running, claimedNoWorker, unknown, reason } = execution;
  if (state !== 'known' || !count(running) || !count(claimedNoWorker) || !count(unknown)) {
    const safeReason = typeof reason === 'string' ? reason.slice(0, 120).replace(/[^A-Za-z0-9 :._-]/g, '') : '';
    return { text: `Execution unknown${safeReason ? `: ${safeReason}` : ''}`, tone: 'unknown' };
  }
  if (running === 0 && claimedNoWorker === 0 && unknown === 0) return { text: 'No claimed work running', tone: 'ok' };
  const text = `${running} running${claimedNoWorker > 0 ? `, ${claimedNoWorker} claimed with no worker` : ''}${unknown > 0 ? `, ${unknown} unknown` : ''}`;
  return { text, tone: claimedNoWorker > 0 || unknown > 0 ? 'warn' : 'ok' };
}
