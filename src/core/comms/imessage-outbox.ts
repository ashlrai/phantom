/** iMessage outbox: owner and locally registered agents send directly. */
import { join } from 'node:path';
import { realHome } from '../util/real-home.js';
import { outsideSendBlock } from './transport-gate.js';
import { commsEnabled, isSelfIMessageHandle, sendIMessage } from '../integrations/imessage.js';
import { readPrivateFileCapped } from '../verse/preferences.js';
import type { AshlrConfig } from '../types.js';

/** A registry grants send authority; oversized reads fail closed. */
const TEAMMATES_MAX_BYTES = 64 * 1024;

/** Local registration grants agent delivery only; malformed/unavailable data fails closed. */
async function isAgentTeammate(to: string): Promise<boolean> {
  const handle = to.trim().toLowerCase();
  if (!handle) return false;
  try {
    // The registry confers send authority, so it gets the same verified read as
    // every other authority file: no symlinks, regular file only, bounded size.
    const read = readPrivateFileCapped(join(realHome(), '.phantom', 'agents', 'teammates.json'), TEAMMATES_MAX_BYTES);
    if (!read || read.truncated) return false;
    const entries: unknown = JSON.parse(read.text);
    return Array.isArray(entries) && entries.some((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const row = entry as Record<string, unknown>;
      return row.kind === 'agent' && typeof row.handle === 'string'
        && row.handle.trim().toLowerCase() === handle;
    });
  } catch {
    return false;
  }
}

export async function sendIMessageOutbox(text: string, cfg: AshlrConfig, to: string): Promise<{
  ok: boolean;
  reason?: 'not_self' | 'drafts_unavailable' | 'blocked';
}> {
  if (outsideSendBlock() !== null) return { ok: false, reason: 'blocked' };
  if (isSelfIMessageHandle(to, cfg)) return sendIMessage(text, cfg, to);
  if (!await isAgentTeammate(to)) return { ok: false, reason: 'drafts_unavailable' };
  if (!commsEnabled(cfg)) return { ok: false };
  // Scope the existing guarded transport to this authorized destination without mutating config.
  return sendIMessage(text, { ...cfg, comms: { ...cfg.comms, imessageHandle: to.trim() } }, to);
}
