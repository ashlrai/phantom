/**
 * Mason's record of what he found after an uncertain chief-of-staff send.
 * Never sends anything: `delivered` marks the reply sent, `retry` frees the
 * claim so one more explicit, digest-bound approval can send it.
 */
import { appendFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readNeedsMason, resolveNeedsMason } from '../fleet/needs-mason-resolve.js';
import { cosApprovalTexts, cosStatus } from './intake.js';

export type CosReconcileVerdict = 'delivered' | 'retry';
export interface CosReconcileOptions { runsDir?: string; now?: () => number; staleSendingMs?: number }
export interface CosReconcileResult { id: string; from: 'uncertain' | 'sending'; to: 'sent' | 'cleared' }

const STALE_SENDING_MS = 10 * 60 * 1000;

export async function reconcileCosDelivery(id: string, verdict: CosReconcileVerdict,
  opts: CosReconcileOptions = {}): Promise<CosReconcileResult> {
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = opts.now ?? Date.now;
  const { delivery } = await cosStatus(id, runsDir); // validates the id and the job
  const path = join(runsDir, 'cos', `${id}.delivery.json`);
  let from: 'uncertain' | 'sending';
  if (delivery === 'uncertain') from = 'uncertain';
  else if (delivery === 'sending') {
    const age = now() - (await stat(path)).mtimeMs;
    if (age <= (opts.staleSendingMs ?? STALE_SENDING_MS)) throw new Error('Delivery is still sending');
    from = 'sending';
  } else throw new Error(`Delivery is ${delivery ?? 'not started'}; nothing to reconcile`);

  if (verdict === 'delivered') {
    await writeFile(path, JSON.stringify({ state: 'sent' }), { mode: 0o600 });
    try {
      const item = readNeedsMason({ runsDir }).items.find(item => cosApprovalTexts(id).some(text => item.text === text));
      if (item) resolveNeedsMason({ itemId: item.id }, { runsDir, source: 'cli' });
    } catch { /* Delivery is already recorded; needs-you cleanup must never change it. */ }
  } else {
    await rename(path, join(runsDir, 'cos', `${id}.delivery.${now()}.reconciled.json`));
  }
  await appendFile(join(runsDir, 'cos', 'reconcile.jsonl'),
    `${JSON.stringify({ at: new Date(now()).toISOString(), id, from, verdict })}\n`, { mode: 0o600 });
  return { id, from, to: verdict === 'delivered' ? 'sent' : 'cleared' };
}
