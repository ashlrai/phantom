import { randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface GithubWebhookEvent {
  v: 1;
  deliveryId: string;
  event: 'check_run' | 'pull_request';
  receivedAt: string;
  payload: Record<string, unknown>;
}

/** One immutable event per delivery. The event itself is the replay receipt.
 * Use a private, trusted directory on a local filesystem; retain records for
 * as long as replay protection is required. No separate dedupe state can drift.
 */
export async function storeGithubWebhook(directory: string, event: GithubWebhookEvent): Promise<boolean> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(event.deliveryId)) throw new Error('Invalid delivery id');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.pending-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(event) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    // Hard-link publishes complete bytes atomically and refuses an existing id,
    // including across processes. Never expire receipts automatically.
    try {
      await link(temporary, join(directory, `${event.deliveryId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    return true;
  } finally {
    await unlink(temporary);
  }
}
