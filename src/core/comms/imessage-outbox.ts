/** iMessage outbox: owner and locally registered agents send directly. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commsEnabled, isSelfIMessageHandle, sendIMessage } from '../integrations/imessage.js';
import type { AshlrConfig } from '../types.js';

/** Local registration grants agent delivery only; malformed/unavailable data fails closed. */
async function isAgentTeammate(to: string): Promise<boolean> {
  const handle = to.trim().toLowerCase();
  if (!handle) return false;
  try {
    const entries: unknown = JSON.parse(await readFile(join(homedir(), '.phantom', 'agents', 'teammates.json'), 'utf8'));
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
  reason?: 'not_self' | 'drafts_unavailable';
}> {
  if (isSelfIMessageHandle(to, cfg)) return sendIMessage(text, cfg, to);
  if (!await isAgentTeammate(to)) return { ok: false, reason: 'drafts_unavailable' };
  if (!commsEnabled(cfg)) return { ok: false };
  // Scope the existing guarded transport to this authorized destination without mutating config.
  return sendIMessage(text, { ...cfg, comms: { ...cfg.comms, imessageHandle: to.trim() } }, to);
}
