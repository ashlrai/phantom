import { significantNotice } from '../fleet/operator-glance.js';
import { writeSignificantEmail } from '../fleet/operator-glance-read.js';
import { sendTelegramMessage } from '../integrations/telegram.js';
import type { AshlrConfig } from '../types.js';
import { sanitizePushDetail } from '../web/remote-push-fleet.js';
import type { RemotePushDetail, RemotePushKind } from '../web/remote-push.js';

/** Tell Mason only when a release shipped or something needs a person. */
export function createTelegramFleetNotifier(opts: {
  cfg: AshlrConfig;
  send?: typeof sendTelegramMessage;
  minGapMs?: number;
  now?: () => number;
  runsDir?: string;
}): (kind: RemotePushKind, detail?: RemotePushDetail) => Promise<void> {
  const send = opts.send ?? sendTelegramMessage;
  const now = opts.now ?? Date.now;
  const minGapMs = opts.minGapMs ?? 10 * 60_000;
  const lastSent = new Map<RemotePushKind, number>();

  return async (kind, detail) => {
    try {
      if (!opts.cfg.comms?.telegram?.chatId?.trim()) return;
      const text = significantNotice(kind, sanitizePushDetail(detail?.detail ?? ''));
      if (!text) return;
      const at = now();
      const previous = lastSent.get(kind);
      if (previous !== undefined && at - previous < minGapMs) return;
      // Record before sending so failures and concurrent calls count against the gap.
      lastSent.set(kind, at);
      await writeSignificantEmail(text, opts.runsDir);
      await send(text, undefined, opts.cfg);
    } catch { /* Notifications must never interrupt the watcher. */ }
  };
}
