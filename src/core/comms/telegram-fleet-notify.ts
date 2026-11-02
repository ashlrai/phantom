import { sendTelegramMessage } from '../integrations/telegram.js';
import type { AshlrConfig } from '../types.js';
import { sanitizePushDetail } from '../web/remote-push-fleet.js';
import type { RemotePushDetail, RemotePushKind } from '../web/remote-push.js';

/** Send only bounded fleet summaries to the configured Telegram operator. */
export function createTelegramFleetNotifier(opts: {
  cfg: AshlrConfig;
  send?: typeof sendTelegramMessage;
  minGapMs?: number;
  now?: () => number;
}): (kind: RemotePushKind, detail?: RemotePushDetail) => Promise<void> {
  const send = opts.send ?? sendTelegramMessage;
  const now = opts.now ?? Date.now;
  const minGapMs = opts.minGapMs ?? 10 * 60_000;
  const lastSent = new Map<RemotePushKind, number>();

  return async (kind, detail) => {
    try {
      if (!opts.cfg.comms?.telegram?.chatId?.trim()
        || (kind !== 'fleet-lane-held' && kind !== 'fleet-merged')) return;
      const at = now();
      const previous = lastSent.get(kind);
      if (previous !== undefined && at - previous < minGapMs) return;
      const safeDetail = sanitizePushDetail(detail?.detail ?? '');
      let text: string;
      if (kind === 'fleet-merged') {
        const count = Number.isSafeInteger(detail?.count) && (detail?.count ?? 0) > 0 ? detail!.count! : 1;
        text = `Fleet: ${count} ${count === 1 ? 'merge' : 'merges'} in the last hour`;
      } else if (/^claude:\s*down\b/i.test(safeDetail)) {
        text = 'Fleet: Claude lane down — run ~/.ashlr-runs/bin/fix-claude-lane.sh';
      } else {
        const separator = safeDetail.indexOf(':');
        const lane = (separator < 0 ? safeDetail : safeDetail.slice(0, separator)).trim() || 'unknown';
        const reason = (separator < 0 ? '' : safeDetail.slice(separator + 1)).trim() || 'held';
        text = `Fleet: lane ${lane} held — ${reason}`;
      }
      // Record before sending so failures and concurrent calls count against the gap.
      lastSent.set(kind, at);
      await send(text, undefined, opts.cfg);
    } catch { /* Notifications must never interrupt the watcher. */ }
  };
}
