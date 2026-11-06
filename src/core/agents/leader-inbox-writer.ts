/** Trusted host seam for the existing sole writer. Never a model tool or shell command. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LeaderInboxRequest { requestId: string; channel: 'slack'; ownerId: string; receivedAt: number; text: string }
export interface LeaderInboxReceipt { schema: 'mason-inbox-receipt.v1'; requestId: string; requestSha256: string; status: 'appended' | 'duplicate' }
export type LeaderInboxAppender = (request: LeaderInboxRequest) => Promise<unknown>;
export function leaderInboxRequestHash(request: LeaderInboxRequest): string {
  return createHash('sha256').update(JSON.stringify([request.requestId, request.receivedAt, request.text])).digest('hex');
}
export function validLeaderInboxReceipt(value: unknown, request: LeaderInboxRequest): value is LeaderInboxReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'requestId,requestSha256,schema,status' && row.schema === 'mason-inbox-receipt.v1' &&
    row.requestId === request.requestId && row.requestSha256 === leaderInboxRequestHash(request) && (row.status === 'appended' || row.status === 'duplicate');
}

/** Fixed argv, minimal environment, stdin-only text, bounded receipt, no stderr/body export.
 * A missing/uncertain helper response is NOT durability. Retrying the same ID asks
 * the sole writer to reconcile its own exact existing record before any append. */
export function approvedLeaderInboxAppender(authorize: (request: LeaderInboxRequest) => boolean, signal?: AbortSignal): LeaderInboxAppender {
  return async request => {
    if (signal?.aborted || request.channel !== 'slack' || !/^[a-f0-9]{64}$/.test(request.requestId) ||
        !Number.isSafeInteger(request.receivedAt) || request.receivedAt < 0 || request.receivedAt > 8640000000000000 ||
        !request.text || request.text.length > 6000 || Buffer.from(request.text).toString('utf8') !== request.text || !authorize(request)) {
      throw new Error('Leader inbox writer is unavailable');
    }
    const result = await new Promise<string>((resolve, reject) => {
      const child = execFile(join(homedir(), '.ashlr-runs', 'bin', 'mason-inbox-append'),
        ['--src', 'slack', '--id', request.requestId, '--received-at', String(request.receivedAt)],
        { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, encoding: 'utf8', timeout: 25000, maxBuffer: 1024, signal },
        (error, stdout) => error ? reject(new Error('Leader inbox outcome is unconfirmed')) : resolve(stdout));
      child.stdin?.on('error', () => { /* exec callback owns the bounded outcome. */ });
      child.stdin?.end(request.text);
    });
    if (signal?.aborted || !authorize(request)) throw new Error('Leader inbox outcome is unconfirmed');
    let receipt: unknown;
    try { receipt = JSON.parse(result); } catch { throw new Error('Leader inbox receipt is invalid'); }
    if (!validLeaderInboxReceipt(receipt, request)) throw new Error('Leader inbox receipt is invalid');
    return receipt;
  };
}
