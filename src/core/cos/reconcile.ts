/**
 * Mason's record of what he found after an uncertain chief-of-staff send.
 * Never sends anything: `delivered` marks the reply sent, `retry` frees the
 * claim so one more explicit, digest-bound approval can send it.
 */
import { appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  closeCosNeedsYou,
  cosDeliveryPath,
  cosDir,
  cosStatus,
  resolveCosRunsDir,
  writeCosDeliveryState,
} from './intake.js';

export type CosReconcileVerdict = 'delivered' | 'retry';
export interface CosReconcileOptions { runsDir?: string; now?: () => number; staleSendingMs?: number }
export interface CosReconcileResult { id: string; from: 'uncertain' | 'sending'; to: 'sent' | 'cleared' }

const STALE_SENDING_MS = 10 * 60 * 1000;

export async function reconcileCosDelivery(id: string, verdict: CosReconcileVerdict,
  opts: CosReconcileOptions = {}): Promise<CosReconcileResult> {
  const runsDir = resolveCosRunsDir(opts.runsDir);
  const now = opts.now ?? Date.now;
  const { delivery } = await cosStatus(id, runsDir); // validates the id and the job
  const path = cosDeliveryPath(id, runsDir);
  let from: 'uncertain' | 'sending';
  if (delivery === 'uncertain') from = 'uncertain';
  else if (delivery === 'sending') {
    const age = now() - (await stat(path)).mtimeMs;
    if (age <= (opts.staleSendingMs ?? STALE_SENDING_MS)) throw new Error('Delivery is still sending');
    from = 'sending';
  } else throw new Error(`Delivery is ${delivery ?? 'not started'}; nothing to reconcile`);

  const dir = cosDir(runsDir);
  if (verdict === 'delivered') {
    await writeCosDeliveryState(path, 'sent');
    closeCosNeedsYou(id, runsDir, 'cli');
  } else {
    await rename(path, join(dir, `${id}.delivery.${now()}.reconciled.json`));
  }
  await appendFile(join(dir, 'reconcile.jsonl'),
    `${JSON.stringify({ at: new Date(now()).toISOString(), id, from, verdict })}\n`, { mode: 0o600 });
  return { id, from, to: verdict === 'delivered' ? 'sent' : 'cleared' };
}
