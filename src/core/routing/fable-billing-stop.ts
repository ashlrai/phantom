/** Durable stop: reset boundaries and successful calls never clear this file.
 * Re-enablement is an explicit human operation outside model execution. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { routingDir } from './budget-store.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import { fableBillingReason, type FableBillingReason } from './fable-orchestrator.js';
let failedToPersist = false;
export function fableBillingStopped(root = routingDir()): boolean {
  try { return failedToPersist || existsSync(join(root, 'fable-billing-stop.json')); }
  catch { return true; }
}
export function observeFableBilling(response: unknown, root = routingDir()): FableBillingReason | null {
  const reason = fableBillingReason(response);
  if (!reason) return null;
  failedToPersist = true;
  ensurePrivateDirectory(root);
  writePrivateFileAtomic(join(root, 'fable-billing-stop.json'), `${JSON.stringify({ schemaVersion: 1, reason })}\n`);
  return reason;
}

/** Every normalized event may carry a protocol line, including usage events. */
export function observeFableBillingLine(line: string, root = routingDir()): FableBillingReason | null {
  let frame: unknown;
  try { frame = JSON.parse(line); } catch { return null; }
  return observeFableBilling(frame, root);
}
